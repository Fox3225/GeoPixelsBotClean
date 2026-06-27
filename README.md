# GhostPixel Bot Clean

GhostPixel Bot Clean is a clean and optimized userscript for GeoPixels. It helps automate ghost image painting with progress sync, smart color ordering, color filters, missing color purchases, and Energy Capacity management.

## Install

[Install with Tampermonkey](https://raw.githubusercontent.com/Fox3225/GeoPixelsBotClean/main/ghostpixel-bot-clean.user.js)

## Features

- Floating draggable UI
- Ghost image progress sync
- Done/remaining pixel counter
- Energy and ETA display
- Include/exclude free and transparent colors
- Manual color exclusion
- Manual color priority
- Smart priority mode for details and small regions
- Buy all missing ghost image colors
- Buy Energy Capacity using available Pixels
- Safer page-context bridge for GeoPixels auth and purchases

## Usage

Install the script in Tampermonkey, open GeoPixels, load and position your ghost image, then use the GhostPixel panel to sync, configure filters, buy missing colors, and start painting.

## Notes

Energy Capacity is purchased manually from the panel with the available Pixels balance. The bot still respects current energy while painting and waits for recharge when necessary.
