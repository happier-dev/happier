import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { collectBrowserDiagnostics, appendBrowserDiagnostics } from '../../../../../../../../../packages/tests/src/testkit/uiE2e/browserDiagnostics';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { workflowRouteStartupBrowserBuildTimeoutMs } from '@/dev/testkit/render/workflowRouteStartupBrowserOptions';

let script = '';
let origin = '';
const server = createWorkspaceBrowserServer(() => script);
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser({
        entryFile: 'sources/dev/testkit/transcript/runtimeContract/transcriptRetentionBrowserApp.tsx', lazy: false,
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Transcript browser fixture did not bind');
    origin = `http://127.0.0.1:${address.port}`;
}, workflowRouteStartupBrowserBuildTimeoutMs);
afterAll(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    script = '';
});

describe('installed web transcript retention', () => {
    it.each(['home', 'participants'] as const)('keeps the reading row through %s, notes and delayed image growth', async exit => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const page = await browser.newPage({ viewport: { width: exit === 'home' ? 900 : 390, height: 844 } });
        const diagnostics = collectBrowserDiagnostics({ page });
        let releaseImage = () => {};
        const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
        await page.route('**/delayed-image.svg', async route => {
            await imageGate;
            await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="green"/></svg>' });
        });
        try {
            await page.goto(origin);
            await page.evaluate(() => localStorage.setItem('happier.debug.viewportWrites', '1'));
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            const thread = page.getByTestId('thread');
            await page.getByTestId('message-note-23').waitFor();
            if (exit === 'home') await page.waitForTimeout(1200);
            const box = await thread.boundingBox();
            if (!box) throw new Error('Thread viewport missing');
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, exit === 'home' ? -500 : -900);
            await expect.poll(() => thread.evaluate(el => {
                const scroll = el.querySelector<HTMLElement>('[style*="overflow"]');
                return scroll ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop : 0;
            })).toBeGreaterThan(200);
            await page.waitForTimeout(1200);
            const anchor = await thread.evaluate(el => {
                const v = el.getBoundingClientRect();
                const rows = [...el.querySelectorAll<HTMLElement>('[data-testid^="message-"]')];
                return (rows.find(row => { const r = row.getBoundingClientRect(); return r.top >= v.top && r.bottom <= v.bottom; })
                    ?? rows.find(row => { const r = row.getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; }))?.dataset.testid;
            });
            if (!anchor) throw new Error('No visible reading message');
            await page.getByTestId('image-row').fill(`note-${Math.max(0, Number(anchor.replace('message-note-', '')) - 1)}`);
            const offset = () => page.getByTestId(anchor).evaluate(row => row.getBoundingClientRect().top - document.querySelector('[data-testid="thread"]')!.getBoundingClientRect().top);
            const before = await offset();
            await page.getByTestId(exit).click();
            await page.getByTestId('notes').click();
            // Participants is display:none in the live shell, not a route remount.
            // Let the real zero-size observation arrive before revealing it again.
            if (exit === 'participants') {
                await expect.poll(() => thread.evaluate(el => el.getBoundingClientRect().height)).toBe(0);
                await page.waitForTimeout(500);
            }
            await page.getByTestId(exit === 'home' ? 'back' : 'chat').click();
            await thread.waitFor({ state: 'visible' });
            const imageRequested = page.waitForRequest('**/delayed-image.svg');
            await page.getByTestId('grow').click();
            await imageRequested;
            await page.waitForTimeout(2000);
            releaseImage();
            // The real image load/ResizeObserver and note append must settle before assertion.
            await page.waitForFunction(() => [...document.images].every(image => image.complete));
            // R42 remained wrong after ten seconds. An eventual assertion alone can
            // pass on the correct first frame before a later bootstrap/MVCP rollback.
            await page.waitForTimeout(10000);
            await expect.poll(offset, { timeout: 15000 }).toBeCloseTo(before, 0);
            expect(await page.getByTestId('draft').inputValue()).toBe('Keep this unsent draft');
        } catch (error) {
            const ring = await page.evaluate(() => {
                const ring = (globalThis as typeof globalThis & { __happierViewportDiagnostics?: Record<string, unknown> }).__happierViewportDiagnostics;
                return Object.fromEntries(Object.entries(ring ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.slice(-12) : value]));
            });
            console.log('Transcript retention write trace', JSON.stringify(ring));
            throw appendBrowserDiagnostics(error, diagnostics());
        } finally {
            releaseImage();
            await browser.close();
        }
    });
});
