# Grimoire — TCG Collector

A single-page web app for tracking your Trading Card Game (TCG) physical card collection. 
Designed for collectors who want full control over their game definitions, expansion checklists, and pull-rate analytics.

---

## Features

- **Custom TCG Systems** — Define your own rarities, colors, pull rates, and stat fields (Attack, Defense, Cost, etc.).
- **Expansion Management** — Organize sets with abbreviations, release dates, series/IP grouping, and custom sections (Booster, Starter, Special, Promo).
- **Card Catalog** — Add cards with names, numbers, types (Leader/Unit/Skill/Item), elements, images, and effect text. Drag-and-drop reordering.
- **Collection Tracking** — Mark cards as owned, set quantities, and track duplicates.
- **Visual Checklists** — Grid view and realistic **Binder view** with ring-bound pages, pocket sizes (4/9/12/16), and cover/divider designer.
- **Pull Rate Analytics** — Per-rarity completion bars, theoretical odds, and booster/box counters calculated automatically from your tracked cards.
- **Home Dashboard** — "Recently Added" and "Rarest Pulls" highlights per system.
- **Themes** — Switch between *Grimoire Ledger*, *Gilt Reliquary*, *Moonlit Athenaeum*, *Black*, and *Light*.
- **Multilingual** — Interface and card data in **Korean**, **English**, **German** and **Japanese**. Card translations are machine-made and unofficial.
- **Sign-in & Sync (optional)** — Sign in to keep your collection in step across devices (Supabase). Signed out, everything stays in your browser.
- **Import / Export** — Export your collection progress as JSON, or import it on another device. Expansion card lists can also be exported/imported independently.
- **Image Hosting** — Point expansions to a custom image base URL (e.g., GitHub Pages) with automatic fallback to original sources. Includes a Python helper script to batch-download card art.
- **eBay Prices & Collection Value** — Card tiles and the detail view show the median asking price of active eBay listings for every printing; the stats bar shows what your copies of the current expansion are worth, and Home shows your total collection value, value per expansion and a value-over-time chart. See [eBay Prices](#ebay-prices).
- **Static-First** — Runs entirely in the browser with `localStorage` persistence. Optionally backed by a lightweight Python server (`server.py` + SQLite) for local development.

---

## Tech Stack

- **Frontend:** Vanilla HTML/JS with a custom template runtime (`dc-runtime`) that compiles `x-dc` templates to React 18 components.
- **Styling:** Inline CSS via design tokens (CSS custom properties) — no build step required.
- **State:** `localStorage` (primary on GitHub Pages) with optional `fetch` to `/api/state` for local server usage.
- **Data:** Card database is loaded from `grimoire-data.json` (published from the Builder and committed to the repo).

---

## eBay Prices

Card tiles (hover a variant tick or the card) and the card detail view show the median asking price
of active eBay Buy It Now listings for each printing. Your collection's value - owned copies x that
median, per expansion and in total - is shown in the expansion stats bar and on Home, along with a
value-over-time chart.

Prices are refreshed every three days by a scheduled job in the Supabase database; the eBay API keys
are stored there and never appear in this repo or the page. Every refresh appends a dated point to
each card's history, which is what the timeline is drawn from. `grimoire-prices.json` is the
fallback the page uses while the database can't be reached, so it can be older than what you see
normally. Cards without matching listings show no price and are counted as "without listings" rather
than valued at zero. Values are computed on the page; your owned cards stay in your browser unless you sign in to sync.

---
