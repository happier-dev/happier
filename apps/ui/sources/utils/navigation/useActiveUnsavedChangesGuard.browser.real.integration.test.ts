import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../../../../packages/tests/src/testkit/uiE2e/browserDiagnostics';

let script: string;
let origin: string;
const captureDirectory = process.env.HAPPIER_DESIGN12_CAPTURE_DIR
    ?? fileURLToPath(new URL('../../../../../.project/tmp/fin-design12-fix/', import.meta.url));
// Serve the real Metro bundle over HTTP rather than serializing its entire
// development graph through Chromium's debugging protocol for every page.
const server = createWorkspaceBrowserServer(() => script);
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Browser harness did not bind its HTTP boundary');
    origin = `http://127.0.0.1:${address.port}`;
}, 600_000);
afterAll(async () => { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

type Harness = { guardHarness: { mount: (phone: boolean) => Harness['app'] }; app: {
    open: (href: string) => void; back: () => void; ready: () => boolean;
    read: () => { href: string; draft?: string; target?: string; dirty?: boolean };
} };

describe('workspace history with a lazily mounted editor in Chromium', () => {
    it.each([
        { phone: false, theme: 'light' }, { phone: false, theme: 'dark' },
        { phone: true, theme: 'light' }, { phone: true, theme: 'dark' },
    ] as const)('keeps Account loading counts unknown and line content aligned (DESIGN-12 states phone=$phone theme=$theme)', async ({ phone, theme }) => {
        type StatesHarness = { themeHarness: { mount: (theme: 'light' | 'dark') => Promise<void>; failTriggerReads: () => void } };
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        let readDiagnostics = () => '';
        try {
            const page = await browser.newPage({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
            readDiagnostics = collectBrowserDiagnostics({ page });
            await page.emulateMedia({ colorScheme: theme });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(theme => (window as unknown as StatesHarness).themeHarness.mount(theme), theme);
            await page.getByTestId('account-triggers-read').waitFor();
            const directory = captureDirectory;
            await mkdir(directory, { recursive: true });
            const prefix = `states-${phone ? 'phone' : 'desktop'}-${theme}-${process.env.HAPPIER_DESIGN12_CAPTURE_PHASE ?? 'after'}`;
            await page.screenshot({ path: path.join(directory, `${prefix}-loading.png`) });
            const heading = page.getByTestId('workflows-column:group:triggers');
            expect.soft(await heading.innerText()).not.toMatch(/\b0\b/);
            const layout = await page.evaluate(() => {
                const heading = document.querySelector('[data-testid="workflows-column:group:triggers"]')!;
                const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
                const text = walker.nextNode()!;
                const range = document.createRange();
                range.selectNodeContents(text);
                const line = document.querySelector('[data-testid="account-triggers-read"]')!;
                const glyph = line.firstElementChild!;
                const lineText = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode()!.parentElement!;
                return {
                    alignment: Math.abs(range.getBoundingClientRect().left - glyph.getBoundingClientRect().left),
                    lineHeight: line.getBoundingClientRect().height,
                    rootHeight: document.getElementById('root')!.getBoundingClientRect().height,
                    viewportHeight: innerHeight,
                    selectedFont: getComputedStyle(lineText).fontFamily,
                    fonts: Array.from(document.fonts).map(face => ({ family: face.family, status: face.status })),
                };
            });
            console.info('DESIGN12 states loaded-owner projection', { phone, theme, ...layout });
            expect(layout.rootHeight).toBe(layout.viewportHeight);
            expect(layout.selectedFont).toContain('Inter-Regular');
            for (const family of ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'BricolageGrotesque-Bold', 'IBMPlexMono-Regular']) {
                expect(layout.fonts).toContainEqual({ family, status: 'loaded' });
            }
            expect(layout.lineHeight).toBeGreaterThanOrEqual(32);
            expect.soft(layout.alignment).toBeLessThanOrEqual(1);
            await page.evaluate(() => (window as unknown as StatesHarness).themeHarness.failTriggerReads());
            await expect.poll(() => page.getByTestId('scheduled-workflow-read').innerText()).toContain('Could not load your triggers.');
            expect(await page.getByTestId('scheduled-workflow-read').innerText()).not.toContain("this session's");
            expect.soft(await heading.innerText()).not.toMatch(/\b0\b/);
            await page.screenshot({ path: path.join(directory, `${prefix}-failed.png`) });
        } catch (error) { throw appendBrowserDiagnostics(error, readDiagnostics()); }
        finally { await browser.close(); }
    });
    it.each(['/workflows/new', '/workflows/history-saved'])('pops header Back after a dirty editor reload (%s, FF-N3DEEP)', async editorHref => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            await page.goto(`${origin}/`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(true); });
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.ready())).toBe(true);
            for (const href of ['/workflows', editorHref]) {
                await page.evaluate(href => (window as unknown as Harness).app.open(href), href);
                await expect.poll(() => page.evaluate(() => location.pathname)).toBe(href);
            }
            await page.reload();
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(true); });
            await page.locator('input').fill('Description changed after reload');
            const cdp = await page.context().newCDPSession(page);
            const baseline = await cdp.send('Page.getNavigationHistory');
            await page.getByTestId('workspace-destination-header').getByRole('button', { name: 'Back', exact: true }).click();
            await page.locator('#discard').click();
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/workflows');
            await expect.poll(async () => (await cdp.send('Page.getNavigationHistory')).currentIndex).toBe(baseline.currentIndex - 1);
            const after = await cdp.send('Page.getNavigationHistory');
            expect(after.entries.map(entry => ({ id: entry.id, url: entry.url }))).toEqual(baseline.entries.map(entry => ({ id: entry.id, url: entry.url })));
            expect(after.entries.filter(entry => new URL(entry.url).pathname === '/workflows')).toHaveLength(1);
            await page.evaluate(() => history.back());
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
            // Those pre-reload entries are now known again. Their native positions
            // still run forwards even though the rebuilt workspace admitted them backwards.
            for (const href of ['/workflows', editorHref]) {
                await page.evaluate(() => history.forward());
                await expect.poll(() => page.evaluate(() => location.pathname)).toBe(href);
            }
            await page.locator('input').fill('Retained editor draft');
            await page.evaluate(() => history.back());
            await page.locator('#decision').waitFor();
            await expect.poll(async () => (await cdp.send('Page.getNavigationHistory')).currentIndex).toBe(baseline.currentIndex);
            await page.locator('#keepEditing').click();
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe(editorHref);
            expect(await page.locator('input').inputValue()).toBe('Retained editor draft');
            const retained = await cdp.send('Page.getNavigationHistory');
            expect(retained.entries.map(entry => ({ id: entry.id, url: entry.url }))).toEqual(baseline.entries.map(entry => ({ id: entry.id, url: entry.url })));
        } finally { await browser.close(); }
    });
    it.each([
        { phone: false, reload: false }, { phone: true, reload: false },
        { phone: false, reload: true }, { phone: true, reload: true },
    ])('preserves browser chronology through guarded traversals (phone=$phone reload=$reload, R8-2-01/R9-2-01)', async ({ phone, reload }) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: 1000 } });
            await page.goto(`${origin}/`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(phone => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(phone); }, phone);
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.ready())).toBe(true);
            for (const href of ['/workflows', '/workflows/new', '/workflows/builtin:plan-with-a-panel']) {
                await page.evaluate(href => (window as unknown as Harness).app.open(href), href);
                await expect.poll(() => page.evaluate(() => decodeURIComponent(location.pathname))).toBe(href);
            }
            await page.evaluate(() => history.back());
            await page.locator('input').waitFor();
            if (reload) {
                // Native positions survive; the workspace entry Map does not.
                // Make the editor dirty before any old entry is catalog-admitted.
                await page.reload();
                await page.addScriptTag({ url: `${origin}/bundle.js` });
                await page.evaluate(phone => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(phone); }, phone);
                await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.ready())).toBe(true);
            }
            await page.locator('input').fill('Chronology draft');
            const cdp = await page.context().newCDPSession(page);
            const readHistory = async () => {
                const history = await cdp.send('Page.getNavigationHistory');
                return { index: history.currentIndex, entries: history.entries.map(entry => ({ id: entry.id, url: entry.url })) };
            };
            const baseline = await readHistory();
            for (const decision of ['keepEditing', 'save']) {
                await page.evaluate(() => history.forward());
                await page.locator('#decision').waitFor();
                await page.locator(`#${decision}`).click();
                await expect.poll(() => page.locator('#decision').count()).toBe(0);
                await expect.poll(readHistory).toEqual(baseline);
                expect(await page.locator('input').inputValue()).toBe('Chronology draft');
            }
            // An ordinary Back must retain its future entry, and a repeated
            // traversal must not rewrite history while the decision is pending.
            await page.evaluate(() => history.back());
            await page.locator('#decision').waitFor();
            await expect.poll(readHistory).toEqual(baseline);
            await page.evaluate(() => history.forward());
            await expect.poll(readHistory).toEqual(baseline);
            await page.locator('#keepEditing').click();
            await expect.poll(() => page.locator('#decision').count()).toBe(0);
            await page.evaluate(() => history.go(-2));
            await page.locator('#decision').waitFor();
            await page.locator('#keepEditing').click();
            await expect.poll(readHistory).toEqual(baseline);
            expect(await page.locator('input').inputValue()).toBe('Chronology draft');
            await page.evaluate(() => history.forward());
            await page.locator('#decision').waitFor();
            // Acceptance must still resume the first Forward, not a later
            // gesture's target while the same decision remains open.
            await page.evaluate(() => history.go(-2));
            await expect.poll(readHistory).toEqual(baseline);
            await page.locator('#discard').click();
            await expect.poll(() => page.evaluate(() => decodeURIComponent(location.pathname))).toBe('/workflows/builtin:plan-with-a-panel');
            await expect.poll(readHistory).toEqual({ ...baseline, index: baseline.index + 1 });
            expect(await page.locator('input').count()).toBe(0);
            await page.evaluate(() => history.back());
            await page.locator('input').fill('Multi-Back draft');
            await page.evaluate(() => history.go(-2));
            await page.locator('#decision').waitFor();
            await expect.poll(readHistory).toEqual(baseline);
            await page.locator('#discard').click();
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
            await expect.poll(readHistory).toEqual({ ...baseline, index: baseline.index - 2 });
        } finally { await browser.close(); }
    });
    it('reaches phone Discard by opening one real navigation overflow (DESIGN-11 N60)', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(true); });
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.ready())).toBe(true);
            await page.evaluate(() => (window as unknown as Harness).app.open('/workflows/new'));
            await page.locator('input').fill('Phone discard');
            await page.getByTestId('page-header-actions.trigger').click();
            await expect.poll(() => page.getByTestId('history-editor-discard').isVisible()).toBe(true);
            expect(await page.getByTestId('history-editor-menu.trigger').count()).toBe(0);
            await page.getByTestId('history-editor-discard').click();
            await expect.poll(() => page.locator('#decision').isVisible()).toBe(true);
            await page.locator('#discard').click();
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/workflows');
        } finally { await browser.close(); }
    });

    it('keeps the accepted reload destination after Expo mirrors it (DESIGN-11 N3)', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage();
            await page.goto(`${origin}/`);
            await page.evaluate(() => { history.pushState({ id: 'old-list' }, '', '/workflows'); history.pushState({ id: 'old-editor' }, '', '/workflows/new'); });
            await page.reload();
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(false); });
            await page.locator('input').fill('Reloaded draft');
            await page.evaluate(() => history.back());
            await page.locator('#discard').click();
            await expect.poll(() => page.locator('#new').isVisible()).toBe(true);
            await page.waitForTimeout(150);
            expect(await page.evaluate(() => location.pathname)).toBe('/workflows');
            await page.evaluate(() => history.back());
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
        } finally { await browser.close(); }
    });

    it.each([
        { mode: 'explicit', phone: false }, { mode: 'adaptive', phone: false },
        { mode: 'explicit', phone: true }, { mode: 'adaptive', phone: true },
    ] as const)('updates shell and control paint on a live $mode theme switch as on a fresh load (DESIGN-12 N63 phone=$phone)', async ({ mode, phone }) => {
        type ThemeHarness = { themeHarness: { mount: (theme: 'light' | 'dark') => Promise<void>; mountAdaptive: () => Promise<void>; switchTheme: (theme: 'light' | 'dark') => void } };
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        let readDiagnostics = () => '';
        try {
            const page = await browser.newPage({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
            readDiagnostics = collectBrowserDiagnostics({ page });
            const open = async (theme: 'light' | 'dark') => {
                await page.emulateMedia({ colorScheme: theme });
                await page.goto(origin);
                await page.addScriptTag({ url: `${origin}/bundle.js` });
                await page.evaluate(({ theme, mode }) => {
                    const harness = (window as unknown as ThemeHarness).themeHarness;
                    return mode === 'adaptive' ? harness.mountAdaptive() : harness.mount(theme);
                }, { theme, mode });
                await page.getByTestId('theme-tabs:steps').waitFor();
            };
            const paint = () => page.evaluate(() => ['html', '#theme-title', '#theme-column', '#theme-content', '[data-testid="theme-tabs:steps"]', '[data-testid="theme-status"]'].map(selector => {
                const node = document.querySelector(selector);
                const colors = [];
                for (let current: Element | null = node; current && current.id !== 'root'; current = current.parentElement) {
                    const style = getComputedStyle(current);
                    colors.push([style.color, style.backgroundColor, style.borderColor]);
                }
                return colors;
            }));
            const capture = async (theme: 'light' | 'dark', state: 'fresh' | 'live') => {
                const directory = captureDirectory;
                await mkdir(directory, { recursive: true });
                await page.screenshot({ path: path.join(directory, `states-theme-${phone ? 'phone' : 'desktop'}-${mode}-${theme}-${state}-${process.env.HAPPIER_DESIGN12_CAPTURE_PHASE ?? 'after'}.png`) });
            };
            await open('dark');
            const freshDark = await paint();
            await capture('dark', 'fresh');
            await open('light');
            const freshLight = await paint();
            await capture('light', 'fresh');
            if (mode === 'adaptive') await page.emulateMedia({ colorScheme: 'dark' });
            else await page.evaluate(() => (window as unknown as ThemeHarness).themeHarness.switchTheme('dark'));
            try { await expect.poll(paint).toEqual(freshDark); } finally { await capture('dark', 'live'); }
            if (mode === 'adaptive') await page.emulateMedia({ colorScheme: 'light' });
            else await page.evaluate(() => (window as unknown as ThemeHarness).themeHarness.switchTheme('light'));
            try { await expect.poll(paint).toEqual(freshLight); } finally { await capture('light', 'live'); }
        } catch (error) { throw appendBrowserDiagnostics(error, readDiagnostics()); }
        finally { await browser.close(); }
    });
    it.each([
        { reload: false, phone: false, origin: '/workflows', editor: '/workflows/new' },
        { reload: false, phone: false, origin: '/workflows/builtin:plan-with-a-panel', editor: '/workflows/new' },
        { reload: false, phone: false, origin: '/workflows/builtin:plan-with-a-panel', editor: '/workflows/new?definitionDraftSeedId=duplicate-builtin' },
        { reload: true, phone: false, origin: '/workflows', editor: '/workflows/new' },
        { reload: true, phone: true, origin: '/workflows', editor: '/workflows/new' },
        { reload: true, phone: false, origin: '/workflows/builtin:plan-with-a-panel', editor: '/workflows/new?definitionDraftSeedId=duplicate-builtin' },
        { reload: false, phone: true, origin: '/workflows', editor: '/workflows/new' },
        { reload: false, phone: true, origin: '/workflows/builtin:plan-with-a-panel', editor: '/workflows/new?definitionDraftSeedId=duplicate-builtin' },
    ])('keeps a dirty draft on real Back (reload=$reload, phone=$phone, origin=$origin, editor=$editor)', async ({ reload, phone, origin: previous, editor }) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: 1000 } });
            page.on('pageerror', error => console.error(error));
            await page.goto(`${origin}${previous}`);
            await page.evaluate(() => history.replaceState({ id: 'expo-origin-before-reload' }, '', location.href));
            if (reload) { await page.evaluate(editor => history.pushState({ id: 'expo-new' }, '', editor), editor); await page.reload(); }
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(phone => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(phone); }, phone);
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.ready())).toBe(true);
            if (!reload) await page.evaluate(editor => (window as unknown as Harness).app.open(editor), editor);
            await page.waitForSelector('input');
            await page.locator('input').fill('Keep my draft');
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.read())).toMatchObject({ dirty: true });
            const cdp = await page.context().newCDPSession(page);
            const readHistory = async () => {
                const history = await cdp.send('Page.getNavigationHistory');
                return { index: history.currentIndex, urls: history.entries.map(entry => entry.url) };
            };
            // Unknown/pre-reload restoration may replace the browser entry's
            // identity; its URL order and current index must still be useful.
            const baseline = await readHistory();
            await page.evaluate(() => history.back());
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.read())).toMatchObject({ href: '/workflows/new', draft: 'Keep my draft' });
            await expect.poll(() => page.locator('#decision').isVisible()).toBe(true);
            await page.locator('#keepEditing').click();
            await expect.poll(() => page.locator('#decision').count()).toBe(0);
            await expect.poll(readHistory).toEqual(baseline);
            await page.evaluate(() => history.back());
            await expect.poll(() => page.locator('#decision').isVisible()).toBe(true);
            await page.locator('#save').click();
            await expect.poll(() => page.locator('#decision').count()).toBe(0);
            await expect.poll(readHistory).toEqual(baseline);
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.read())).toMatchObject({ href: '/workflows/new', draft: 'Keep my draft', dirty: true });
            await page.evaluate(() => history.back());
            await expect.poll(() => page.locator('#decision').isVisible()).toBe(true);
            await page.locator('#discard').click();
            await expect.poll(() => page.evaluate(() => decodeURIComponent((window as unknown as Harness).app.read().href))).toBe(previous);
            await expect.poll(() => page.locator('input').count()).toBe(0);
            await expect.poll(() => page.locator('#new').isVisible()).toBe(true);
            await expect.poll(readHistory).toEqual({ ...baseline, index: baseline.index - 1 });
            const browserHistory = await cdp.send('Page.getNavigationHistory');
            expect(browserHistory.entries.filter(entry => decodeURIComponent(new URL(entry.url).pathname) === previous)).toHaveLength(1);
        } finally { await browser.close(); }
    });

    it.each([false, true])('menu Discard pops the origin and leaves one useful Back (phone=%s)', async phone => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: 1000 } });
            await page.goto(`${origin}/`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(phone => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(phone); }, phone);
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.ready())).toBe(true);
            await page.evaluate(() => (window as unknown as Harness).app.open('/workflows'));
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/workflows');
            await page.evaluate(() => (window as unknown as Harness).app.open('/workflows/new'));
            await page.locator('input').fill('Menu draft');
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.read().dirty)).toBe(true);
            const cdp = await page.context().newCDPSession(page);
            const baseline = await cdp.send('Page.getNavigationHistory');
            await page.getByTestId(phone ? 'page-header-actions.trigger' : 'history-editor-menu.trigger').click();
            await page.getByTestId('history-editor-discard').click();
            await expect.poll(() => page.locator('#decision').isVisible()).toBe(true);
            await page.locator('#discard').click();
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/workflows');
            const browserHistory = await cdp.send('Page.getNavigationHistory');
            expect(browserHistory.currentIndex).toBe(baseline.currentIndex - 1);
            expect(browserHistory.entries.map(entry => ({ id: entry.id, url: entry.url })))
                .toEqual(baseline.entries.map(entry => ({ id: entry.id, url: entry.url })));
            expect(browserHistory.entries.filter(entry => new URL(entry.url).pathname === '/workflows')).toHaveLength(1);
            await page.evaluate(() => history.back());
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
        } finally { await browser.close(); }
    });

    it('pops phone editor Back without accumulating Workflows entries', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
            await page.goto(`${origin}/`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => { const h = window as unknown as Harness; h.app = h.guardHarness.mount(true); });
            await expect.poll(() => page.evaluate(() => (window as unknown as Harness).app.ready())).toBe(true);
            await page.evaluate(() => (window as unknown as Harness).app.open('/workflows'));
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/workflows');
            const cdp = await page.context().newCDPSession(page);
            const baseline = await cdp.send('Page.getNavigationHistory');
            for (let visit = 0; visit < 2; visit += 1) {
                await page.evaluate(() => (window as unknown as Harness).app.open('/workflows/new'));
                await page.getByTestId('workspace-destination-header').getByRole('button', { name: 'Back', exact: true }).click();
                await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/workflows');
                const browserHistory = await cdp.send('Page.getNavigationHistory');
                expect(browserHistory.currentIndex).toBe(baseline.currentIndex);
                expect(browserHistory.entries.map(entry => entry.url)).toEqual([
                    ...baseline.entries.map(entry => entry.url), `${origin}/workflows/new`,
                ]);
                const workflows = browserHistory.entries.filter(entry => new URL(entry.url).pathname === '/workflows');
                expect(workflows).toHaveLength(1);
                expect(new URL(browserHistory.entries[browserHistory.currentIndex].url).pathname).toBe('/workflows');
            }
            await page.evaluate(() => (window as unknown as Harness).app.back());
            await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
        } finally { await browser.close(); }
    });
});
