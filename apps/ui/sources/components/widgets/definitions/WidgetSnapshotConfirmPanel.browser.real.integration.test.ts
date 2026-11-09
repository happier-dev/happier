import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';
import { workflowRouteStartupBrowserOptions } from '@/dev/testkit/render/workflowRouteStartupBrowserOptions';

let script: string;
const server = createWorkspaceBrowserServer(() => script);
let origin: string;
beforeAll(async () => {
    const packagedAssets = await readFile('sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js', 'utf8');
    const assetBoundaries = Object.fromEntries(Array.from(packagedAssets.matchAll(/require\("([^"]+\.bundle)"\)/g), match => [
        match[1], 'sources/dev/testkit/render/widgetSnapshotPackagedAssetBoundary.ts',
    ]));
    script = await buildWorkspaceHistoryBrowser({
        entryFile: 'sources/dev/testkit/render/widgetSnapshotBrowser.tsx',
        // Keep the real Modal owner while replacing only Expo's navigation boundary.
        realExpoRouter: true,
        boundaryModules: { ...workflowRouteStartupBrowserOptions.boundaryModules, ...assetBoundaries,
            'expo-router': 'sources/dev/testkit/render/workspaceHistoryBrowserBoundary.tsx' },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing snapshot browser listener');
    origin = `http://127.0.0.1:${address.port}`;
}, 600_000);
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

it('keeps the renderer responsive through one trusted snapshot primary press', async () => {
    const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`${error.name}: ${error.message}`));
    try {
        await page.goto(origin);
        await page.addScriptTag({ url: `${origin}/bundle.js` });
        await page.evaluate(() => {
            const harness = Reflect.get(globalThis, 'widgetSnapshotBrowser') as { mount(): void };
            harness.mount();
        });
        await page.getByTestId('open-snapshot').click();
        const primary = page.getByTestId('snapshot-browser.primary');
        await primary.waitFor();
        const point = await primary.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
            return { x, y, enabled: element.getAttribute('aria-disabled') !== 'true', hit: element.contains(document.elementFromPoint(x, y)) };
        });
        expect(point.enabled).toBe(true);
        expect(point.hit).toBe(true);
        await page.mouse.click(point.x, point.y);
        expect(await page.evaluate(() => document.readyState)).toBe('complete');
        const idle = await page.evaluate(async () => {
            const harness = Reflect.get(globalThis, 'widgetSnapshotBrowser') as { readCommits(): number };
            const before = harness.readCommits();
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            return { before, after: harness.readCommits() };
        });
        // A frame-yielding width cycle would answer the click but keep committing forever.
        expect(idle.after).toBe(idle.before);
        expect(errors).toEqual([]);
    } finally { await browser.close(); }
}, 60_000);
