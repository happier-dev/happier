import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

describe('detached theme stylesheet security boundary', () => {
    let browser: Browser;
    let page: Page;
    const requests: string[] = [];
    beforeAll(async () => {
        const bundle = await build({
            entryPoints: [fileURLToPath(new URL('./themeStylesheet.web.ts', import.meta.url))],
            bundle: true, write: false, format: 'iife', globalName: 'themeSheet', platform: 'browser',
        });
        browser = await chromium.launch({ headless: true });
        page = await browser.newPage();
        page.on('request', (request) => requests.push(request.url()));
        await page.route('**/*', (route) => route.abort());
        await page.setContent('<html><head><base href="https://theme-sentinel.invalid/"></head><body><div data-surface="user-bubble" data-part="root" data-secret="fixture">Text</div></body></html>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
    });
    afterAll(async () => { await browser?.close(); });

    it('makes zero requests from detached parsing through attachment, replacement and recovery', async () => {
        const result = await page.evaluate(async () => {
            // The script bundle exposes the real adapter in this browser realm.
            const api = (globalThis as unknown as { themeSheet: typeof import('./themeStylesheet.web') }).themeSheet;
            const host = 'https://theme-sentinel.invalid/';
            const source = `@import "${host}import";
                @font-face { font-family: probe; src: url(${host}font); }
                @property --probe { syntax: "<image>"; inherits: false; initial-value: url(${host}registered); }
                @media (min-width:0px) { @import "${host}nested-import"; [data-secret="fixture"] { --image: url("${host}custom"); background-image: var(--image); cursor: URL('${host}cursor'), auto; } }
                @supports selector(:is(*)) { [data-surface] { margin: 7px; } }
                @keyframes probe { from { background-image: url(${host}keyframe); opacity: .2; } to { opacity: 1; } }
                [data-surface="user-bubble"] { color: rgb(12, 34, 56); padding: 13px; background-image: image-set("${host}set" 1x); animation: probe 1s linear infinite; font-family: probe; border: 1px solid; border-image-source: var(--probe); border-image-slice: 1; }
                [data-surface="user-bubble"] { background-image: url(relative.png); &[data-part] { background-image: url(//theme-sentinel.invalid/nested); } }
                @unknown { [data-secret] { background-image: url(${host}unknown); } }`;
            const first = api.applyThemeStylesheet({ source }, 'dark');
            const element = document.querySelector('[data-surface]')!;
            const style = getComputedStyle(element);
            const paint = { color: style.color, padding: style.paddingTop, margin: style.marginTop, background: style.backgroundImage };
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            const count = document.adoptedStyleSheets.length;
            api.applyThemeStylesheet({ source: '[data-surface] { padding: 17px; background-image: linear-gradient(red, blue); }' }, 'light');
            const replacement = getComputedStyle(element).paddingTop;
            const replacementCount = document.adoptedStyleSheets.length;
            api.applyThemeStylesheet(null, 'light');
            return { first, paint, count, replacement, replacementCount, cleared: document.adoptedStyleSheets.length, dark: document.documentElement.classList.contains('dark') };
        });
        expect(result.first.available).toBe(true);
        expect(result.first.stripped.length).toBeGreaterThan(0);
        expect(result.paint).toEqual({ color: 'rgb(12, 34, 56)', padding: '13px', margin: '7px', background: 'none' });
        expect(result.count).toBe(1);
        expect(result.replacement).toBe('17px');
        expect(result.replacementCount).toBe(1);
        expect(result.cleared).toBe(0);
        expect(result.dark).toBe(false);
        expect(requests).toEqual([]);
        const outcome = await page.evaluate(async () => {
            const api = (globalThis as unknown as { themeSheet: typeof import('./themeStylesheet.web') }).themeSheet;
            const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://theme-sentinel.invalid/svg"/><style>@import "https://theme-sentinel.invalid/style"; @font-face { font-family: probe; src: url(https://theme-sentinel.invalid/svg-font); } text { font-family: probe; }</style><text x="0" y="12">fixture</text></svg>');
            const result = api.applyThemeStylesheet({ source: `[data-surface] { background-image: url("data:image/svg+xml,${svg}"); filter: url(#local); }` }, 'light');
            const background = getComputedStyle(document.querySelector('[data-surface]')!).backgroundImage;
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            return { result, background };
        });
        expect(outcome.result.available).toBe(true);
        expect(outcome.background).toContain('data:image/svg+xml');
        expect(requests).toEqual([]);
        const results = await page.evaluate(() => {
            const api = (globalThis as unknown as { themeSheet: typeof import('./themeStylesheet.web') }).themeSheet;
            const values = [
                'url(HTTPS://theme-sentinel.invalid/upper)',
                'url("//theme-sentinel.invalid/protocol")',
                'url(../relative)', 'url(file:///fixture)', 'url(blob:fixture)', 'url(javascript:fixture)',
                'url(/**/https://theme-sentinel.invalid/comment/**/)',
                'url(d/**/ata:relative)',
                'url(/**/data:relative)',
                'url(" data:relative")',
                'image("https://theme-sentinel.invalid/image")',
                'src("https://theme-sentinel.invalid/source")',
                '-webkit-image-set(url(https://theme-sentinel.invalid/set) 1x)',
            ];
            const outcomes = values.map((value) => {
                const result = api.applyThemeStylesheet({ source: `[data-secret] { --probe: ${value}; background-image: var(--probe); padding: 19px; }` }, 'light');
                const style = getComputedStyle(document.querySelector('[data-surface]')!);
                return { available: result.available, background: style.backgroundImage, padding: style.paddingTop };
            });
            const escaped = api.applyThemeStylesheet({ source: String.raw`[data-secret] { --probe: u\72l(https://theme-sentinel.invalid/escaped); background-image: var(--probe, u\72l(https://theme-sentinel.invalid/fallback)); padding: 23px; p\61dding: 99px; } [data-se\63ret] { padding: 91px; } @media (min-\77idth:0px) { [data-secret] { padding: 81px; } }` }, 'light');
            const rejected = api.applyThemeStylesheet({ source: '[data-secret] { background-image: url("unfinished', }, 'dark');
            return { outcomes, escaped, rejected, padding: getComputedStyle(document.querySelector('[data-surface]')!).paddingTop, sheets: document.adoptedStyleSheets.length, dark: document.documentElement.classList.contains('dark') };
        });
        expect(results.outcomes.every((value) => value.available && value.background === 'none' && value.padding === '19px')).toBe(true);
        expect(results.escaped.available).toBe(true);
        expect(results.escaped.stripped.length).toBeGreaterThan(0);
        expect(results.rejected.available).toBe(false);
        expect(results.rejected.error).toBeTruthy();
        expect(results.padding).toBe('23px');
        expect(results.dark).toBe(false);
        expect(results.sheets).toBe(1);
        expect(requests).toEqual([]);
    });
});
