import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectBrowserDiagnostics, appendBrowserDiagnostics } from '../../../../../../packages/tests/src/testkit/uiE2e/browserDiagnostics';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { workflowRouteStartupBrowserBuildTimeoutMs, workflowRouteStartupBrowserOptions } from '@/dev/testkit/render/workflowRouteStartupBrowserOptions';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';
import type { navigationHydrationBrowser } from '@/dev/testkit/render/navigationHydrationBrowser';
import { parseWorkspaceLayout } from '@/components/appShell/workspace/workspacePersistence';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { decodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { WorkspaceTabsV1StoredSchema } from '@happier-dev/protocol/workspace/workspaceTabsV1';

let script: string;
let origin: string;
const savedPath = '/workflows/10000000-0000-4000-8000-000000000001';
const lostCopyPath = '/workflows/new?definitionDraftSeedId=10000000-0000-4000-8000-000000000002';
const runPath = '/workflows/runs/10000000-0000-4000-8000-000000000004';
const accountKv = createAccountKvHttpFixture();
const server = createWorkspaceBrowserServer(() => script, accountKv.handle);
function readAccountTabTargets() {
    const row = accountKv.read('workspace:tabs:v1');
    const envelope = row ? decodeBase64StoredJsonContentEnvelope(row.value) : null;
    if (envelope?.t !== 'plain') return [];
    return Object.values(WorkspaceTabsV1StoredSchema.parse(envelope.v).tabsById).map(tab => tab.target);
}
type BrowserFixture = typeof window & {
    navigationHydrationBrowser: typeof navigationHydrationBrowser;
    startupHarness: { mount: (seed: boolean, holdHome?: boolean) => Promise<void>; readNavigationState: () => unknown;
        readPersistenceState: () => { isDataReady: boolean; profileScope: unknown; layouts: Readonly<Record<string, unknown>> };
        readBootstrapStates: () => Array<{ isDataReady: boolean; profileScope: unknown }>;
        readUnservedHttpPaths: () => string[];
        readHomeGate: () => { requests: number; isDataReady: boolean }; releaseHome: () => void;
        readDocBodyReads: () => number;
        openWorkspace: (href: string) => Promise<{ ok: boolean }>; listWorkspace: () => Promise<{ ok: boolean }> };
    startupHistory: Array<{ method: string; before: string; after: string; stack?: string; navigationBefore?: unknown; navigationAfter?: unknown }>;
};

beforeAll(async () => {
    script = await buildWorkspaceHistoryBrowser(workflowRouteStartupBrowserOptions);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Startup browser harness did not bind');
    origin = `http://127.0.0.1:${address.port}`;
// Same build budget as the incumbent real Metro workspace history journey.
}, workflowRouteStartupBrowserBuildTimeoutMs);
afterAll(async () => {
    try {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { script = ''; }
});

describe('workflow real Expo web startup', () => {
    it('preserves a cold Doc deep link through the supplied Home handoff with one body read', async () => {
        accountKv.reset();
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const diagnostics = collectBrowserDiagnostics({ page });
        const pathname = '/artifacts/10000000-0000-4000-8000-000000000005';
        try {
            await page.goto(`${origin}${pathname}?server=${encodeURIComponent(origin)}`);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as BrowserFixture).startupHarness.mount(true, true));
            await page.waitForFunction(() => (window as BrowserFixture).startupHarness.readHomeGate().requests > 0);
            expect(new URL(page.url()).pathname).toBe(pathname);
            await page.evaluate(() => (window as BrowserFixture).startupHarness.releaseHome());
            await page.waitForFunction(() => (window as BrowserFixture).startupHarness.readPersistenceState().isDataReady);
            await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
            await page.getByTestId('artifact:body').waitFor();
            expect(await page.locator('body').innerText()).toContain('The garden keeps one cedar tree.');
            expect(await page.evaluate(() => (window as BrowserFixture).startupHarness.readDocBodyReads())).toBe(1);
        } catch (error) {
            const state = await page.evaluate(() => (window as BrowserFixture).startupHarness?.readNavigationState());
            throw appendBrowserDiagnostics(error, `${diagnostics()}\nNavigation: ${JSON.stringify(state)}`);
        } finally { await browser.close(); }
    });
    it('retains a parsed child until admission and clears a genuinely unmounted navigator', async () => {
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const page = await browser.newPage();
        const diagnostics = collectBrowserDiagnostics({ page });
        try {
            await page.goto(origin);
            await page.addScriptTag({ url: `${origin}/bundle.js` });
            await page.evaluate(() => (window as BrowserFixture).navigationHydrationBrowser.mount());
            await page.waitForFunction(() => (window as BrowserFixture).navigationHydrationBrowser.isReady());
            await page.getByTestId('hydration-pending').waitFor({ state: 'attached' });
            const readChild = () => page.evaluate(() => (window as BrowserFixture).navigationHydrationBrowser.readState().routes[0].state);
            expect(await readChild()).toMatchObject({ routes: [{ name: 'editor', params: { id: 'saved' } }] });
            await page.evaluate(() => (window as BrowserFixture).navigationHydrationBrowser.admitChild());
            await page.getByTestId('hydration-editor').waitFor({ state: 'attached' });
            await expect.poll(readChild).toMatchObject({ stale: false, routes: [{ name: 'editor', params: { id: 'saved' } }] });
            await page.evaluate(() => (window as BrowserFixture).navigationHydrationBrowser.removeChild());
            await page.getByTestId('hydration-pending').waitFor({ state: 'attached' });
            await expect.poll(readChild).toBeUndefined();
        } catch (error) { throw appendBrowserDiagnostics(error, diagnostics()); }
        finally { await browser.close(); }
    });
    it.each([1440, 390].flatMap(width => [
        { width, href: savedPath, readyId: 'workflow-editor' },
        { width, href: lostCopyPath, readyId: 'workflow-editor-draft-unavailable' },
        { width, href: runPath, readyId: 'workflow-run-screen' },
    ]))('preserves $href on cold load and reload at $width px', async ({ width, href, readyId }) => {
        accountKv.reset();
        const browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
        const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
        const diagnostics = collectBrowserDiagnostics({ page });
        try {
            await page.addInitScript(() => {
                const fixture = window as BrowserFixture;
                fixture.startupHistory = [];
                const readNavigation = () => {
                    const state = fixture.startupHarness?.readNavigationState();
                    return state === undefined ? undefined : JSON.parse(JSON.stringify(state)) as unknown;
                };
                for (const method of ['pushState', 'replaceState'] as const) {
                    const original = history[method].bind(history);
                    history[method] = (...args) => {
                        const before = location.pathname + location.search;
                        const navigationBefore = readNavigation();
                        original(...args);
                        fixture.startupHistory.push({ method, before, after: location.pathname + location.search,
                            stack: new Error().stack, navigationBefore, navigationAfter: readNavigation() });
                    };
                }
            });
            await page.goto(`${origin}${href}`);
            for (const phase of ['cold load', 'reload', 'returning cold']) {
                if (phase === 'reload') await page.reload();
                if (phase === 'returning cold') {
                    const session = '/session/10000000-0000-4000-8000-000000000003';
                    expect(await page.evaluate(path => (window as BrowserFixture).startupHarness.openWorkspace(path), session)).toMatchObject({ ok: true });
                    await expect.poll(() => new URL(page.url()).pathname).toBe(session);
                    // Await the real persisted focused tab, not merely its URL:
                    // the next cold boot must contend with a different destination.
                    await expect.poll(async () => {
                        const { layouts } = await page.evaluate(() => (window as BrowserFixture).startupHarness.readPersistenceState());
                        return Object.values(layouts).flatMap(value => {
                            const layout = parseWorkspaceLayout(value);
                            if (!layout) return [];
                            const focused = layout.groups[layout.focusedGroupId];
                            const tab = focused ? layout.tabs[focused.activeTabId] : null;
                            return tab ? [tab.target] : [];
                        });
                    }).toEqual(expect.arrayContaining([{ kind: 'session', params: { id: session.split('/').at(-1) } }]));
                    await expect.poll(readAccountTabTargets).toEqual(expect.arrayContaining([
                        { kind: 'session', params: { id: session.split('/').at(-1) } },
                    ]));
                    await page.goto(`${origin}${href}`);
                }
                await page.addScriptTag({ url: `${origin}/bundle.js` });
                await page.evaluate(seed => (window as BrowserFixture).startupHarness.mount(seed, true), phase === 'cold load');
                await page.waitForFunction(() => (window as BrowserFixture).startupHarness.readHomeGate().requests > 0);
                expect(await page.evaluate(() => (window as BrowserFixture).startupHarness.readHomeGate())).toMatchObject({ isDataReady: false });
                expect(new URL(page.url()).pathname, `${phase} Home-unready`).toBe(new URL(href, origin).pathname);
                await page.evaluate(() => (window as BrowserFixture).startupHarness.releaseHome());
                await page.waitForFunction(id => document.querySelector(`[data-testid="${id}"]`) !== null
                    || window.location.pathname.startsWith('/session/')
                    || document.querySelector('[data-testid="app-crash-copy-details"]') !== null
                    || (window.location.pathname === '/' && new URLSearchParams(window.location.search).has('runId')), readyId);
                expect(await page.getByTestId('app-crash-copy-details').count(), `${phase} app bootstrap crash`).toBe(0);
                const location = new URL(page.url());
                expect(`${location.pathname}${location.search}`, phase).toBe(href);
                await page.getByTestId(readyId).waitFor();
                await expect.poll(() => page.evaluate(() => (window as BrowserFixture).startupHarness.readPersistenceState().isDataReady)).toBe(true);
                expect(await page.evaluate(() => (window as BrowserFixture).startupHarness.readBootstrapStates()))
                    .toEqual(expect.arrayContaining([expect.objectContaining({ isDataReady: false }), expect.objectContaining({ isDataReady: true })]));
                if (href === runPath) {
                    await page.getByTestId('workflow-run-loading').waitFor({ state: 'detached' });
                    expect(await page.getByTestId('workflow-run-load-failed').count()).toBe(0);
                }
                const writes = await page.evaluate(() => (window as BrowserFixture).startupHistory);
                const expected = new URL(href, origin);
                // Expo can momentarily duplicate dynamic path params in the query.
                // Preserve the workflow path and every original query value throughout.
                expect(writes.filter(write => {
                    const written = new URL(write.after, origin);
                    return written.pathname !== expected.pathname || [...expected.searchParams.keys()].some(key =>
                        JSON.stringify(written.searchParams.getAll(key)) !== JSON.stringify(expected.searchParams.getAll(key)));
                }), phase).toEqual([]);
                if (phase === 'cold load') {
                    const persistence = await page.evaluate(() => (window as BrowserFixture).startupHarness.readPersistenceState());
                    console.info('Startup persisted owner readiness', { width, href, ...persistence });
                    await expect.poll(() => page.evaluate(() => (window as BrowserFixture).startupHarness.listWorkspace())).toMatchObject({ ok: true });
                    for (const prior of ['/', '/session/10000000-0000-4000-8000-000000000003', href]) {
                        expect(await page.evaluate(path => (window as BrowserFixture).startupHarness.openWorkspace(path), prior)).toMatchObject({ ok: true });
                        await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(prior, origin).pathname);
                    }
                    await page.getByTestId(readyId).waitFor();
                    // These real Actions seed the returning Account, not merely
                    // local history. Do not reload before its queued KV write.
                    await expect.poll(readAccountTabTargets).toEqual(expect.arrayContaining([
                        { kind: 'session', params: { id: '10000000-0000-4000-8000-000000000003' } },
                    ]));
                }
            }
        } catch (error) {
            const history = await page.evaluate(() => (window as BrowserFixture).startupHistory);
            const unserved = await page.evaluate(() => (window as BrowserFixture).startupHarness?.readUnservedHttpPaths());
            const workspace = await page.evaluate(() => (window as BrowserFixture).startupHarness?.listWorkspace());
            const kv = { row: accountKv.read('workspace:tabs:v1'), requests: accountKv.readRequests() };
            const body = await page.locator('body').innerText();
            const bundleLine = /bundle\.js:(\d+):\d+/.exec(body)?.[1];
            const source = bundleLine ? script.split('\n').slice(Number(bundleLine) - 3, Number(bundleLine) + 3).join('\n') : '';
            throw appendBrowserDiagnostics(error, `${diagnostics()}\nHistory writes:\n${JSON.stringify(history, null, 2)}\nUnserved HTTP paths:\n${JSON.stringify(unserved)}\nWorkspace/KV facts:\n${JSON.stringify({ workspace, kv })}\nBody:\n${body}\nFirst error bundle source:\n${source}`);
        } finally { await browser.close(); }
    });
});
