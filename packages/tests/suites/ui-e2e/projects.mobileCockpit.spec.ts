import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { createGitRepoWithChanges } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import {
    captureAuthBootstrapStorageSnapshot,
    installAuthBootstrapStorageSnapshot,
} from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function ensureSignedInAndConnected(params: Readonly<{
    page: Page;
    server: StartedServer;
    uiBaseUrl: string;
    suiteDir: string;
    cliHomeDir: string;
    flowDirName: string;
}>): Promise<StartedDaemon> {
    const { page, server, uiBaseUrl, suiteDir, cliHomeDir, flowDirName } = params;

    await gotoDomContentLoadedWithRetries(page, uiBaseUrl, 420_000);
    await waitForInitialAppUi({ page, timeoutMs: 420_000 });

    const createAccount = page.getByTestId('welcome-create-account');
    let authBootstrapSnapshot = await captureAuthBootstrapStorageSnapshot(page).catch(() => null);
    if (await createAccount.count()) {
        await createAccountAndReachConnectMachineState({ page });
        authBootstrapSnapshot = await captureAuthBootstrapStorageSnapshot(page);
    }

    const testDir = resolve(join(suiteDir, flowDirName));
    await mkdir(testDir, { recursive: true });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: {
            ...process.env,
            CI: '1',
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_VARIANT: 'dev',
        },
    });

    if (authBootstrapSnapshot) {
        await installAuthBootstrapStorageSnapshot(page, authBootstrapSnapshot);
    }
    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await approveTerminalConnect({ page });
    await cliLogin.waitForSuccess();

    const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: cliHomeDir,
        env: {
            ...process.env,
            CI: '1',
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_HOME_DIR: cliHomeDir,
            HAPPIER_SERVER_URL: server.baseUrl,
            HAPPIER_WEBAPP_URL: uiBaseUrl,
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_VARIANT: 'dev',
        },
    });

    await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });

    await expect
        .poll(
            async () => {
                const createCount = await page.getByTestId('session-getting-started-kind-create_session').count();
                const selectCount = await page.getByTestId('session-getting-started-kind-select_session').count();
                return createCount > 0 || selectCount > 0;
            },
            { timeout: 180_000 },
        )
        .toBe(true);

    return daemon;
}

async function selectWorkspacePathFromPathBrowserModal(page: Page, absolutePath: string): Promise<void> {
    const modal = page.getByTestId('path-browser-modal');
    const crashCopyButton = page.getByRole('button', { name: /copy error details/i });

    async function describeCrashDetails(): Promise<string> {
        const detailsText = await page
            .locator('text=/Maximum update depth exceeded/i')
            .first()
            .textContent()
            .catch(() => null);

        const raw = String(detailsText ?? '').trim();
        if (!raw) return 'unknown error';

        const matches = Array.from(raw.matchAll(/(https?:\/\/[^\s)]+\.bundle\?[^\s):]+):(\d+):(\d+)/g));
        if (matches.length === 0) return raw;

        const best = matches.reduce((acc, current) => {
            const currentLine = current[2] ? Number.parseInt(current[2], 10) : Number.NaN;
            const accLine = acc[2] ? Number.parseInt(acc[2], 10) : Number.NaN;
            if (!Number.isFinite(accLine)) return current;
            if (!Number.isFinite(currentLine)) return acc;
            return currentLine >= accLine ? current : acc;
        }, matches[matches.length - 1]!);

        const bundleUrl = best[1] ?? null;
        const lineNumber = best[2] ? Number.parseInt(best[2], 10) : NaN;
        const column = best[3] ? Number.parseInt(best[3], 10) : NaN;

        if (!bundleUrl || !Number.isFinite(lineNumber) || !Number.isFinite(column)) {
            return raw;
        }

        let symbolicated: string | null = null;
        let symbolicateDebug: string | null = null;
        try {
            const base = new URL(bundleUrl);
            base.pathname = '/symbolicate';
            base.search = '';

            const res = await fetch(base.toString(), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    stack: [
                        {
                            file: bundleUrl,
                            methodName: '<error>',
                            lineNumber,
                            column,
                        },
                    ],
                }),
                signal: AbortSignal.timeout(2_000),
            });

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                symbolicateDebug = `symbolicate_http_${res.status}:${body.slice(0, 500)}`;
            }

            const json = await res.json().catch(() => null);
            const top = json?.stack?.[0];
            if (top && typeof top.file === 'string') {
                symbolicated = `${top.file}:${top.lineNumber ?? '?'}:${top.column ?? '?'} ${top.methodName ?? ''}`.trim();
            } else if (json) {
                symbolicateDebug = `symbolicate_unexpected_response:${JSON.stringify(json).slice(0, 800)}`;
            }
        } catch (error) {
            symbolicateDebug = `symbolicate_exception:${error instanceof Error ? error.message : String(error)}`;
        }

        if (symbolicated) return `${raw}\nSymbolicated: ${symbolicated}`;
        if (symbolicateDebug) return `${raw}\nSymbolicateDebug: ${symbolicateDebug}`;
        return raw;
    }

    const startedAt = Date.now();
    const timeoutMs = 60_000;
    while (Date.now() - startedAt < timeoutMs) {
        if (await modal.count()) break;
        if (await crashCopyButton.count()) {
            const errorDetails = await describeCrashDetails();
            throw new Error(`UI crashed while opening path browser modal: ${errorDetails}`);
        }
        await page.waitForTimeout(250);
    }

    await expect(modal).toHaveCount(1, { timeout: 1_000 });
    const searchInput = modal.getByRole('textbox', { name: 'Search files...' }).first();

    const rootToggle = page.getByTestId('path-browser-toggle:/');
    if (await rootToggle.count()) {
        await rootToggle.first().scrollIntoViewIfNeeded();
        await rootToggle.first().click({ force: true });
    }

    const normalizedPath = absolutePath.replace(/\\/g, '/').replace(/\/+$/g, '');
    if (normalizedPath.startsWith('/')) {
        const segments = normalizedPath.split('/').filter(Boolean);
        let current = '';
        for (const segment of segments.slice(0, Math.max(0, segments.length - 1))) {
            current += `/${segment}`;
            await searchInput.fill(segment);
            const toggle = page.getByTestId(`path-browser-toggle:${current}`);
            if (await toggle.count()) {
                await toggle.first().scrollIntoViewIfNeeded();
                await toggle.first().click({ force: true });
            }
            await searchInput.fill('');
        }
    }

    const targetSegment = normalizedPath.split('/').filter(Boolean).at(-1) ?? normalizedPath;
    await searchInput.fill(targetSegment);
    const targetRow = page.getByTestId(`path-browser-row:${normalizedPath}`).first();
    await expect(targetRow).toHaveCount(1, { timeout: 60_000 });
    await targetRow.scrollIntoViewIfNeeded();
    await targetRow.click({ force: true });

    const confirmButton = page.getByTestId('path-browser-confirm').first();
    await expect(confirmButton).toBeEnabled({ timeout: 30_000 });
    await confirmButton.scrollIntoViewIfNeeded();
    await confirmButton.click({ force: true });

    await expect(page.getByTestId('path-browser-modal')).toHaveCount(0, { timeout: 60_000 });
}

function parseWorkspaceRefIdFromProjectsUrl(url: string): string | null {
    try {
        const pathname = new URL(url).pathname;
        const parts = pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('projects');
        const candidate = idx >= 0 ? parts[idx + 1] : null;
        const decoded = candidate ? decodeURIComponent(candidate) : '';
        return decoded && decoded.length > 0 ? decoded : null;
    } catch {
        return null;
    }
}

async function expectPathname(page: Page, pathname: string): Promise<void> {
    await expect.poll(async () => new URL(page.url()).pathname, { timeout: 60_000 }).toBe(pathname);
}

test.describe('ui e2e: projects mobile cockpit', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('projects-mobile-cockpit-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
    const keepProcsOnFailure = String(process.env.HAPPIER_E2E_KEEP_PROCS_ON_FAILURE ?? '').trim() === '1';

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-projects-mobile-cockpit`,
            HAPPIER_E2E_UI_WEB_MODE: 'export',
            HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '900000',
            HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS:
                process.env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS ?? '600000',
            HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS:
                process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
        };
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(cliHomeDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
                HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
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

    test.afterEach(async () => {
        await daemon?.stop().catch(() => {});
        daemon = null;
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        if (keepProcsOnFailure) {
            return;
        }
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('enters cockpit from a classic project route and switches the mobile surfaces', async ({ page }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const testDir = resolve(join(suiteDir, `t1-${randomUUID()}`));
        await mkdir(testDir, { recursive: true });

        await page.setViewportSize({ width: 430, height: 932 });
        daemon = await ensureSignedInAndConnected({
            page,
            server,
            uiBaseUrl,
            suiteDir,
            cliHomeDir,
            flowDirName: 't1-connect',
        });

        await page.goto(`${uiBaseUrl}/new`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 180_000 });

        const homeDir = process.env.HOME ? resolve(process.env.HOME) : suiteDir;
        const repoDir = resolve(join(homeDir, 'happier-ui-e2e-projects', `happier-ui-e2e-project-${randomUUID()}`));
        await mkdir(repoDir, { recursive: true });
        await createGitRepoWithChanges({ repoDir, fileCount: 6 });

        await page.goto(`${uiBaseUrl}/projects`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('projects-list')).toHaveCount(1, { timeout: 120_000 });
        await page.locator('[data-testid^="projects-add-first-machine:"]').first().click();
        await selectWorkspacePathFromPathBrowserModal(page, repoDir);

        await expect.poll(() => parseWorkspaceRefIdFromProjectsUrl(page.url()), { timeout: 60_000 }).not.toBeNull();
        const workspaceRefId = parseWorkspaceRefIdFromProjectsUrl(page.url());
        if (!workspaceRefId) {
            throw new Error(`Failed to parse workspaceRefId from url after adding project: ${page.url()}`);
        }

        await expect(page.getByTestId('project-right-panel-root')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('project-rightpanel-surface-files')).toHaveCount(1, { timeout: 120_000 });

        await expectPathname(page, `/projects/${workspaceRefId}/files`);

        await page.getByTestId('project-mobile-header-toggle-workspace-experience').click();
        await expect(page.getByTestId(`project-cockpit-tabbar-${workspaceRefId}`)).toHaveCount(1, { timeout: 120_000 });
        await expectPathname(page, `/projects/${workspaceRefId}/files`);
        await expect(page.getByTestId('repository-tree-toolbar')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('project-cockpit-tab-overview').click();
        await expectPathname(page, `/projects/${workspaceRefId}`);
        await expect(page.getByTestId('workspace-details-panel-root')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('project-mobile-header-open-worktrees').click();
        await expectPathname(page, `/projects/${workspaceRefId}`);
        await expect
            .poll(async () => new URL(page.url()).searchParams.get('showWorktrees'), { timeout: 60_000 })
            .toBe('1');
        await expect(page.getByTestId('workspace-details-panel-root')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('project-cockpit-tab-browse').click();
        await expectPathname(page, `/projects/${workspaceRefId}/files`);
        await expect(page.getByTestId('repository-tree-toolbar')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('repository-tree-row-README.md').first().click();
        await expectPathname(page, `/projects/${workspaceRefId}/files`);

        await page.getByTestId('project-cockpit-tab-tabs').click();
        await expectPathname(page, `/projects/${workspaceRefId}/details`);
        await expect(page.getByTestId('workspace-details-panel-root')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.locator('[data-testid^="workspace-details-tab-file_"]').first()).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('project-cockpit-tab-git').click();
        await expectPathname(page, `/projects/${workspaceRefId}/git`);
        const firstChangeRow = page.locator('[data-testid^="scm-change-row-"]').first();
        await expect(firstChangeRow).toHaveCount(1, { timeout: 180_000 });
        await firstChangeRow.click();

        await page.getByTestId('project-cockpit-tab-tabs').click();
        await expectPathname(page, `/projects/${workspaceRefId}/details`);
        await expect(page.getByTestId('workspace-details-panel-root')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.locator('[data-testid^="workspace-details-tab-file_"]').first()).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('project-cockpit-tab-git').click();
        await expectPathname(page, `/projects/${workspaceRefId}/git`);
        await page.getByTestId('project-mobile-header-toggle-workspace-experience').click();
        await expect(page.getByTestId(`project-cockpit-tabbar-${workspaceRefId}`)).toHaveCount(0, { timeout: 120_000 });
        await expectPathname(page, `/projects/${workspaceRefId}/git`);
        await expect(page.getByTestId('project-right-panel-root')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('project-mobile-header-toggle-workspace-experience').click();
        await expect(page.getByTestId(`project-cockpit-tabbar-${workspaceRefId}`)).toHaveCount(1, { timeout: 120_000 });
        await expectPathname(page, `/projects/${workspaceRefId}/git`);

        await page.getByTestId('project-cockpit-tab-terminal').click();
        await expectPathname(page, `/projects/${workspaceRefId}/terminal`);
        await expect(page.getByTestId('project-terminal-screen')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('workspace-embedded-terminal-root')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('workspace-embedded-terminal-xterm')).toHaveCount(1, { timeout: 120_000 });
    });

    test('persists the last project cockpit surface, keeps subroutes compatible, and opens history commits', async ({ page }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const testDir = resolve(join(suiteDir, `t2-${randomUUID()}`));
        await mkdir(testDir, { recursive: true });

        await page.setViewportSize({ width: 430, height: 932 });
        daemon = await ensureSignedInAndConnected({
            page,
            server,
            uiBaseUrl,
            suiteDir,
            cliHomeDir,
            flowDirName: 't2-connect',
        });

        await page.goto(`${uiBaseUrl}/new`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 180_000 });

        const homeDir = process.env.HOME ? resolve(process.env.HOME) : suiteDir;
        const repoDir = resolve(join(homeDir, 'happier-ui-e2e-projects', `happier-ui-e2e-project-${randomUUID()}`));
        await mkdir(repoDir, { recursive: true });
        await createGitRepoWithChanges({ repoDir, fileCount: 8 });

        await page.goto(`${uiBaseUrl}/projects`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('projects-list')).toHaveCount(1, { timeout: 120_000 });
        await page.locator('[data-testid^="projects-add-first-machine:"]').first().click();
        await selectWorkspacePathFromPathBrowserModal(page, repoDir);

        await expect.poll(() => parseWorkspaceRefIdFromProjectsUrl(page.url()), { timeout: 60_000 }).not.toBeNull();
        const workspaceRefId = parseWorkspaceRefIdFromProjectsUrl(page.url());
        if (!workspaceRefId) {
            throw new Error(`Failed to parse workspaceRefId from url after adding project: ${page.url()}`);
        }

        await page.getByTestId('project-mobile-header-toggle-workspace-experience').click();
        await expect(page.getByTestId(`project-cockpit-tabbar-${workspaceRefId}`)).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('project-cockpit-tab-terminal').click();
        await expectPathname(page, `/projects/${workspaceRefId}/terminal`);
        await expect(page.getByTestId('project-terminal-screen')).toHaveCount(1, { timeout: 120_000 });

        await page.goto(`${uiBaseUrl}/projects/${workspaceRefId}`, { waitUntil: 'domcontentloaded' });
        await expectPathname(page, `/projects/${workspaceRefId}`);
        await expect(page.getByTestId(`project-cockpit-tabbar-${workspaceRefId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('project-terminal-screen')).toHaveCount(1, { timeout: 120_000 });

        await page.goto(`${uiBaseUrl}/projects/${workspaceRefId}/git`, { waitUntil: 'domcontentloaded' });
        await expectPathname(page, `/projects/${workspaceRefId}/git`);
        await expect(page.getByTestId(`project-cockpit-tabbar-${workspaceRefId}`)).toHaveCount(1, { timeout: 120_000 });

        const historyTab = page.getByTestId('project-rightpanel-git-subtab:history');
        await expect(historyTab).toHaveCount(1, { timeout: 180_000 });
        await historyTab.click({ force: true });

        const historyCommit = page.locator('[data-testid^="scm-commit-entry-"]').first();
        await expect(historyCommit).toHaveCount(1, { timeout: 180_000 });
        await historyCommit.click({ force: true });

        await page.goto(`${uiBaseUrl}/projects/${workspaceRefId}/details`, { waitUntil: 'domcontentloaded' });
        await expectPathname(page, `/projects/${workspaceRefId}/details`);
        await expect(page.getByTestId(`project-cockpit-tabbar-${workspaceRefId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('workspace-details-panel-root')).toHaveCount(1, { timeout: 120_000 });
    });
});
