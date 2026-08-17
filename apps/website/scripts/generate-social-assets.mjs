#!/usr/bin/env node
/**
 * Generates the static social/app-icon assets that the <head> references.
 *
 * WHY THIS IS A ONE-SHOT SCRIPT AND NOT A BUILD STEP
 * --------------------------------------------------
 * These outputs are byte-identical on every run for a given source, so making
 * them a build step would only add a `sharp` + system-font dependency to CI for
 * no benefit. The text is rendered by sharp's Pango backend, which resolves
 * fonts through fontconfig — Inter Tight must be INSTALLED ON THE MACHINE (it
 * is, on the maintainer's Mac: ~/Library/Fonts/InterTight-VariableFont_wght.ttf).
 * A GitHub runner has neither, so the render would silently fall back to
 * DejaVu and produce an off-brand image. Run this locally, commit the PNGs.
 *
 *   node scripts/generate-social-assets.mjs
 *
 * Source for the app icon is the shipping iOS icon pulled once from the App
 * Store CDN and cached at assets/source/app-icon-1024.png so the script has no
 * network dependency. Re-pull it only when the iOS icon changes:
 *   curl -o scripts/assets/app-icon-1024.png \
 *     "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/08/b1/69/08b169df-0d3f-a98d-33fd-63057fdc2b1a/AppIcon-0-0-1x_U007epad-0-1-85-220.png/1024x1024bb.png"
 *
 * Outputs:
 *   public/images/og.png               1200x630  — og:image / twitter:image
 *   public/icons/apple-touch-icon.png   180x180  — iOS home screen
 *   public/icons/icon-192.png           192x192  — web app manifest
 *   public/icons/icon-512.png           512x512  — web app manifest
 *   public/icons/icon-maskable-512.png  512x512  — maskable, 80% safe zone
 *   public/icons/favicon-96.png           96x96  — hi-dpi tab icon
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');
const ICONS = path.join(PUBLIC, 'icons');
const ICON_SOURCE = path.join(HERE, 'assets', 'app-icon-1024.png');
const WORDMARK = path.join(PUBLIC, 'images', 'logotype-light.png');

// Theme tokens, copied from src/styles/globals.css :root (the site is
// dark-first — ThemeContext.readInitial() returns 'dark' regardless of the
// system preference, so the social card is unconditionally dark too).
const BG = '#050507';
const FG = '#FFFFFF';
const MUTED = '#9A9AA5';
const ACCENT = '#F5B547';

const OG_W = 1200;
const OG_H = 630;

/** Render a Pango markup string to an RGBA buffer at an exact pixel width. */
async function text(markup, { font, width, spacing = 0, align = 'left' }) {
    return sharp({
        text: {
            text: markup,
            font,
            width,
            align,
            spacing,
            rgba: true,
            dpi: 72, // 72 dpi makes 1 Pango point == 1 device pixel, so the
            // font sizes below read directly as px.
        },
    })
        .png()
        .toBuffer({ resolveWithObject: true });
}

async function buildOgImage() {
    // Ground + a single warm light source in the top-right, mirroring the
    // hero's "one light source" language (globals.css comment at :root).
    const ground = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}">
           <defs>
             <radialGradient id="glow" cx="0.82" cy="0.12" r="0.75">
               <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.20"/>
               <stop offset="45%" stop-color="${ACCENT}" stop-opacity="0.05"/>
               <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
             </radialGradient>
           </defs>
           <rect width="${OG_W}" height="${OG_H}" fill="${BG}"/>
           <rect width="${OG_W}" height="${OG_H}" fill="url(#glow)"/>
           <rect x="80" y="512" width="1040" height="1" fill="#FFFFFF" fill-opacity="0.10"/>
         </svg>`,
    );

    const wordmark = await sharp(WORDMARK).resize({ width: 200 }).png().toBuffer({ resolveWithObject: true });

    const headline = await text(
        `<span foreground="${FG}" weight="800" letter_spacing="-1800">One client for every\nAI coding agent.</span>`,
        { font: 'Inter Tight 62', width: 1040, spacing: 10 },
    );

    const subline = await text(
        `<span foreground="${MUTED}" weight="500">Claude Code · Codex · OpenCode · Cursor · Gemini · Copilot · and 7 more</span>`,
        { font: 'Inter Tight 25', width: 1040 },
    );

    const footer = await text(
        `<span foreground="${MUTED}" weight="500">happier.dev</span><span foreground="#FFFFFF" alpha="28%">   ·   </span><span foreground="${MUTED}" weight="500">MIT-licensed · end-to-end encrypted · self-hostable</span>`,
        { font: 'Inter Tight 21', width: 1040 },
    );

    await sharp(ground)
        .composite([
            { input: wordmark.data, left: 80, top: 76 },
            { input: headline.data, left: 80, top: 190 },
            { input: subline.data, left: 80, top: 190 + headline.info.height + 34 },
            { input: footer.data, left: 80, top: 552 },
        ])
        .png({ compressionLevel: 9, palette: false })
        .toFile(path.join(PUBLIC, 'images', 'og.png'));

    const { size } = await fs.stat(path.join(PUBLIC, 'images', 'og.png'));
    // X/Twitter hard-rejects images over 5 MB; LinkedIn over 5 MB; Slack ~ 2 MB.
    if (size > 1_500_000) throw new Error(`images/og.png is ${size} bytes — too heavy for a social card`);
    console.log(`public/images/og.png     ${OG_W}x${OG_H}  ${(size / 1024).toFixed(0)} KB`);
}

async function buildIcons() {
    await fs.mkdir(ICONS, { recursive: true });
    const src = () => sharp(ICON_SOURCE);

    // apple-touch-icon must be opaque — iOS composites it on white otherwise,
    // and a transparent PNG gets a white halo on the home screen.
    await src().resize(180, 180).flatten({ background: BG }).png().toFile(path.join(ICONS, 'apple-touch-icon.png'));
    await src().resize(192, 192).png().toFile(path.join(ICONS, 'icon-192.png'));
    await src().resize(512, 512).png().toFile(path.join(ICONS, 'icon-512.png'));
    await src().resize(96, 96).png().toFile(path.join(ICONS, 'favicon-96.png'));

    // Maskable: Android crops to a circle/squircle of ~80% of the canvas, so
    // the artwork has to be inset into a 409px safe zone on a filled ground.
    const inner = await src().resize(409, 409).png().toBuffer();
    await sharp({
        create: { width: 512, height: 512, channels: 4, background: BG },
    })
        .composite([{ input: inner, left: 51, top: 51 }])
        .png()
        .toFile(path.join(ICONS, 'icon-maskable-512.png'));

    console.log('public/icons/*.png       180/192/512/96 + maskable-512');
}

async function main() {
    try {
        await fs.access(ICON_SOURCE);
    } catch {
        console.error(`Missing ${ICON_SOURCE} — see the header comment for the one-line curl that fetches it.`);
        process.exit(1);
    }
    await buildOgImage();
    await buildIcons();
}

await main();
