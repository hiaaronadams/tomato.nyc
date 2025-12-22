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

// Data source URL - NYPL menu dataset archive
// Note: The menus.nypl.org site was retired in Jan 2025
// Archive contains: Dish.csv, Menu.csv, MenuItem.csv, MenuPage.csv
const MENU_DATA_ARCHIVE_URL = 'https://s3.amazonaws.com/menusdata.nypl.org/gzips/2021_08_01_07_01_17_data.tgz';

// Weather API endpoint (NOAA/Weather.gov - free, no key)
const WEATHER_API = 'https://api.weather.gov/gridpoints/OKX/33,37/forecast';

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
      return;
    }
  } catch (err) {
    // Not extracted yet
  }

  console.log('⬇ Downloading NYPL menu data archive...');
  const response = await fetch(MENU_DATA_ARCHIVE_URL);

  if (!response.ok) {
    throw new Error(`Failed to download menu data: ${response.statusText}`);
  }

  // Save archive
  const buffer = await response.arrayBuffer();
  await fs.writeFile(archivePath, Buffer.from(buffer));
  console.log('✓ Downloaded archive');

  // Extract archive
  console.log('📦 Extracting archive...');
  try {
    await execAsync(`tar -xzf "${archivePath}" -C "${CACHE_DIR}"`);
    await fs.writeFile(extractedMarker, new Date().toISOString());
    console.log('✓ Extracted CSV files');
  } catch (err) {
    throw new Error(`Failed to extract archive: ${err.message}`);
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
  await downloadAndExtractMenuData();

  // Load data files from cache
  const dishesPath = path.join(CACHE_DIR, 'Dish.csv');
  const menusPath = path.join(CACHE_DIR, 'Menu.csv');
  const menuItemsPath = path.join(CACHE_DIR, 'MenuItem.csv');

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

  console.log(`✓ Found ${tomatoItems.length} tomato items`);
  return tomatoItems;
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
  items.sort((a, b) => a.year - b.year);

  // Generate item HTML
  const itemsHTML = items.length > 0
    ? items.map(item => `
      <article class="story">
        <h3>${escapeHtml(item.dishName)}</h3>
        <p class="meta">${item.year} • ${escapeHtml(item.venue)} ${item.location !== 'New York' ? `• ${escapeHtml(item.location)}` : ''}</p>
        <p class="price">${escapeHtml(item.price)}</p>
      </article>
    `).join('\n')
    : '<p class="no-items">No tomato items found for this day in history. Check back tomorrow! 🍅</p>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="The Daily Tomato - NYC tomato history for ${dateStr}">
    <meta name="keywords" content="tomato, nyc, new york, history, menus">
    <meta name="author" content="tomato.nyc">

    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://tomato.nyc/">
    <meta property="og:title" content="The Daily Tomato - ${dateStr}">
    <meta property="og:description" content="NYC tomato history from ${items.length} menu${items.length !== 1 ? 's' : ''} on this day">
    <meta property="og:image" content="https://tomato.nyc/og-image.png">

    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="https://tomato.nyc/">
    <meta property="twitter:title" content="The Daily Tomato - ${dateStr}">
    <meta property="twitter:description" content="NYC tomato history from ${items.length} menu${items.length !== 1 ? 's' : ''} on this day">
    <meta property="twitter:image" content="https://tomato.nyc/og-image.png">

    <!-- Favicon -->
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍅</text></svg>">

    <title>The Daily Tomato - ${dateStr}</title>

    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Georgia', 'Times New Roman', serif;
            background-color: #f9f7f1;
            color: #111;
            line-height: 1.6;
            padding: 20px;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 40px;
            box-shadow: 0 0 20px rgba(0,0,0,0.1);
        }

        header {
            border-bottom: 4px double #000;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }

        .masthead {
            text-align: center;
            font-family: 'Georgia', serif;
        }

        .masthead h1 {
            font-size: 3rem;
            font-weight: 900;
            letter-spacing: 2px;
            margin-bottom: 5px;
            font-style: italic;
        }

        .masthead .tagline {
            font-size: 0.9rem;
            font-style: italic;
            color: #666;
            margin-bottom: 15px;
        }

        .date-weather {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.9rem;
            border-top: 1px solid #ddd;
            border-bottom: 1px solid #ddd;
            padding: 10px 0;
            margin-top: 15px;
        }

        .date {
            font-weight: bold;
        }

        .weather {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .stories {
            margin-top: 30px;
        }

        .section-header {
            font-size: 1.3rem;
            font-weight: bold;
            border-bottom: 2px solid #000;
            padding-bottom: 5px;
            margin-bottom: 20px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .story {
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 1px solid #eee;
        }

        .story:last-child {
            border-bottom: none;
        }

        .story h3 {
            font-size: 1.3rem;
            margin-bottom: 8px;
            line-height: 1.3;
        }

        .story .meta {
            color: #666;
            font-size: 0.85rem;
            font-style: italic;
            margin-bottom: 8px;
        }

        .story .price {
            font-weight: bold;
            color: #c41e3a;
        }

        .no-items {
            text-align: center;
            color: #666;
            font-style: italic;
            padding: 40px 20px;
        }

        footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            text-align: center;
            font-size: 0.85rem;
            color: #666;
        }

        footer a {
            color: #c41e3a;
            text-decoration: none;
        }

        footer a:hover {
            text-decoration: underline;
        }

        @media (max-width: 600px) {
            .container {
                padding: 20px;
            }

            .masthead h1 {
                font-size: 2rem;
            }

            .date-weather {
                flex-direction: column;
                gap: 10px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="masthead">
                <h1>🍅 The Daily Tomato</h1>
                <p class="tagline">On This Day in NYC Tomato History</p>
            </div>
            <div class="date-weather">
                <div class="date">${dateStr}</div>
                <div class="weather">
                    <span>${weather.icon} ${weather.temp}°${weather.unit || 'F'}</span>
                    <span>${weather.condition}</span>
                </div>
            </div>
        </header>

        <main class="stories">
            <div class="section-header">
                ${items.length > 0 ? `${items.length} Item${items.length !== 1 ? 's' : ''} Found` : 'Today\'s Edition'}
            </div>
            ${itemsHTML}
        </main>

        <footer>
            <p>Data from <a href="https://www.nypl.org/research/support/whats-on-the-menu" target="_blank">NYPL What's on the Menu</a></p>
            <p>Updates daily at 6am EST • Last updated: ${new Date().toISOString()}</p>
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

  // Find tomato items for today's date
  let items;
  if (isTestMode) {
    console.log('🔍 Using sample tomato items...');
    items = getSampleData(today);
  } else {
    items = await findTomatoItemsForDate(today);
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
