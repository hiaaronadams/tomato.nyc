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
const WEATHER_API = 'https://api.weather.gov/gridpoints/OKX/33,37/forecast';

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
 */
async function queryNYPLDigitalCollections(date) {
  try {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    // Search for tomato-related items
    const query = `tomato AND dateDigitized:*-${month}-${day}`;
    const url = `${NYPL_DIGITAL_API}?q=${encodeURIComponent(query)}&per_page=20&publicDomainOnly=true`;

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.warn('NYPL Digital API failed');
      return [];
    }

    const data = await response.json();
    const items = [];

    if (data.nyplAPI?.response?.result) {
      for (const item of data.nyplAPI.response.result.slice(0, 5)) {
        items.push({
          title: item.title || 'Untitled',
          imageUrl: item.imageID?.[0] ? `https://digitalcollections.nypl.org/items/${item.imageID[0]}/book` : null,
          year: item.dateDigitized ? new Date(item.dateDigitized).getFullYear() : null,
          description: item.description || '',
          source: 'NYPL Digital Collections',
          type: 'image'
        });
      }
    }

    return items;
  } catch (err) {
    console.warn(`NYPL Digital API error: ${err.message}`);
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
  console.log('\n📚 Querying all data sources...');

  // 1. NYPL Menus
  try {
    const menuItems = await findTomatoItemsForDate(date);
    allItems.push(...menuItems);
  } catch (err) {
    console.warn('Menu search failed:', err.message);
  }

  // 2. NYPL Digital Collections
  try {
    console.log('🖼️  Searching NYPL Digital Collections...');
    const digitalItems = await queryNYPLDigitalCollections(date);
    console.log(`✓ Found ${digitalItems.length} digital items`);
    allItems.push(...digitalItems);
  } catch (err) {
    console.warn('Digital collections search failed:', err.message);
  }

  // If no items from any source, return sample data
  if (allItems.length === 0) {
    console.log('⚠️  No items found from any source, using sample data...');
    return getSampleData(date).map(item => ({
      title: item.dishName,
      description: `${item.price} • ${item.venue}`,
      year: item.year,
      imageUrl: null,
      source: 'NYPL What\'s on the Menu (Sample)',
      type: 'menu'
    }));
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
        const colClass = index === 0 ? 'col-12 col-md-6' : 'col-12 col-md-3';
        const hasImage = item.imageUrl;

        return `
      <div class="${colClass}">
        <div class="snippet">
          ${hasImage ? `<div class="snippet-image" style="background-image: url('${escapeHtml(item.imageUrl)}')"></div>` : '<div class="snippet-image"></div>'}
          <div class="snippet-content">
            <h3>${escapeHtml(item.title)}</h3>
            <p class="snippet-meta">${item.year || 'Date unknown'}</p>
            <p class="snippet-desc">${escapeHtml(item.description || '')}</p>
          </div>
        </div>
      </div>`;
      }).join('\n')
    : '<div class="col-12"><p class="no-items">No tomato items found for this day in history. Check back tomorrow! 🍅</p></div>';

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

    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Times New Roman', Times, serif;
            background-color: #FF223C;
            color: #F7F7F7;
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
            border-top: 2px solid #F7F7F7;
            border-bottom: 2px solid #F7F7F7;
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

        .masthead {
            text-align: center;
            margin: 20px 0;
        }

        .masthead h1 {
            font-size: 5rem;
            font-weight: 400;
            letter-spacing: 0.05em;
            margin: 0;
            line-height: 1;
        }

        .tagline {
            text-align: center;
            font-style: italic;
            font-size: 16px;
            margin-top: 10px;
        }

        /* Grid system */
        .row {
            display: flex;
            flex-wrap: wrap;
            margin: 0 -15px;
        }

        .col-12 {
            width: 100%;
            padding: 0 15px;
            margin-bottom: 30px;
        }

        .col-md-6 {
            width: 100%;
            padding: 0 15px;
            margin-bottom: 30px;
        }

        .col-md-3 {
            width: 100%;
            padding: 0 15px;
            margin-bottom: 30px;
        }

        @media (min-width: 768px) {
            .col-md-6 {
                width: 50%;
            }
            .col-md-3 {
                width: 25%;
            }
        }

        /* Snippets */
        .snippet {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        .snippet-image {
            background-color: #F7F7F7;
            background-size: cover;
            background-position: center;
            width: 100%;
            padding-bottom: 66.67%; /* 3:2 aspect ratio */
            margin-bottom: 15px;
        }

        .snippet-content h3 {
            font-size: 20px;
            margin-bottom: 8px;
            font-weight: 400;
            line-height: 1.3;
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
            border-top: 2px solid #F7F7F7;
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
                <div class="weather">${weather.icon} ${weather.temp}°${weather.unit || 'F'} ${weather.condition}</div>
            </div>
            <div class="masthead">
                <h1>The Tomato Times</h1>
            </div>
            <div class="tagline">On This Day in NYC Tomato History</div>
        </header>

        <main>
            <div class="row">
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
 * Generate sample data for testing
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
    console.log('🔍 Using sample tomato items...');
    items = getSampleData(today).map(item => ({
      title: item.dishName,
      description: `${item.price} • ${item.venue}`,
      year: item.year,
      imageUrl: null,
      source: 'NYPL What\'s on the Menu (Sample)',
      type: 'menu'
    }));
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
