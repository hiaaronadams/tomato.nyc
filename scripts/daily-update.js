#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { parse } from 'csv-parse/sync';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

// Data source URLs
const MENU_DATA_ARCHIVE_URL = 'https://s3.amazonaws.com/menusdata.nypl.org/gzips/2021_08_01_07_01_17_data.tgz';
const NYPL_DIGITAL_API = 'https://api.repo.nypl.org/api/v2/items/search';
const NYTIMES_ARCHIVE_API = 'https://api.nytimes.com/svc/archive/v1';
const NYTIMES_ARTICLE_API = 'https://api.nytimes.com/svc/search/v2/articlesearch.json';
const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';
const LOC_API = 'https://www.loc.gov/collections/chronicling-america/';
const WEATHER_API = 'https://api.weather.gov/gridpoints/OKX/33,37/forecast';

// API Keys (set via environment variables)
const NYTIMES_API_KEY = process.env.NYTIMES_API_KEY || '';

// Data source types for rotation
const DATA_SOURCES = {
  NYPL_MENUS: 'nypl_menus',
  NYPL_DIGITAL: 'nypl_digital',
  NYC_ARCHIVES: 'nyc_archives',
  QUEENS_MEMORY: 'queens_memory',
  BROOKLYN_PUBLIC: 'brooklyn_public'
};

/**
 * Ensure directory exists
 */
async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Download and extract the NYPL menu data archive
 */
async function downloadAndExtractMenuData() {
  const archivePath = path.join(CACHE_DIR, 'menu-data.tgz');
  const extractedMarker = path.join(CACHE_DIR, '.extracted');

  // Check if already extracted and less than 30 days old
  try {
    const stats = await fs.stat(extractedMarker);
    const age = Date.now() - stats.mtimeMs;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    if (age < thirtyDays) {
      console.log('✓ Using cached menu data');
      return true;
    }
  } catch (err) {
    // Not extracted yet
  }

  console.log('⬇ Downloading NYPL menu data archive...');

  try {
    const response = await fetch(MENU_DATA_ARCHIVE_URL);

    if (!response.ok) {
      console.warn(`⚠️  Failed to download menu data: ${response.statusText}`);
      return false;
    }

    // Save archive
    const buffer = await response.arrayBuffer();
    await fs.writeFile(archivePath, Buffer.from(buffer));
    console.log('✓ Downloaded archive');

    // Extract archive
    console.log('📦 Extracting archive...');
    await execAsync(`tar -xzf "${archivePath}" -C "${CACHE_DIR}"`);
    await fs.writeFile(extractedMarker, new Date().toISOString());
    console.log('✓ Extracted CSV files');
    return true;
  } catch (err) {
    console.warn(`⚠️  Failed to download/extract archive: ${err.message}`);
    return false;
  }
}

/**
 * Load and parse CSV file
 */
async function loadCSV(filepath) {
  const content = await fs.readFile(filepath, 'utf-8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true
  });
}

/**
 * Query NYPL Digital Collections API for tomato-related items
 * Searches broadly for tomato content without strict date matching
 */
async function queryNYPLDigitalCollections(date) {
  try {
    // Search for tomato-related items (no date restriction for more results)
    const query = 'tomato OR tomatoes vegetables garden market produce';
    const url = `${NYPL_DIGITAL_API}?q=${encodeURIComponent(query)}&per_page=50&publicDomainOnly=true`;

    console.log(`  Querying: ${url.substring(0, 100)}...`);

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.warn(`NYPL Digital API failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const items = [];

    if (data.nyplAPI?.response?.result) {
      for (const item of data.nyplAPI.response.result) {
        // Extract image URL
        let imageUrl = null;
        if (item.imageID && item.imageID.length > 0) {
          imageUrl = `https://images.nypl.org/index.php?id=${item.imageID[0]}&t=w`;
        }

        // Extract year from date field
        let year = null;
        if (item.dateDigitized) {
          year = new Date(item.dateDigitized).getFullYear();
        } else if (item.date) {
          // Try to parse year from date string
          const yearMatch = item.date.match(/\d{4}/);
          if (yearMatch) year = parseInt(yearMatch[0]);
        }

        // Get description
        let description = '';
        if (item.description) {
          description = item.description.substring(0, 200);
        } else if (item.note) {
          description = item.note.substring(0, 200);
        }

        // Construct item URL
        let itemUrl = null;
        if (item.uuid) {
          itemUrl = `https://digitalcollections.nypl.org/items/${item.uuid}`;
        }

        items.push({
          title: item.title || 'Untitled',
          imageUrl,
          year,
          description,
          source: 'NYPL Digital Collections',
          type: 'archive',
          uuid: item.uuid,
          url: itemUrl
        });

        // Limit to 10 items
        if (items.length >= 10) break;
      }
    }

    return items;
  } catch (err) {
    console.warn(`NYPL Digital API error: ${err.message}`);
    return [];
  }
}

/**
 * Query NYC Digital Collections (data.cityofnewyork.us)
 */
async function queryNYCArchives(date) {
  try {
    // NYC Open Data - Photos and documents
    const query = 'tomato OR tomatoes';
    const url = `https://data.cityofnewyork.us/api/views/metadata/v1?q=${encodeURIComponent(query)}&limit=20`;

    console.log(`  Querying NYC Archives...`);

    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`NYC Archives API failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const items = [];

    // This is a simple implementation - NYC doesn't have a great public API for historical photos
    // In production, you might want to use their specific dataset APIs

    return items;
  } catch (err) {
    console.warn(`NYC Archives error: ${err.message}`);
    return [];
  }
}

/**
 * Query NYTimes Archive API for NYC tomato-related articles
 */
async function queryNYTimesArchive(date) {
  if (!NYTIMES_API_KEY) {
    console.warn('  NYTimes API key not set, skipping...');
    return [];
  }

  try {
    // Search for articles about tomatoes in NYC
    const query = 'tomato OR tomatoes AND (New York OR NYC OR Manhattan OR Brooklyn OR Queens OR Bronx)';
    const url = `${NYTIMES_ARTICLE_API}?q=${encodeURIComponent(query)}&fq=glocations:("NEW YORK CITY")&sort=oldest&api-key=${NYTIMES_API_KEY}`;

    console.log(`  Querying NYTimes Archive...`);

    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`NYTimes API failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const items = [];

    if (data.response?.docs) {
      for (const doc of data.response.docs) {
        // Make sure it's actually about tomatoes AND NYC
        const headline = (doc.headline?.main || '').toLowerCase();
        const snippet = (doc.snippet || '').toLowerCase();
        const abstract = (doc.abstract || '').toLowerCase();

        const hasTomato = headline.includes('tomato') || snippet.includes('tomato') || abstract.includes('tomato');
        const hasNYC = headline.includes('new york') || headline.includes('nyc') ||
                       snippet.includes('new york') || snippet.includes('nyc') ||
                       abstract.includes('new york') || abstract.includes('nyc');

        if (!hasTomato || !hasNYC) continue;

        // Extract image URL if available
        let imageUrl = null;
        if (doc.multimedia && doc.multimedia.length > 0) {
          const image = doc.multimedia[0];
          imageUrl = `https://www.nytimes.com/${image.url}`;
        }

        // Extract year from pub_date
        let year = null;
        if (doc.pub_date) {
          year = new Date(doc.pub_date).getFullYear();
        }

        items.push({
          title: doc.headline?.main || 'Untitled',
          description: doc.snippet || doc.abstract || '',
          year,
          imageUrl,
          source: 'The New York Times Archive',
          type: 'article',
          url: doc.web_url
        });

        // Limit to 10 items
        if (items.length >= 10) break;
      }
    }

    return items;
  } catch (err) {
    console.warn(`NYTimes Archive error: ${err.message}`);
    return [];
  }
}

/**
 * Query Wikimedia Commons for tomato-related NYC images
 */
async function queryWikimediaCommons(date) {
  try {
    const searchTerms = [
      'tomato New York City',
      'tomatoes Manhattan market',
      'NYC produce vendor',
      'New York vegetable market'
    ];

    const searchTerm = searchTerms[Math.floor(Math.random() * searchTerms.length)];

    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: searchTerm,
      gsrlimit: '20',
      prop: 'imageinfo|info',
      iiprop: 'url|extmetadata',
      iiurlwidth: '800',
      inprop: 'url'
    });

    const url = `${WIKIMEDIA_API}?${params.toString()}`;
    console.log(`  Querying Wikimedia Commons...`);

    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`Wikimedia API failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const items = [];

    if (data.query?.pages) {
      for (const pageId in data.query.pages) {
        const page = data.query.pages[pageId];

        if (!page.imageinfo || !page.imageinfo[0]) continue;

        const imageInfo = page.imageinfo[0];
        const metadata = imageInfo.extmetadata || {};

        // Extract description and check relevance
        const description = metadata.ImageDescription?.value || metadata.ObjectName?.value || page.title || '';
        const descLower = description.toLowerCase();

        // MUST mention BOTH tomato AND NYC/New York - strict filtering
        const hasTomato = descLower.includes('tomato');
        const hasNYC = descLower.includes('new york') || descLower.includes('nyc') ||
                       descLower.includes('manhattan') || descLower.includes('brooklyn') ||
                       descLower.includes('queens') || descLower.includes('bronx');

        if (!hasTomato || !hasNYC) continue;

        // Extract year from date
        let year = null;
        const dateStr = metadata.DateTimeOriginal?.value || metadata.DateTime?.value || '';
        const yearMatch = dateStr.match(/\d{4}/);
        if (yearMatch) {
          year = parseInt(yearMatch[0]);
        }

        items.push({
          title: page.title.replace(/^File:/, '').replace(/\.\w+$/, '').replace(/_/g, ' '),
          description: description.replace(/<[^>]*>/g, '').substring(0, 200),
          year,
          imageUrl: imageInfo.thumburl || imageInfo.url,
          source: 'Wikimedia Commons',
          type: 'image',
          url: page.fullurl
        });

        if (items.length >= 5) break;
      }
    }

    return items;
  } catch (err) {
    console.warn(`Wikimedia Commons error: ${err.message}`);
    return [];
  }
}

/**
 * Query Library of Congress Chronicling America for tomato-related NYC articles
 */
async function queryLibraryOfCongress(date) {
  try {
    // Search historic newspapers for tomato mentions in NYC papers
    const params = new URLSearchParams({
      proxtext: 'tomato',
      state: 'New York',
      format: 'json',
      page: '1'
    });

    const url = `https://chroniclingamerica.loc.gov/search/pages/results/?${params.toString()}`;
    console.log(`  Querying Library of Congress...`);

    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`LOC API failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const items = [];

    if (data.items) {
      for (const item of data.items) {
        // Extract year
        let year = null;
        if (item.date) {
          const dateMatch = item.date.match(/(\d{4})/);
          if (dateMatch) year = parseInt(dateMatch[1]);
        }

        // Get newspaper title and location
        const newspaper = item.title || 'Unknown newspaper';
        const city = item.city?.[0] || '';

        // Create description from OCR text snippet
        let description = item.ocr_eng || '';
        description = description.substring(0, 200);

        items.push({
          title: `${newspaper} - ${item.date || 'Unknown date'}`,
          description,
          year,
          imageUrl: null,
          source: 'Library of Congress',
          type: 'newspaper',
          url: item.id ? `https://chroniclingamerica.loc.gov${item.id}` : null
        });

        if (items.length >= 5) break;
      }
    }

    return items;
  } catch (err) {
    console.warn(`Library of Congress error: ${err.message}`);
    return [];
  }
}

/**
 * Get NYC weather from NOAA API
 */
async function getNYCWeather() {
  try {
    const response = await fetch(WEATHER_API, {
      headers: {
        'User-Agent': '(tomato.nyc, contact@tomato.nyc)'
      }
    });

    if (!response.ok) {
      console.warn('Weather API failed, using fallback');
      return { temp: '??', condition: 'Unknown', icon: '☁️' };
    }

    const data = await response.json();
    const current = data.properties.periods[0];

    return {
      temp: current.temperature,
      unit: current.temperatureUnit,
      condition: current.shortForecast,
      icon: getWeatherIcon(current.shortForecast)
    };
  } catch (err) {
    console.error('Weather error:', err.message);
    return { temp: '??', condition: 'Unknown', icon: '☁️' };
  }
}

/**
 * Simple weather icon mapping
 */
function getWeatherIcon(forecast) {
  const lower = forecast.toLowerCase();
  if (lower.includes('sunny') || lower.includes('clear')) return '☀️';
  if (lower.includes('cloud')) return '☁️';
  if (lower.includes('rain')) return '🌧️';
  if (lower.includes('snow')) return '❄️';
  if (lower.includes('thunder')) return '⛈️';
  if (lower.includes('fog')) return '🌫️';
  return '🌤️';
}

/**
 * Find tomato-related menu items for a specific date
 */
async function findTomatoItemsForDate(date) {
  const month = date.getMonth() + 1; // 1-12
  const day = date.getDate();

  console.log(`🔍 Searching for tomato items from ${month}/${day} (any year)...`);

  // Download and extract menu data
  const downloadSuccess = await downloadAndExtractMenuData();

  if (!downloadSuccess) {
    console.log('⚠️  Download failed, falling back to sample data...');
    return getSampleData(date);
  }

  // Load data files from cache
  const dishesPath = path.join(CACHE_DIR, 'Dish.csv');
  const menusPath = path.join(CACHE_DIR, 'Menu.csv');
  const menuItemsPath = path.join(CACHE_DIR, 'MenuItem.csv');

  // Verify files exist
  try {
    await fs.access(dishesPath);
    await fs.access(menusPath);
    await fs.access(menuItemsPath);
  } catch (err) {
    console.log('⚠️  CSV files not found, falling back to sample data...');
    return getSampleData(date);
  }

  const dishes = await loadCSV(dishesPath);
  const menus = await loadCSV(menusPath);
  const menuItems = await loadCSV(menuItemsPath);

  // Create lookup maps
  const dishMap = new Map(dishes.map(d => [d.id, d]));
  const menuMap = new Map(menus.map(m => [m.id, m]));

  // Find menu items with tomato
  const tomatoItems = [];

  for (const item of menuItems) {
    const dish = dishMap.get(item.dish_id);
    const menu = menuMap.get(item.menu_id);

    if (!dish || !menu) continue;

    // Check if dish contains "tomato"
    const dishName = (dish.name || '').toLowerCase();
    if (!dishName.includes('tomato')) continue;

    // Parse menu date
    const menuDate = menu.date;
    if (!menuDate) continue;

    const parsedDate = new Date(menuDate);
    if (isNaN(parsedDate.getTime())) continue;

    const menuMonth = parsedDate.getMonth() + 1;
    const menuDay = parsedDate.getDate();

    // Check if date matches (ignoring year)
    if (menuMonth === month && menuDay === day) {
      tomatoItems.push({
        dishName: dish.name,
        price: item.price || 'Price unknown',
        menuDate: menuDate,
        year: parsedDate.getFullYear(),
        venue: menu.venue || 'Unknown venue',
        location: menu.location || 'New York',
        menuId: menu.id
      });
    }
  }

  console.log(`✓ Found ${tomatoItems.length} tomato menu items`);

  // Normalize to standard format
  return tomatoItems.map(item => ({
    title: item.dishName,
    description: `${item.price} • ${item.venue}${item.location !== 'New York' ? ` • ${item.location}` : ''}`,
    year: item.year,
    imageUrl: null,
    source: 'NYPL What\'s on the Menu',
    type: 'menu'
  }));
}

/**
 * Gather items from all data sources
 */
async function gatherAllItems(date) {
  const allItems = [];

  // Try each source
  console.log('\n📚 Querying archival sources...');

  // 1. NYPL Digital Collections (photos, documents, artifacts)
  try {
    console.log('🖼️  Searching NYPL Digital Collections...');
    const digitalItems = await queryNYPLDigitalCollections(date);
    console.log(`✓ Found ${digitalItems.length} digital archive items`);
    allItems.push(...digitalItems);
  } catch (err) {
    console.warn('Digital collections search failed:', err.message);
  }

  // 2. NYC Archives
  try {
    console.log('🏛️  Searching NYC Archives...');
    const nycItems = await queryNYCArchives(date);
    console.log(`✓ Found ${nycItems.length} NYC archive items`);
    allItems.push(...nycItems);
  } catch (err) {
    console.warn('NYC Archives search failed:', err.message);
  }

  // 3. NYTimes Archive
  try {
    console.log('📰 Searching NYTimes Archive...');
    const nytimesItems = await queryNYTimesArchive(date);
    console.log(`✓ Found ${nytimesItems.length} NYTimes archive items`);
    allItems.push(...nytimesItems);
  } catch (err) {
    console.warn('NYTimes Archive search failed:', err.message);
  }

  // 4. Wikimedia Commons
  try {
    console.log('🖼️  Searching Wikimedia Commons...');
    const wikimediaItems = await queryWikimediaCommons(date);
    console.log(`✓ Found ${wikimediaItems.length} Wikimedia items`);
    allItems.push(...wikimediaItems);
  } catch (err) {
    console.warn('Wikimedia Commons search failed:', err.message);
  }

  // 5. Library of Congress
  try {
    console.log('📜 Searching Library of Congress...');
    const locItems = await queryLibraryOfCongress(date);
    console.log(`✓ Found ${locItems.length} LOC items`);
    allItems.push(...locItems);
  } catch (err) {
    console.warn('Library of Congress search failed:', err.message);
  }

  // If no archival items found, use sample archive data
  if (allItems.length === 0) {
    console.log('⚠️  No archival items found, using sample data...');
    return getSampleArchiveData(date);
  }

  // Shuffle to rotate sources fairly
  return allItems.sort(() => Math.random() - 0.5);
}

/**
 * Generate the HTML page
 */
async function generateHTML(date, weather, items) {
  const dateStr = date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // Sort items by year (oldest first)
  items.sort((a, b) => (a.year || 0) - (b.year || 0));

  // Generate grid items HTML
  const itemsHTML = items.length > 0
    ? items.map((item, index) => {
        const hasImage = item.imageUrl;

        const headline = item.url
          ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`
          : escapeHtml(item.title);

        return `
      <div class="snippet">
        ${hasImage ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" class="snippet-image">` : ''}
        <div class="snippet-content">
          <h3>${headline}</h3>
          <p class="snippet-source">${escapeHtml(item.source)}</p>
          <p class="snippet-meta">${item.year || 'Date unknown'}</p>
          <p class="snippet-desc">${escapeHtml(item.description || '')}</p>
        </div>
      </div>`;
      }).join('\n')
    : '<p class="no-items">No tomato items found for this day in history. Check back tomorrow! 🍅</p>';

  // Collect unique sources
  const sources = [...new Set(items.map(item => item.source))];
  const sourcesHTML = sources.map(s => `<p class="source-line">${escapeHtml(s)}</p>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="The Tomato Times - NYC tomato history for ${dateStr}">
    <meta name="keywords" content="tomato, nyc, new york, history">
    <meta name="author" content="tomato.nyc">

    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://tomato.nyc/">
    <meta property="og:title" content="The Tomato Times - ${dateStr}">
    <meta property="og:description" content="On This Day in NYC Tomato History">
    <meta property="og:image" content="https://tomato.nyc/og-image.png">

    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="https://tomato.nyc/">
    <meta property="twitter:title" content="The Tomato Times - ${dateStr}">
    <meta property="twitter:description" content="On This Day in NYC Tomato History">
    <meta property="twitter:image" content="https://tomato.nyc/og-image.png">

    <!-- Favicon -->
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍅</text></svg>">

    <title>The Tomato Times</title>

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">

    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Libre Baskerville', 'Times New Roman', Times, serif;
            background-color: #F8E6D2;
            color: #FF223C;
            line-height: 1.4;
            padding: 0;
            margin: 0;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 40px 60px;
        }

        header {
            border-top: 2px solid #FF223C;
            border-bottom: 2px solid #FF223C;
            padding: 30px 0;
            margin-bottom: 40px;
        }

        .header-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
            font-size: 14px;
        }

        .header-top .location {
            text-align: center;
        }

        .masthead {
            text-align: center;
            margin: 20px 0;
        }

        .masthead-logo {
            max-width: 650px;
            width: 100%;
            height: auto;
            display: inline-block;
        }

        .tagline {
            text-align: center;
            font-style: italic;
            font-size: 16px;
            margin-top: 10px;
        }

        /* Masonry layout */
        .masonry {
            column-count: 1;
            column-gap: 30px;
        }

        @media (min-width: 768px) {
            .masonry {
                column-count: 3;
            }
        }

        @media (min-width: 1200px) {
            .masonry {
                column-count: 4;
            }
        }

        /* Snippets */
        .snippet {
            break-inside: avoid;
            margin-bottom: 30px;
            display: inline-block;
            width: 100%;
        }

        .snippet-image {
            width: 100%;
            height: auto;
            display: block;
            margin-bottom: 15px;
        }

        .snippet-content h3 {
            font-size: 24px;
            margin-bottom: 8px;
            font-weight: 700;
            line-height: 1.3;
        }

        .snippet-content h3 a {
            color: #FF223C;
            text-decoration: none;
            border-bottom: 1px solid rgba(255, 34, 60, 0.3);
            transition: border-color 0.2s;
        }

        .snippet-content h3 a:hover {
            border-bottom-color: #FF223C;
        }

        .snippet-source {
            font-size: 12px;
            font-style: italic;
            margin-bottom: 8px;
            opacity: 0.85;
        }

        .snippet-meta {
            font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
            font-size: 12px;
            margin-bottom: 8px;
            opacity: 0.9;
        }

        .snippet-desc {
            font-size: 14px;
            line-height: 1.5;
            opacity: 0.95;
        }

        .no-items {
            text-align: center;
            padding: 60px 20px;
            font-size: 18px;
        }

        footer {
            margin-top: 80px;
            padding-top: 30px;
            border-top: 2px solid #FF223C;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
            font-size: 12px;
        }

        .footer-left {
            flex: 1;
        }

        .footer-right {
            text-align: right;
        }

        .source-line {
            margin: 5px 0;
        }

        @media (max-width: 768px) {
            .container {
                padding: 30px 20px;
            }

            .masthead h1 {
                font-size: 3rem;
            }

            .header-top {
                flex-direction: column;
                gap: 10px;
                text-align: center;
            }

            footer {
                flex-direction: column;
                gap: 20px;
            }

            .footer-right {
                text-align: left;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="header-top">
                <div class="date">${dateStr}</div>
                <div class="location">New York City</div>
                <div class="weather">${weather.icon} ${weather.temp}°${weather.unit || 'F'} ${weather.condition}</div>
            </div>
            <div class="masthead">
                <img src="https://tomatolab.org/wp-content/uploads/2025/12/masthead.png" alt="The Tomato Times" class="masthead-logo">
            </div>
            <div class="tagline">On This Day in NYC Tomato History</div>
        </header>

        <main>
            <div class="masonry">
                ${itemsHTML}
            </div>
        </main>

        <footer>
            <div class="footer-left">
                ${sourcesHTML || '<p class="source-line">No sources available</p>'}
            </div>
            <div class="footer-right">
                <p>A production of Tomato Laboratories</p>
            </div>
        </footer>
    </div>
</body>
</html>`;

  return html;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

/**
 * Generate sample archival data for testing/fallback
 */
function getSampleArchiveData(date) {
  // Sample archival items for demo/testing
  // In production, real API data will have working URLs and images
  const samples = [
    {
      title: 'Washington Market Tomato Vendors',
      description: 'Photograph showing vendors selling fresh tomatoes at Washington Market, lower Manhattan',
      year: 1912,
      imageUrl: null,
      source: 'NYPL Digital Collections',
      type: 'archive',
      url: null
    },
    {
      title: 'Tomato Blight Threatens NYC Supply',
      description: 'New York farmers report widespread tomato blight affecting crops shipped to city markets',
      year: 1925,
      imageUrl: null,
      source: 'The New York Times Archive',
      type: 'article',
      url: null
    },
    {
      title: 'Essex Street Market Produce Stand',
      description: 'Tomatoes displayed at a produce stand on the Lower East Side',
      year: 1938,
      imageUrl: null,
      source: 'NYPL Digital Collections',
      type: 'archive',
      url: null
    },
    {
      title: 'Victory Garden Competition Winners',
      description: 'Brooklyn residents display prize-winning tomatoes from rooftop victory gardens',
      year: 1943,
      imageUrl: null,
      source: 'Brooklyn Public Library Digital Collections',
      type: 'archive',
      url: null
    },
    {
      title: 'Fulton Market Produce Display',
      description: 'Crates of tomatoes at Fulton Fish Market, also known for produce sales',
      year: 1956,
      imageUrl: null,
      source: 'NYPL Digital Collections',
      type: 'archive',
      url: null
    },
    {
      title: 'Queens Tomato Festival Launch',
      description: 'First annual tomato festival held in Astoria celebrates Italian-American heritage',
      year: 1967,
      imageUrl: null,
      source: 'Queens Memory Project',
      type: 'archive',
      url: null
    },
    {
      title: 'Community Garden Initiative',
      description: 'Bronx community gardeners harvest tomatoes from urban garden plots',
      year: 1978,
      imageUrl: null,
      source: 'NYC Municipal Archives',
      type: 'archive',
      url: null
    },
    {
      title: 'Greenmarket Expansion Brings Fresh Produce',
      description: 'Union Square Greenmarket opens, bringing locally-grown tomatoes to Manhattan shoppers',
      year: 1982,
      imageUrl: null,
      source: 'The New York Times Archive',
      type: 'article',
      url: null
    }
  ];

  return samples;
}

/**
 * Generate sample menu data for testing (legacy)
 */
function getSampleData(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // Sample tomato items for demonstration
  const samples = [
    {
      dishName: 'Tomato Soup, Consommé',
      price: '0.25',
      menuDate: `1908-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
      year: 1908,
      venue: 'Hotel Astor',
      location: 'New York'
    },
    {
      dishName: 'Sliced Tomatoes',
      price: '0.15',
      menuDate: `1922-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
      year: 1922,
      venue: 'Delmonico\'s',
      location: 'New York'
    },
    {
      dishName: 'Broiled Lobster with Tomato Sauce',
      price: '1.50',
      menuDate: `1935-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
      year: 1935,
      venue: 'Waldorf-Astoria',
      location: 'New York'
    },
    {
      dishName: 'Tomato and Mozzarella Salad',
      price: '0.85',
      menuDate: `1951-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
      year: 1951,
      venue: 'Mama Leone\'s',
      location: 'New York'
    },
    {
      dishName: 'Cream of Tomato Soup',
      price: '0.40',
      menuDate: `1969-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
      year: 1969,
      venue: 'Horn & Hardart Automat',
      location: 'New York'
    }
  ];

  return samples;
}

/**
 * Main function
 */
async function main() {
  console.log('🍅 The Daily Tomato - Updating...\n');

  // Check for test mode
  const isTestMode = process.env.TEST_MODE === 'true' || process.argv.includes('--test');

  // Ensure data directories exist
  await ensureDir(DATA_DIR);
  await ensureDir(CACHE_DIR);

  // Get current date
  const today = new Date();

  // Fetch weather
  console.log('🌤️  Fetching NYC weather...');
  let weather;
  if (isTestMode) {
    console.log('(Using sample weather data)');
    weather = { temp: 42, unit: 'F', condition: 'Partly Cloudy', icon: '⛅' };
  } else {
    weather = await getNYCWeather();
  }
  console.log(`✓ Weather: ${weather.temp}°${weather.unit} - ${weather.condition}\n`);

  // Gather items from all data sources
  let items;
  if (isTestMode) {
    console.log('🔍 Using sample archival items...');
    items = getSampleArchiveData(today);
  } else {
    items = await gatherAllItems(today);
  }

  // Generate HTML
  console.log('\n📰 Generating HTML...');
  const html = await generateHTML(today, weather, items);

  // Write to index.html
  const indexPath = path.join(ROOT_DIR, 'index.html');
  await fs.writeFile(indexPath, html, 'utf-8');
  console.log(`✓ Written to ${indexPath}`);

  console.log('\n✅ Update complete!');
  console.log(`📊 Found ${items.length} tomato item${items.length !== 1 ? 's' : ''} for ${today.toLocaleDateString()}`);
}

// Run
main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
