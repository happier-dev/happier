import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
    createAccountAndReachConnectMachineState,
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
    waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function buildCatalogResponse(params: Readonly<{
    sourceUrl: string;
    title: string;
    description: string;
    entries: ReadonlyArray<{
        pluginId: string;
        title: string;
        description?: string;
        version?: string;
        entryId?: string;
        sourceUrl?: string;
        packageUrl?: string;
        categories?: readonly string[];
    }>;
}>): object {
    return {
        t: 'happier_plugin_marketplace_catalog_v1',
        schemaVersion: 1,
        sourceUrl: params.sourceUrl,
        title: params.title,
        description: params.description,
        entries: params.entries.map((entry) => ({
            id: entry.entryId ?? `marketplace.${entry.pluginId}`,
            manifestId: entry.pluginId,
            title: entry.title,
            description: entry.description,
            version: entry.version,
            sourceUrl: entry.sourceUrl ?? `${params.sourceUrl}#${entry.pluginId}`,
            packageUrl: entry.packageUrl ?? `${params.sourceUrl.replace(/\/catalog\.json$/, '')}/${entry.pluginId}.tgz`,
            categories: entry.categories ?? [],
        })),
    };
}

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

test.describe('ui e2e: settings plugin marketplace', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('settings-plugins-marketplace-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-plugins-${run.runId}`,
            HAPPIER_E2E_UI_WEB_MODE: 'export',
            HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
            HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: '900000',
            HAPPIER_E2E_UI_WEB_EXPORT_WORKSPACE_PREBUILD_TIMEOUT_MS: '900000',
            HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '300000',
        };

        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(suiteDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...uiWebEnv,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(60_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('opens the marketplace screen from settings and keeps the last catalog visible during refresh', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) throw new Error('missing fixtures');

        const firstCatalogUrl = `${uiBaseUrl}/plugins-a.json`;
        const secondCatalogUrl = `${uiBaseUrl}/plugins-b.json`;

        const secondCatalogGate = createDeferred();

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await createAccountAndReachConnectMachineState({ page });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings?happier_hmr=0`, 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings',
            requiredTestIds: ['settings-plugin-marketplace-item'],
            timeoutMs: 120_000,
        });

        await page.getByTestId('settings-plugin-marketplace-item').click();
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/plugins',
            requiredTestIds: [
                'settings.plugins.marketplace.catalogUrl',
                'settings.plugins.marketplace.loadCatalog',
            ],
            timeoutMs: 120_000,
        });

        await page.route(firstCatalogUrl, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: {
                    'access-control-allow-origin': '*',
                    'cache-control': 'no-store',
                },
                body: JSON.stringify(buildCatalogResponse({
                    sourceUrl: firstCatalogUrl,
                    title: 'Curated plugins',
                    description: 'Descriptor-only plugin discovery',
                    entries: [
                        {
                            pluginId: 'sample-plugin',
                            title: 'Sample Plugin',
                            description: 'Shows descriptor metadata',
                            version: '1.2.3',
                            packageUrl: `${uiBaseUrl}/sample-plugin.tgz`,
                        },
                    ],
                })),
            });
        });

        await page.route(secondCatalogUrl, async (route) => {
            await secondCatalogGate.promise;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: {
                    'access-control-allow-origin': '*',
                    'cache-control': 'no-store',
                },
                body: JSON.stringify(buildCatalogResponse({
                    sourceUrl: secondCatalogUrl,
                    title: 'Curated plugins refreshed',
                    description: 'Descriptor-only plugin discovery refresh',
                    entries: [
                        {
                            pluginId: 'replacement-plugin',
                            title: 'Replacement Plugin',
                            description: 'Shows the refreshed catalog',
                            version: '2.0.0',
                            packageUrl: `${uiBaseUrl}/replacement-plugin.tgz`,
                        },
                    ],
                })),
            });
        });

        const catalogUrlInput = page.getByTestId('settings.plugins.marketplace.catalogUrl');
        const loadCatalogButton = page.getByTestId('settings.plugins.marketplace.loadCatalog');

        await catalogUrlInput.fill(firstCatalogUrl);
        await expect(loadCatalogButton).toBeEnabled({ timeout: 60_000 });
        await loadCatalogButton.click();

        const sampleEntry = page.getByTestId('settings.plugins.marketplace.entry.sample-plugin');
        await expect(sampleEntry).toHaveCount(1, { timeout: 120_000 });
        await expect(sampleEntry.getByRole('button')).toHaveCount(0);

        await catalogUrlInput.fill(secondCatalogUrl);
        await expect(loadCatalogButton).toBeEnabled({ timeout: 60_000 });
        await loadCatalogButton.click();

        await expect(sampleEntry).toHaveCount(1, { timeout: 60_000 });

        secondCatalogGate.resolve();

        const replacementEntry = page.getByTestId('settings.plugins.marketplace.entry.replacement-plugin');
        await expect(replacementEntry).toHaveCount(1, { timeout: 120_000 });
        await expect(replacementEntry.getByRole('button')).toHaveCount(0);
        await expect(sampleEntry).toHaveCount(0, { timeout: 60_000 });
    });
});
