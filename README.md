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
- **Multilingual** — Interface available in **English**, **Korean**, and **German** (card content can be scraped/translated too).
- **Import / Export** — Export your collection progress as JSON, or import it on another device. Expansion card lists can also be exported/imported independently.
- **Image Hosting** — Point expansions to a custom image base URL (e.g., GitHub Pages) with automatic fallback to original sources. Includes a Python helper script to batch-download card art.
- **Static-First** — Runs entirely in the browser with `localStorage` persistence. Optionally backed by a lightweight Python server (`server.py` + SQLite) for local development.

---

## Tech Stack

- **Frontend:** Vanilla HTML/JS with a custom template runtime (`dc-runtime`) that compiles `x-dc` templates to React 18 components.
- **Styling:** Inline CSS via design tokens (CSS custom properties) — no build step required.
- **State:** `localStorage` (primary on GitHub Pages) with optional `fetch` to `/api/state` for local server usage.
- **Data:** Card database is loaded from `grimoire-data.json` (published from the Builder and committed to the repo).

---
