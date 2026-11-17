import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkspaceHistoryBrowser } from '@/dev/testkit/render/buildWorkspaceHistoryBrowser.mjs';
import { workflowRouteStartupBrowserBuildTimeoutMs, workflowRouteStartupBrowserOptions } from '@/dev/testkit/render/workflowRouteStartupBrowserOptions';
import { createWorkspaceBrowserServer } from '@/dev/testkit/render/workspaceBrowserServer';
import { resolveChromiumExecutable } from '@/dev/testkit/render/measureWebLayout';
import { openLocalePreparation, prepareLocaleAssets } from '../../../../scripts/prepareLocaleAssets.mjs';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
import { readLibraryFixtureResponse } from '@/dev/testkit/fixtures/workflowLibraryHttpFixture';

// Router owns the inventory: new specimens join the cold-entry sweep automatically.
const devDirectory = new URL('../../../app/(app)/dev/', import.meta.url);
const devRoutes = readdirSync(devDirectory, { recursive: true }).filter((path): path is string =>
    typeof path === 'string' && path.endsWith('.tsx') && !/(?:^|\/)_layout\.|\.(?:test|spec)\./.test(path))
    .map(path => `/dev/${path.replace(/\.tsx$/, '').replace(/(?:^|\/)index$/, '')}`.replace(/\/$/, ''));

type ColdRootWindow = typeof window & { coldRootHarness: { seedCredentials(): Promise<void>; mount(): void } };
let script = '';
let origin = '';
let browser: Browser | undefined;
let persistedState: Awaited<ReturnType<BrowserContext['storageState']>>;
const server = createWorkspaceBrowserServer(() => script);

async function createColdContext(storageState?: typeof persistedState) {
    if (!browser) throw new Error('Missing startup browser');
    const context = await browser.newContext({ storageState });
    // Keep response fixtures outside the app realm: importing their schemas in
    // the browser before mounting could conceal a cold module-order failure.
    const transport = createWorkflowActionHttpTransport({ accountId: () => 'account-a', fixtureResponse: readLibraryFixtureResponse });
    await context.route(/\/(?:v\d|health)(?:\/|\?|$)/, async route => {
        const request = route.request();
        let response: Response;
        try {
            response = await transport.fetch(request.url(), { method: request.method(),
                headers: request.headers(), body: request.postData() ?? undefined });
        } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('Unexpected HTTP fixture route ')) throw error;
            response = Response.json({ error: 'route_not_found' }, { status: 404 });
        }
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()) });
    });
    return context;
}

beforeAll(async () => {
    const uiPackageDir = fileURLToPath(new URL('../../../../', import.meta.url));
    // The locale producer already owns retention during an active compiler.
    const preparation = await openLocalePreparation(`${uiPackageDir}/.expo/hstack/locales`);
    const localeOutput = await mkdtemp(join(uiPackageDir, '.expo/hstack/dev-cold-locales-'));
    const localeMap = join(localeOutput, 'localeAssets.js');
    try {
        // A concurrent publisher can replace the shared map while Metro reads it.
        // Use the producer's scoped output with its real retained locale bytes.
        await prepareLocaleAssets({ uiPackageDir, preparation, outputPath: localeMap });
        script = await buildWorkspaceHistoryBrowser({ ...workflowRouteStartupBrowserOptions,
            production: false, asyncRoutes: false, entryFile: 'sources/dev/testkit/render/devRouteColdStartupBrowserEntry.ts',
            // Packaged plugin bytes are an asset boundary; catalog/availability logic stays real.
            boundaryFiles: {
                'sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js':
                    'sources/dev/testkit/mocks/bundledPluginUiAssets.ts',
                'sources/text/localeAssets.generated.js': relative(uiPackageDir, localeMap),
            },
        });
    } finally {
        await preparation.close();
        await rm(localeOutput, { recursive: true, force: true });
    }
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing browser test address');
    origin = `http://127.0.0.1:${address.port}`;
    // Chromium's Unix-domain socket cannot fit the executor's long TMPDIR.
    browser = await chromium.launch({ executablePath: resolveChromiumExecutable(), env: { ...process.env, TMPDIR: '/tmp' } });
    const seedContext = await createColdContext();
    try {
        const page = await seedContext.newPage();
        await page.goto(origin);
        await page.addScriptTag({ url: `${origin}/bundle.js` });
        await page.evaluate(() => (window as ColdRootWindow).coldRootHarness.seedCredentials());
        persistedState = await seedContext.storageState();
    } finally { await seedContext.close(); }
}, workflowRouteStartupBrowserBuildTimeoutMs);

afterAll(async () => {
    await browser?.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    script = '';
});

it.each(devRoutes)('cold mounts the real root at %s', async pathname => {
    if (!browser) throw new Error('Missing startup browser');
    // Only persisted credentials survive. No Home or previous specimen warms this realm.
    const context = await createColdContext(persistedState);
    const page = await context.newPage();
    const errors: string[] = [];
    const consoleReads: Promise<void>[] = [];
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        errors.push(message.text());
        consoleReads.push(Promise.all(message.args().map(arg => arg.evaluate(value =>
            value instanceof Error ? value.stack : null))).then(stacks => {
            errors.push(...stacks.filter((stack): stack is string => typeof stack === 'string'));
        }));
    });
    try {
        await page.goto(`${origin}${pathname}?server=${encodeURIComponent(origin)}`);
        await page.addScriptTag({ url: `${origin}/bundle.js` });
        await page.evaluate(() => (window as ColdRootWindow).coldRootHarness.mount());
        await page.waitForFunction(() => document.getElementById('root')!.textContent!.length > 0);
        try {
            if (pathname === '/dev/companion') await page.getByTestId('specimen-plan').first().waitFor();
            else if (pathname === '/dev/session-states') await page.getByText('Model is no longer available', { exact: false }).first().waitFor();
        } catch (error) {
            await Promise.all(consoleReads);
            throw new Error(`${page.url()}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`, { cause: error });
        }
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await Promise.all(consoleReads);
        expect(new URL(page.url()).pathname).toBe(pathname);
        expect(errors.filter(error => /Cannot read properties|TypeError|FullAppRootLayout/.test(error))).toEqual([]);
        expect(await page.locator('body').innerText()).not.toMatch(/Something went wrong|Restart app/);
    } finally { await context.close(); }
}, workflowRouteStartupBrowserBuildTimeoutMs);
