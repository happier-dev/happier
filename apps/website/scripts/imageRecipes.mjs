/**
 * The single declaration of every raster the marketing page can request, and
 * the widths it is actually displayed at.
 *
 * This file is the contract between the build (scripts/optimize-images.mjs,
 * which encodes the variants) and the runtime (src/data/generatedImages.ts,
 * which is generated from it and consumed by <Picture>). Adding art to the
 * page means adding a line here — there is no code path that reaches a raster
 * the pipeline has not seen, because `assertOptimizedImages()` in
 * scripts/assert-perf-budget.mjs fails the build on any `/images/*.png|jpg`
 * that appears in the bundle but not in this list.
 *
 * `widths` are CSS-pixel render widths x DPR, i.e. the real decoded sizes the
 * browser will pick from — NOT arbitrary breakpoints. Over-declaring costs
 * build time and disk; under-declaring costs bytes at the top of the funnel.
 */

/** @typedef {{ id: string, src: string, widths: number[], sizes: string, formats?: ('avif'|'webp')[], quality?: { avif?: number, webp?: number }, fallbackWidth?: number, fallbackFormat?: 'jpeg'|'png' }} Recipe */

/** @type {Recipe[]} */
export const RECIPES = [
    // ---- Hero backdrop -----------------------------------------------------
    // LCP element. 6144x4096 source (25.2 MP) rendered into a 100vw x ~78vh
    // object-cover box. 2560 covers a 1440@2x laptop; 3840 is deliberately NOT
    // emitted — nobody reads a blurred backdrop at 5K and it doubles the bytes.
    {
        id: 'heroBackdropDark',
        src: 'images/background5_black_jpg60.jpg',
        widths: [640, 960, 1440, 1920, 2560],
        sizes: '100vw',
        quality: { avif: 45, webp: 72 },
        fallbackWidth: 1920,
        fallbackFormat: 'jpeg',
    },
    {
        id: 'heroBackdropLight',
        src: 'images/background5_white_jpg60.jpg',
        widths: [640, 960, 1440, 1920, 2560],
        sizes: '100vw',
        quality: { avif: 45, webp: 72 },
        fallbackWidth: 1920,
        fallbackFormat: 'jpeg',
    },

    // ---- Product showcase --------------------------------------------------
    // Desktop screenshot: full content width, capped at the 1460px page max.
    // 1800px preserves readable UI above 1x without emitting the 217-347 KB
    // WebP variants that the former 2048/2880 widths produced.
    {
        id: 'showcaseDesktop',
        src: 'images/demo/screenshots/desktop.png',
        widths: [768, 1024, 1440, 1800],
        sizes: '(max-width: 639px) 180vw, (max-width: 1460px) 100vw, 1460px',
        quality: { avif: 52, webp: 80 },
        fallbackWidth: 1440,
        fallbackFormat: 'png',
    },
    // Phone screenshot: clamp(140px, 24%, 300px) on sm+, <=460px stacked on phones.
    {
        id: 'showcaseMobile',
        src: 'images/demo/screenshots/mobile.png',
        widths: [300, 460, 620, 920],
        sizes: '(max-width: 639px) min(460px, 100vw), clamp(140px, 24vw, 300px)',
        quality: { avif: 52, webp: 80 },
        fallbackWidth: 460,
        fallbackFormat: 'png',
    },

    // ---- iOS theme previews (8 of them; only #1 is ever above the fold) ----
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
        id: `iosTheme${n}`,
        src: `images/demo/screenshots/ios-themes/${n}.png`,
        widths: [300, 460, 620],
        sizes: 'clamp(140px, 24vw, 300px)',
        quality: { avif: 52, webp: 80 },
        fallbackWidth: 460,
        fallbackFormat: /** @type {'png'} */ ('png'),
    })),

    // ---- Wordmark ----------------------------------------------------------
    // 481x105 source rendered at h-7/h-8 => ~128x28 CSS px. Shipping 481px wide
    // is already 3.7x over; 320 covers 160@2x with room.
    {
        id: 'logotypeLight',
        src: 'images/logotype-light.png',
        widths: [160, 320],
        sizes: '160px',
        quality: { avif: 60, webp: 88 },
        fallbackWidth: 320,
        fallbackFormat: 'png',
    },
    {
        id: 'logotypeDark',
        src: 'images/logotype-dark.png',
        widths: [160, 320],
        sizes: '160px',
        quality: { avif: 60, webp: 88 },
        fallbackWidth: 320,
        fallbackFormat: 'png',
    },

    // ---- Feature panel art -------------------------------------------------
    // These already have hand-made @1x/@2x webp; the pipeline takes them over so
    // there is exactly one encoder in the repo. Panel art is at most ~61% of a
    // 1460px panel => ~890 CSS px, so 1800 is the real @2x ceiling and the
    // existing 2000px "@2x" variants are already oversized.
    ...[
        'anywhere',
        'existing-sessions',
        'terminal',
        'one-tap-away',
        'review',
        'voice',
        'mcp',
        'subscriptions',
        'sail-past-limits',
    ].map((name) => ({
        id: `feature_${name.replace(/-/g, '_')}`,
        src: `images/features/${name}.png`,
        widths: [480, 720, 900, 1400, 1800],
        sizes: '(max-width: 767px) 110vw, min(61vw, 890px)',
        quality: { avif: 50, webp: 80 },
        fallbackWidth: 900,
        fallbackFormat: /** @type {'png'} */ ('png'),
    })),
];

/** Sources whose ORIGINAL file may still be referenced (favicon, release key). */
export const PASSTHROUGH = ['images/favicon.png'];
