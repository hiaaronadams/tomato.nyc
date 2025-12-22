# 🍅 The Daily Tomato

*On This Day in NYC Tomato History*

A daily newspaper showcasing tomato-related items from New York City's culinary history. Each day, the site displays historic menu items featuring tomatoes from NYC restaurants on this day in history (any year), along with current weather.

## Features

- **Daily Updates**: Automatically updates at 6am EST with new content
- **Historic Menu Items**: Searches NYPL's "What's on the Menu" dataset (1.3M+ dishes from 17,500+ menus)
- **NYC Weather**: Current weather conditions from NOAA
- **Newspaper Layout**: Classic NYTimes-inspired design with serif fonts
- **Date Matching**: Finds tomato dishes from any year that match today's month/day
- **SEO Optimized**: Full Open Graph and Twitter Card support

## Data Sources

### Currently Implemented
- **NYPL What's on the Menu**: Historic restaurant menus (1840s-1990s)
  - CSV data from AWS S3: `s3.amazonaws.com/menusdata.nypl.org`
  - 1,335,570 transcribed dishes from 17,562 menus
  - Public domain, no copyright restrictions

### Planned Additions
- NYPL Digital Collections API (photos, manuscripts)
- NYC Municipal Archives
- Queens Memory Project
- Brooklyn Public Library Digital Collections

## Development

### Installation

```bash
npm install
```

### Running Locally

Test mode (with sample data):
```bash
npm run dev
```

Production mode (downloads real data):
```bash
npm run update
```

### Project Structure

```
tomato.nyc/
├── index.html              # Generated daily newspaper page
├── scripts/
│   └── daily-update.js     # Main update script
├── data/
│   └── cache/              # Cached CSV files (gitignored)
├── .github/
│   └── workflows/
│       └── daily-update.yml # GitHub Actions workflow
└── package.json
```

### How It Works

1. **Script runs daily** (via GitHub Actions at 6am EST)
2. **Downloads/caches** NYPL menu CSV files (cached for 30 days)
3. **Searches** for dishes containing "tomato" that match today's month/day
4. **Fetches** current NYC weather from NOAA API
5. **Generates** HTML with newspaper layout
6. **Commits** and pushes updated `index.html`

### Test Mode

The script includes a test mode for development without downloading large CSV files:

```javascript
// Uses sample data instead of downloading
npm run dev
// or
TEST_MODE=true npm run update
```

## Deployment

### GitHub Pages

1. Enable GitHub Pages in repository settings
2. Set source to main branch, root directory
3. The GitHub Action will automatically update the site daily

### Other Platforms

This is a static site - just deploy `index.html`. Works with:
- Netlify
- Vercel
- Cloudflare Pages
- Any static hosting

## Automation

Daily updates run via GitHub Actions at 6am EST (11am UTC). The workflow:
1. Checks out the repository
2. Installs Node.js and dependencies
3. Runs the update script
4. Commits and pushes changes

Manual updates can be triggered via the Actions tab.

## License

MIT

## Credits

- Menu data: [NYPL What's on the Menu](https://www.nypl.org/research/support/whats-on-the-menu)
- Weather data: NOAA/Weather.gov API
- Inspired by classic newspaper design
