import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../../../../../packages/tests/src/testkit/uiE2e/browserDiagnostics';

let script: string;
let origin: string;
const server = createWorkspaceBrowserServer(() => script);
beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser({ entryFile: 'sources/dev/testkit/render/workflowLibraryBrowserApp.tsx', boundaryFiles: {
        // This journey exercises the real dialog/focus/portal owner, unlike the guard fixture.
        'sources/modal/index.ts': 'sources/modal/index.ts',
    } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Library browser HTTP boundary unavailable');
    origin = `http://127.0.0.1:${address.port}`;
}, 600_000);
afterAll(async () => { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
type Harness = { libraryHttpTrace: string[]; libraryHarness: { mount(phone: boolean, theme: 'light' | 'dark', singleDefinition?: boolean, surface?: 'library' | 'artifacts'): Promise<void>; settleDeletion(success: boolean): void; deletionPending(): boolean; switchAccount(): Promise<void>; reactivateRuntime(): void } };

async function settleDeletion(page: Page, success: boolean) {
    // UI busy precedes transport admission; acknowledge only the real delayed DELETE request.
    await expect.poll(() => page.evaluate(() => {
        const harness = window as unknown as Harness;
        return harness.libraryHarness.deletionPending() ? 'admitted' : harness.libraryHttpTrace.join('\n');
    })).toBe('admitted');
    await page.evaluate(value => (window as unknown as Harness).libraryHarness.settleDeletion(value), success);
}

describe('real workspace workflow library row actions (DESIGN12)', () => {
    it.each([[1440, false, false], [390, false, false], [1440, true, false], [390, true, false],
        [1440, false, true], [390, false, true], [1440, true, true], [390, true, true]] as const)
    ('projects editor-menu Delete pending, receipt and surviving focus at %i px (last=%s, cold=%s)', async (width, last, cold) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        let diagnostics = () => '';
        try {
            const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
            diagnostics = collectBrowserDiagnostics({ page });
            await page.goto(`${origin}/workflows${cold ? '/10000000-0000-4000-8000-000000000001' : ''}`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(({ width, last }) => (window as unknown as Harness).libraryHarness.mount(width === 390, 'light', last), { width, last });
            if (!cold) await page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001').click();
            await page.getByTestId(width === 390 ? 'page-header-actions.trigger' : 'workflow-editor-menu.trigger').click();
            await page.getByTestId('workflow-editor-menu-delete').click();
            await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
            await page.getByTestId('workflow-editor-deleting').waitFor();
            expect(await page.getByTestId('workflows-home:deleted').count()).toBe(0);
            if (cold) expect(await page.evaluate(() => (window as unknown as Harness).libraryHttpTrace))
                .not.toContain('GET /v1/artifacts');
            await settleDeletion(page, true);
            await page.getByTestId('workflows-home:deleted').waitFor();
            expect(await page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001').count()).toBe(0);
            const target = last ? page.getByTestId('workflows-home:new') : page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000002');
            await expect.poll(() => target.evaluate(node => node.contains(document.activeElement))).toBe(true);
            console.log('editor-menu Delete outcome', { width, last, cold, focus: await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) });
        } catch (error) { throw appendBrowserDiagnostics(error, diagnostics()); }
        finally { await browser.close(); }
    }, 180_000);
    it.each([[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']] as const)
    ('keeps the related Artifacts List on its page edge at %i px in %s', async (width, theme) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
            await page.goto(`${origin}/artifacts`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(({ width, theme }) => (window as unknown as Harness).libraryHarness.mount(width === 390, theme, false, 'artifacts'), { width, theme });
            const row = page.getByTestId('artifacts:row:layout-note');
            await row.waitFor();
            await page.evaluate(() => document.fonts.ready);
            const geometry = async () => ({
                row: (await row.boundingBox())!,
                title: await page.getByTestId('artifacts:header').getByText('Artifacts', { exact: true }).evaluate(node => {
                    const range = document.createRange(); range.selectNodeContents(node);
                    return range.getBoundingClientRect().left;
                }),
            });
            const artifactDir = process.env.HAPPIER_DESIGN12_CAPTURE_DIR;
            if (artifactDir) {
                await mkdir(artifactDir, { recursive: true });
                await page.screenshot({ path: path.join(artifactDir, `collection-artifacts-${process.env.HAPPIER_DESIGN12_CAPTURE_PHASE ?? 'after'}-${width}-${theme}.png`) });
            }
            console.log('Artifacts List page-edge geometry', width, theme, await geometry());
            await expect.poll(async () => { const rect = await geometry(); return Math.abs(rect.row.x + 1 - rect.title); }).toBeLessThanOrEqual(1);
        } finally { await browser.close(); }
    }, 180_000);
    it.each(['light', 'dark'] as const)('aligns narrow built-in actions with their title text in %s', async (theme) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(theme => (window as unknown as Harness).libraryHarness.mount(true, theme), theme);
            const counts = page.locator('[data-testid^="workflow-builtins:"][data-testid$=":count"]');
            await expect.poll(() => counts.count()).toBe(4);
            const geometry = async () => counts.evaluateAll(nodes => nodes.map(count => {
                const primary = count.closest('[data-testid]')!.parentElement!.closest('[data-testid]')!;
                const text = primary.querySelector('[dir="auto"]');
                if (!text) throw new Error('Built-in title missing');
                const range = document.createRange();
                range.selectNodeContents(text);
                const action = primary.parentElement!.querySelector('[data-testid$=":session"], [data-testid$=":run"]');
                if (!action) throw new Error('Built-in action missing');
                return { title: range.getBoundingClientRect().left, action: action.getBoundingClientRect().left };
            }));
            await expect.poll(async () => (await geometry()).map(rect => Math.abs(rect.action - rect.title)))
                .toEqual([0, 0, 0, 0]);
            console.log('narrow built-in leading edges', theme, await geometry());
        } finally { await browser.close(); }
    }, 180_000);
    it.each(['pending', 'receipt', 'pending after runtime reactivation'] as const)('retires deletion %s without stealing focus when a kept Library changes Account', async (phase) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as Harness).libraryHarness.mount(false, 'light'));
            const row = page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001');
            await row.waitFor();
            if (phase === 'pending after runtime reactivation') {
                await page.evaluate(() => (window as unknown as Harness).libraryHarness.reactivateRuntime());
            }
            await page.getByRole('button', { name: 'Workflow options', exact: true }).first().click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
            await expect.poll(() => row.getAttribute('aria-busy')).toBe('true');
            await expect.poll(() => page.evaluate(() => {
                const harness = window as unknown as Harness;
                return harness.libraryHarness.deletionPending() ? 'admitted' : harness.libraryHttpTrace.join('\n');
            })).toBe('admitted');
            if (phase === 'receipt') {
                await settleDeletion(page, true);
                await page.getByTestId('workflows-home:deleted').waitFor();
            }
            const creation = page.getByRole('button', { name: 'New workflow', exact: true });
            await creation.focus();
            await page.evaluate(() => (window as unknown as Harness).libraryHarness.switchAccount());
            await page.getByText('Account B neighbor', { exact: true }).waitFor();
            expect(await page.getByTestId('workflows-home:deleted').count()).toBe(0);
            if (phase !== 'receipt') {
                await expect.poll(() => row.getAttribute('aria-busy')).not.toBe('true');
                await settleDeletion(page, false);
                expect(await page.getByRole('dialog').count()).toBe(0);
            }
            await expect.poll(() => creation.evaluate(node => node.contains(document.activeElement))).toBe(true);
        } finally { await browser.close(); }
    }, 180_000);
    it('focuses the library creation action after deleting the last visible workflow', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as Harness).libraryHarness.mount(true, 'light', true));
            const row = page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001');
            await row.waitFor();
            await page.getByRole('button', { name: 'Workflow options', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
            await expect.poll(() => row.getAttribute('aria-busy')).toBe('true');
            await settleDeletion(page, true);
            await expect.poll(() => row.count()).toBe(0);
            await expect.poll(() => page.getByTestId('workflows-home:new').evaluate(node => node.contains(document.activeElement))).toBe(true);
        } finally { await browser.close(); }
    }, 180_000);
    it('recomposes Needs you beneath the full-width phone row', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as Harness).libraryHarness.mount(true, 'light'));
            const row = page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001');
            const needsYou = page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001:needsYou');
            await needsYou.waitFor();
            // The shared adaptive owner commits after its platform layout measurement.
            await expect.poll(async () => (await row.boundingBox())!.width).toBeGreaterThan(250);
            const primaryRect = await row.boundingBox();
            const accessoryRect = await needsYou.boundingBox();
            expect(accessoryRect!.y).toBeGreaterThanOrEqual(primaryRect!.y + primaryRect!.height);
            const plainRow = await page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000002').boundingBox();
            const plainOverflow = await page.getByRole('button', { name: 'Workflow options', exact: true }).nth(1).boundingBox();
            const overflowCenter = plainOverflow!.y + plainOverflow!.height / 2;
            expect(overflowCenter).toBeGreaterThanOrEqual(plainRow!.y);
            expect(overflowCenter).toBeLessThanOrEqual(plainRow!.y + plainRow!.height);
        } finally { await browser.close(); }
    }, 180_000);
    it('returns focus to the row after cancelling deletion', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as Harness).libraryHarness.mount(true, 'light'));
            await page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001').waitFor();
            await page.getByRole('button', { name: 'Workflow options', exact: true }).first().click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect.poll(() => page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001').evaluate(node => node.contains(document.activeElement))).toBe(true);
        } finally { await browser.close(); }
    }, 180_000);
    it('keeps the workflow and returns focus after a failed deletion is acknowledged', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as Harness).libraryHarness.mount(true, 'light'));
            const row = page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001');
            await row.waitFor();
            await page.getByRole('button', { name: 'Workflow options', exact: true }).first().click();
            await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
            await expect.poll(() => row.getAttribute('aria-busy')).toBe('true');
            await settleDeletion(page, false);
            await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
            await expect.poll(() => row.getAttribute('aria-busy')).not.toBe('true');
            await expect.poll(() => row.evaluate(node => node.contains(document.activeElement))).toBe(true);
            expect(await page.getByTestId('workflows-home:deleted').count()).toBe(0);
        } finally { await browser.close(); }
    }, 180_000);
    it('keeps built-in counts right-aligned and actions leading-aligned in their desktop columns', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            await page.goto(`${origin}/workflows`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as unknown as Harness).libraryHarness.mount(false, 'light'));
            const counts = page.locator('[data-testid^="workflow-builtins:"][data-testid$=":count"]');
            await expect.poll(() => counts.count()).toBe(4);
            await page.evaluate(() => document.fonts.ready);
            const countRects = await counts.evaluateAll(nodes => nodes.map(node => {
                const range = document.createRange();
                range.selectNodeContents(node);
                const rect = range.getBoundingClientRect();
                const primary = node.parentElement!.closest('[data-testid]')!;
                const action = primary.parentElement!.querySelector('[data-testid$=":session"], [data-testid$=":run"]');
                if (!action) throw new Error('Built-in action missing');
                return { right: rect.right, width: rect.width, actionLeft: action.getBoundingClientRect().left };
            }));
            expect(countRects.every(rect => rect.width > 0)).toBe(true);
            const rightEdges = countRects.map(rect => rect.right);
            console.log('builtin count geometry', countRects);
            expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(1);
            const actionEdges = countRects.map(rect => rect.actionLeft);
            expect(Math.max(...actionEdges) - Math.min(...actionEdges)).toBeLessThanOrEqual(1);
        } finally { await browser.close(); }
    }, 180_000);
    it.each([
        [1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark'],
    ] as const)('fits its menu, preserves destructive semantics and returns focus after deletion at %i px in %s', async (width, theme) => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        try {
                const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
                await page.goto(`${origin}/workflows`);
                await page.addScriptTag({ url: `${origin}/bundle.js` });
                await page.evaluate(async ({ phone, theme }) => (window as unknown as Harness).libraryHarness.mount(phone, theme), { phone: width === 390, theme });
                const row = page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001');
                await row.waitFor();
                await page.evaluate(() => document.fonts.ready);
                const bootstrap = await page.evaluate(() => ({
                    rootHeight: document.getElementById('root')!.getBoundingClientRect().height,
                    regularFontReady: document.fonts.check('14px "Inter-Regular"'),
                    fontsLoaded: Array.from(document.fonts).filter(face => face.status === 'loaded').length,
                }));
                console.log('Library canonical bootstrap', { width, theme, ...bootstrap });
                expect(bootstrap.rootHeight).toBe(width === 390 ? 844 : 1000);
                expect(bootstrap.regularFontReady).toBe(true);
                if (width === 390) await expect.poll(async () => (await row.boundingBox())!.width).toBeGreaterThan(250);
                const artifactDir = process.env.HAPPIER_DESIGN12_CAPTURE_DIR;
                if (artifactDir) {
                    await mkdir(artifactDir, { recursive: true });
                    await page.screenshot({ path: path.join(artifactDir, `collection-${process.env.HAPPIER_DESIGN12_CAPTURE_PHASE ?? 'after'}-${width}-${theme}-page.png`) });
                }
                await page.getByRole('button', { name: 'Workflow options', exact: true }).first().click();
                const menu = page.getByRole('menu');
                await menu.waitFor();
                await expect.poll(() => menu.evaluate(node => {
                    for (let current: Element | null = node; current; current = current.parentElement) {
                        if (Number(getComputedStyle(current).opacity) < 1) return false;
                    }
                    return true;
                })).toBe(true);
                if (artifactDir) {
                    await mkdir(artifactDir, { recursive: true });
                    await page.screenshot({ path: path.join(artifactDir, `collection-${process.env.HAPPIER_DESIGN12_CAPTURE_PHASE ?? 'after'}-${width}-${theme}.png`) });
                }
                const rect = await menu.boundingBox();
                expect(rect).not.toBeNull();
                expect(rect!.x).toBeGreaterThanOrEqual(0);
                expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
                const remove = menu.getByRole('menuitem', { name: 'Delete', exact: true });
                const run = menu.getByRole('menuitem', { name: 'Run now', exact: true });
                expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(36);
                expect(await remove.getByText('Delete', { exact: true }).evaluate(node => getComputedStyle(node).color))
                    .not.toBe(await run.getByText('Run now', { exact: true }).evaluate(node => getComputedStyle(node).color));
                await remove.click();
                const dialog = page.getByRole('dialog');
                await dialog.waitFor();
                await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
                await expect.poll(() => row.getAttribute('aria-busy')).toBe('true');
                const pendingIndicator = row.getByRole('progressbar', { includeHidden: true });
                await expect.poll(() => pendingIndicator.count()).toBe(1);
                expect((await pendingIndicator.boundingBox())!.width).toBeGreaterThan(0);
                if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `collection-${process.env.HAPPIER_DESIGN12_CAPTURE_PHASE ?? 'after'}-${width}-${theme}-pending.png`) });
                await settleDeletion(page, true);
                await expect.poll(() => row.count()).toBe(0);
                await page.getByTestId('workflows-home:deleted').waitFor();
                const neighbor = page.getByTestId('workflows-home:row:10000000-0000-4000-8000-000000000002');
                await expect.poll(() => neighbor.evaluate(node => node.contains(document.activeElement))).toBe(true);
                if (artifactDir) await page.screenshot({ path: path.join(artifactDir, `collection-${process.env.HAPPIER_DESIGN12_CAPTURE_PHASE ?? 'after'}-${width}-${theme}-receipt.png`) });
                await page.getByRole('button', { name: 'Workflow options', exact: true }).click();
                await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
                await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
                await expect.poll(() => neighbor.getAttribute('aria-busy')).toBe('true');
                expect(await page.getByTestId('workflows-home:deleted').count()).toBe(0);
                await settleDeletion(page, true);
                await expect.poll(() => neighbor.count()).toBe(0);
                await page.getByTestId('workflows-home:deleted').waitFor();
                await expect.poll(() => page.getByTestId('workflows-home:new').evaluate(node => node.contains(document.activeElement))).toBe(true);
                await page.close();
        } finally { await browser.close(); }
    }, 180_000);
});
