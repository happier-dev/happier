import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { createTestAuth } from '../../src/testkit/auth';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { writeRuntimeProjectionPluginFixture } from '../../src/testkit/extensions/localPackageFixture';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import {
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
    waitForAuthenticatedHomeUi,
    waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

const run = createRunDirs({ runLabel: 'ui-e2e' });

type StartedPluginCatalogServer = Readonly<{
    catalogUrl: string;
    close: () => Promise<void>;
}>;

const execFileAsync = promisify(execFile);

function buildServerScopedUiUrl(uiBaseUrl: string, serverBaseUrl: string, path: string = '/'): string {
    const url = new URL(path, uiBaseUrl.endsWith('/') ? uiBaseUrl : `${uiBaseUrl}/`);
    url.searchParams.set('server', serverBaseUrl);
    return url.toString();
}

async function createPluginArchive(params: Readonly<{
    pluginRoot: string;
    archivePath: string;
}>): Promise<void> {
    await execFileAsync('tar', [
        '-czf',
        params.archivePath,
        '-C',
        dirname(params.pluginRoot),
        basename(params.pluginRoot),
    ]);
}

async function startPluginCatalogServer(params: Readonly<{
    pluginId: string;
    archivePath: string;
}>): Promise<StartedPluginCatalogServer> {
    const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/catalog.json') {
            const address = server.address();
            if (!address || typeof address === 'string') {
                response.statusCode = 500;
                response.end('missing-address');
                return;
            }

            const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
            const catalogUrl = `${baseUrl}/catalog.json`;
            const archiveUrl = `${baseUrl}/plugins/${params.pluginId}.tar.gz`;
            response.statusCode = 200;
            response.setHeader('access-control-allow-origin', '*');
            response.setHeader('cache-control', 'no-store');
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: catalogUrl,
                title: 'UI E2E Plugin Catalog',
                description: 'Serves an archive-backed plugin fixture for browser + daemon install flows',
                entries: [
                    {
                        id: `marketplace.${params.pluginId}`,
                        manifestId: params.pluginId,
                        title: 'UI E2E Settings Plugin',
                        description: 'Catalog entry for the plugin details UI flow',
                        version: '1.0.0',
                        sourceUrl: `${baseUrl}/entries/${params.pluginId}.json`,
                        packageUrl: archiveUrl,
                        categories: ['plugins'],
                    },
                ],
            }));
            return;
        }

        if (request.method === 'GET' && request.url === `/plugins/${params.pluginId}.tar.gz`) {
            void (async () => {
                try {
                    const archiveBytes = await readFile(params.archivePath);
                    response.statusCode = 200;
                    response.setHeader('access-control-allow-origin', '*');
                    response.setHeader('cache-control', 'no-store');
                    response.setHeader('content-type', 'application/gzip');
                    response.setHeader('content-length', String(archiveBytes.byteLength));
                    response.end(archiveBytes);
                } catch {
                    response.statusCode = 500;
                    response.end('archive-read-failed');
                }
            })();
            return;
        }

        response.statusCode = 404;
        response.end();
    });

    await new Promise<void>((resolveListen, rejectListen) => {
        server.listen(0, '127.0.0.1', () => resolveListen());
        server.once('error', rejectListen);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('plugin_catalog_server_address_missing');
    }

    return {
        catalogUrl: `http://127.0.0.1:${(address as AddressInfo).port}/catalog.json`,
        close: async () => {
            await new Promise<void>((resolveClose) => {
                server.close(() => resolveClose());
            });
        },
    };
}

async function dismissSuccessAlert(page: Page): Promise<void> {
    const confirmByTestId = page.getByTestId('web-modal-confirm');
    try {
        await expect(confirmByTestId).toHaveCount(1, { timeout: 5_000 });
        await confirmByTestId.click();
        return;
    } catch {
        const okButton = page.getByRole('button', { name: 'OK' });
        await expect(okButton).toHaveCount(1, { timeout: 120_000 });
        await okButton.click();
    }
}

async function readPluginGenerationLabel(page: Page, pluginId: string): Promise<string> {
    const summary = page.getByTestId(`settings.plugins.detail.${pluginId}.summary`);
    await expect(summary).toHaveCount(1, { timeout: 120_000 });
    const text = (await summary.textContent())?.trim() ?? '';
    const match = text.match(/Generation\s*([0-9A-Za-z._-]+)/i);
    if (!match?.[1]) {
        throw new Error(`missing_generation_in_summary:${pluginId}:${text}`);
    }
    return match[1];
}

test.describe('ui e2e: plugin settings reload', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('settings-plugins-details-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let daemon: StartedDaemon | null = null;
    let uiBaseUrl: string | null = null;

    test.beforeAll(async () => {
        test.setTimeout(900_000);

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-plugins-details-${run.runId}`,
                HAPPIER_E2E_UI_WEB_MODE: 'metro',
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterEach(async () => {
        await daemon?.stop().catch(() => {});
        daemon = null;
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('installs an archive-backed plugin through the real daemon capability, suppresses mismatched-source updates, and reloads it from the detail route', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) {
            throw new Error('missing server/ui fixtures');
        }

        const testDir = resolve(join(suiteDir, 't1-plugin-details-install'));
        const cliHomeDir = resolve(join(testDir, 'cli-home'));
        const pluginRoot = resolve(join(testDir, 'plugin-root'));
        const pluginId = 'ui-e2e-settings-plugin';
        const pluginArchivePath = resolve(join(testDir, `${pluginId}.tar.gz`));
        const unrelatedCatalogUrl = `${uiBaseUrl}/plugin-update-mismatch.json`;

        await mkdir(testDir, { recursive: true });
        await mkdir(cliHomeDir, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });
        await writeRuntimeProjectionPluginFixture({
            pluginRoot,
            pluginId,
        });
        await createPluginArchive({
            pluginRoot,
            archivePath: pluginArchivePath,
        });

        const catalogServer = await startPluginCatalogServer({
            pluginId,
            archivePath: pluginArchivePath,
        });

        try {
            const auth = await createTestAuth(server.baseUrl);
            const machineKey = Uint8Array.from(randomBytes(32));
            const seeded = await seedCliDataKeyAuthForServer({
                cliHome: cliHomeDir,
                serverUrl: server.baseUrl,
                token: auth.token,
                machineKey,
            });

            await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
                serverUrl: server.baseUrl,
                credentials: {
                    token: auth.token,
                    encryption: {
                        publicKey: Buffer.from(seeded.publicKey).toString('base64'),
                        machineKey: Buffer.from(machineKey).toString('base64'),
                    },
                },
                storageScope: `e2e-settings-plugins-details-${run.runId}`,
            }));

            daemon = await startTestDaemon({
                testDir,
                happyHomeDir: cliHomeDir,
                snapshotDir: join(testDir, 'cli-dist'),
                env: {
                    ...process.env,
                    CI: '1',
                    HAPPIER_HOME_DIR: cliHomeDir,
                    HAPPIER_SERVER_URL: server.baseUrl,
                    HAPPIER_WEBAPP_URL: uiBaseUrl,
                    HAPPIER_DISABLE_CAFFEINATE: '1',
                    HAPPIER_VARIANT: 'dev',
                    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                    HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                    HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE: 'testdir',
                },
            });

            await gotoDomContentLoadedWithRetries(
                page,
                buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
                180_000,
            );
            await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
            await gotoDomContentLoadedWithRetries(
                page,
                buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/settings/plugins?happier_hmr=0'),
                180_000,
            );
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: '/settings/plugins',
                requiredTestIds: [
                    'settings.plugins.marketplace.catalogUrl',
                    'settings.plugins.marketplace.loadCatalog',
                ],
                timeoutMs: 120_000,
            });

            await page.route(unrelatedCatalogUrl, async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: {
                        'access-control-allow-origin': '*',
                        'cache-control': 'no-store',
                    },
                    body: JSON.stringify({
                        t: 'happier_plugin_marketplace_catalog_v1',
                        schemaVersion: 1,
                        sourceUrl: unrelatedCatalogUrl,
                        title: 'Mismatched update source',
                        description: 'Same plugin id from a different catalog origin',
                        entries: [
                            {
                                id: pluginId,
                                manifestId: pluginId,
                                title: 'UI E2E Settings Plugin',
                                description: 'Mismatched-source catalog entry',
                                version: '9.9.9',
                                sourceUrl: `${unrelatedCatalogUrl}#${pluginId}`,
                                packageUrl: `${unrelatedCatalogUrl.replace(/\\.json$/, '')}/${pluginId}.tar.gz`,
                                categories: ['plugins'],
                            },
                        ],
                    }),
                });
            });

            await page.getByTestId('settings.plugins.marketplace.catalogUrl').fill(catalogServer.catalogUrl);
            await expect(page.getByTestId('settings.plugins.marketplace.loadCatalog')).toBeEnabled({ timeout: 60_000 });
            await page.getByTestId('settings.plugins.marketplace.loadCatalog').click();

            await expect(page.getByTestId(`settings.plugins.marketplace.entry.${pluginId}`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.marketplace.action.install.${pluginId}`)).toBeEnabled({ timeout: 120_000 });
            await page.getByTestId(`settings.plugins.marketplace.action.install.${pluginId}`).click();

            await dismissSuccessAlert(page);

            await expect(page.getByTestId(`settings.plugins.marketplace.installed.${pluginId}`)).toHaveCount(1, { timeout: 120_000 });
            await page.getByTestId('settings.plugins.marketplace.catalogUrl').fill(unrelatedCatalogUrl);
            await expect(page.getByTestId('settings.plugins.marketplace.loadCatalog')).toBeEnabled({ timeout: 60_000 });
            await page.getByTestId('settings.plugins.marketplace.loadCatalog').click();
            await expect(page.getByTestId(`settings.plugins.marketplace.entry.${pluginId}`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.marketplace.action.update.${pluginId}`)).toHaveCount(0, { timeout: 60_000 });

            const installedRow = page.getByTestId(`settings.plugins.marketplace.installed.${pluginId}`);
            await installedRow.click({ position: { x: 40, y: 20 } });
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: `/settings/plugins/${pluginId}`,
                requiredTestIds: [
                    `settings.plugins.detail.${pluginId}.header`,
                    `settings.plugins.detail.${pluginId}.summary`,
                    `settings.plugins.detail.${pluginId}.action.reload`,
                ],
                timeoutMs: 120_000,
            });

            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.header`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.summary`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.action.reload`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.diagnostic.plugin_trust_approval_required.0`)).toHaveCount(1, { timeout: 120_000 });
            const initialGeneration = await readPluginGenerationLabel(page, pluginId);

            await page.getByTestId(`settings.plugins.detail.${pluginId}.action.reload`).click();
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.header`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.summary`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.action.reload`)).toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByTestId(`settings.plugins.detail.${pluginId}.diagnostic.plugin_trust_approval_required.0`)).toHaveCount(1, { timeout: 120_000 });
            await dismissSuccessAlert(page);
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: `/settings/plugins/${pluginId}`,
                requiredTestIds: [
                    `settings.plugins.detail.${pluginId}.header`,
                    `settings.plugins.detail.${pluginId}.summary`,
                    `settings.plugins.detail.${pluginId}.action.reload`,
                ],
                timeoutMs: 120_000,
            });
            const reloadedGeneration = await readPluginGenerationLabel(page, pluginId);
            expect(initialGeneration.length).toBeGreaterThan(0);
            expect(reloadedGeneration.length).toBeGreaterThan(0);
            expect(reloadedGeneration).not.toEqual(initialGeneration);
            await page.goBack();
            await waitForAuthenticatedRouteUi({
                page,
                expectedPathname: '/settings/plugins',
                requiredTestIds: [
                    `settings.plugins.marketplace.installed.${pluginId}`,
                    'settings.plugins.marketplace.catalogUrl',
                ],
                timeoutMs: 120_000,
            });
        } finally {
            await catalogServer.close().catch(() => {});
        }
    });
});
