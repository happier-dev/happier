import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
    startExistingUiWebExport,
    startUiWeb,
    type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import {
    sanitizeDaemonEnvForSpawn,
    startTestDaemon,
    type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { createGitRepoWithChanges } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { repoRootDir } from '../../src/testkit/paths';
import {
    decideAuthenticatedPluginInstallReview,
    readPluginInstallReviewRequiredEnvelope,
} from '../../src/testkit/pluginPlatform/authenticatedInstallReview';
import {
    parseJsonEnvelope,
    runPackedCli,
    runPackedCliJson,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';

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
    if (await createAccount.count()) {
        await createAccountAndReachConnectMachineState({ page });
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
            HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED: 'false',
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_VARIANT: 'dev',
        },
    });

    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();

    const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: cliHomeDir,
        env: {
            ...process.env,
            CI: '1',
            HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED: 'false',
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

        // Prefer symbolication for the deepest (highest line number) frame, which usually points at
        // the actual app code that triggered the state update loop (not React internals).
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

    // Some daemon filesystem policies expose a restricted set of browse roots (for example `/Users/<name>`)
    // instead of a true `/` root. Expand `/` when available, but don't require it.
    const rootToggle = page.getByTestId('path-browser-toggle:/');
    if (await rootToggle.count()) {
        await rootToggle.first().scrollIntoViewIfNeeded();
        await rootToggle.first().click({ force: true });
    }

    // Expand parent directories for the target path (portable across macOS/Linux).
    const normalizedPath = absolutePath.replace(/\\/g, '/').replace(/\/+$/g, '');
    if (normalizedPath.startsWith('/')) {
        const segments = normalizedPath.split('/').filter(Boolean);
        let current = '';
        for (const segment of segments.slice(0, Math.max(0, segments.length - 1))) {
            current += `/${segment}`;
            const toggle = page.getByTestId(`path-browser-toggle:${current}`);
            if (await toggle.count()) {
                await toggle.first().scrollIntoViewIfNeeded();
                await toggle.first().click({ force: true });
            }
        }
    }

    const targetRow = page.getByTestId(`path-browser-row:${absolutePath}`).first();
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

function getTerminalInput(page: Page, testId: string) {
    return page.getByTestId(testId).locator('textarea').first();
}

function toShellPrintfOctalCommand(text: string): string {
    const encoded = Array.from(Buffer.from(`${text}\n`, 'utf8'))
        .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
        .join('');
    return `printf '${encoded}'`;
}

async function pasteIntoTerminal(page: Page, params: Readonly<{ testId: string; baseUrl: string; text: string }>) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: new URL(params.baseUrl).origin,
    });
    await page.evaluate(async (value) => {
        if (!navigator.clipboard?.writeText) {
            throw new Error('clipboard writeText is unavailable');
        }
        await navigator.clipboard.writeText(value);
    }, params.text);

    await page.getByTestId(params.testId).click();
    await page.keyboard.press('ControlOrMeta+V');
}

async function expectTerminalTranscriptToContain(page: Page, testId: string, needle: string) {
    const terminal = page.getByTestId(testId);
    await expect(terminal).toHaveCount(1, { timeout: 180_000 });
    await expect
        .poll(async () => await terminal.getAttribute('data-happier-terminal-text'), { timeout: 60_000 })
        .toContain(needle);
}

test.describe('ui e2e: projects (workspaces) details + files/scm/terminal', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('projects-workspace-details-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
    const keepProcsOnFailure = String(process.env.HAPPIER_E2E_KEEP_PROCS_ON_FAILURE ?? '').trim() === '1';

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(900_000);
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

        const uiEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-projects`,
        };
        const existingUiDistDir = process.env.HAPPIER_E2E_UI_WEB_EXISTING_DIST_DIR?.trim() ?? '';
        ui = existingUiDistDir
            ? await startExistingUiWebExport({
                testDir: suiteDir,
                env: uiEnv,
                distDir: existingUiDistDir,
            })
            : await startUiWeb({
                testDir: suiteDir,
                env: uiEnv,
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
            // Local debugging helper: keep metro + server running so the failing bundle and sourcemaps
            // can be inspected after the test aborts. CI should not set this.
            return;
        }
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('can add a project via path browser and open SCM + terminal', async ({ page }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const testDir = resolve(join(suiteDir, `t1-${randomUUID()}`));
        await mkdir(testDir, { recursive: true });

        await page.setViewportSize({ width: 1440, height: 900 });
        daemon = await ensureSignedInAndConnected({
            page,
            server,
            uiBaseUrl,
            suiteDir,
            cliHomeDir,
            flowDirName: 't1-connect',
        });

        // Prime server-scoped state before starting the Projects flow. Some screens can render before
        // the active server snapshot is fully resolved, and the Projects add flow requires a server id.
        await page.goto(`${uiBaseUrl}/new`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 180_000 });
        // Desktop discoverability contract: the sidebar must expose a Projects entry point.
        await expect(page.getByTestId('nav-projects')).toHaveCount(1, { timeout: 180_000 });

        // Keep the repo under HOME so the daemon's filesystem access policy (allowed directories) permits SCM ops.
        const homeDir = process.env.HOME ? resolve(process.env.HOME) : suiteDir;
        const repoDir = resolve(join(homeDir, 'happier-ui-e2e-projects', `happier-ui-e2e-project-${randomUUID()}`));
        await mkdir(repoDir, { recursive: true });
        await createGitRepoWithChanges({ repoDir, fileCount: 6 });

        await page.goto(`${uiBaseUrl}/projects`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('projects-list')).toHaveCount(1, { timeout: 120_000 });

        // Empty state: click the first machine row to start adding a project.
        await page.locator('[data-testid^="projects-add-first-machine:"]').first().click();
        await selectWorkspacePathFromPathBrowserModal(page, repoDir);

        await expect
            .poll(() => parseWorkspaceRefIdFromProjectsUrl(page.url()), { timeout: 60_000 })
            .not.toBeNull();
        const workspaceRefId = parseWorkspaceRefIdFromProjectsUrl(page.url());
        if (!workspaceRefId) {
            throw new Error(`Failed to parse workspaceRefId from url after adding project: ${page.url()}`);
        }

        await expect(page.getByTestId('workspace-details-panel-root')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('project-right-panel-root')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('project-rightpanel-tab:files').click();
        await expect(page.getByTestId('project-rightpanel-surface-files')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('workspace-repository-tree-error')).toHaveCount(0, { timeout: 1 });

        await page.getByTestId('project-rightpanel-tab:git').click();
        await expect(page.getByTestId('project-rightpanel-surface-git')).toBeVisible({ timeout: 120_000 });
        await expect(page.locator('[data-testid^="scm-change-row-"]').first()).toHaveCount(1, { timeout: 180_000 });
        await page.locator('[data-testid^="scm-change-row-"]').first().click();

        // Open terminal from the workspace details panel header.
        await page.getByTestId('workspace-details-open-terminal').click();
        await expect(page.getByTestId('workspace-embedded-terminal-root')).toHaveCount(1, { timeout: 180_000 });

        const xtermTestId = 'workspace-embedded-terminal-xterm';
        const terminalInput = getTerminalInput(page, xtermTestId);
        await expect(terminalInput).toHaveCount(1, { timeout: 60_000 });
        await terminalInput.focus();

        const marker = 'happier-project-terminal-e2e';
        await pasteIntoTerminal(page, {
            testId: xtermTestId,
            baseUrl: uiBaseUrl,
            text: toShellPrintfOctalCommand(marker),
        });
        await page.keyboard.press('Enter');

        await expectTerminalTranscriptToContain(page, xtermTestId, marker);
    });

    test('renders daemon-projected SCM backends and opens projected hosting authentication', async ({ page }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        const testDir = resolve(join(suiteDir, 't2-source-control-settings'));
        await mkdir(testDir, { recursive: true });
        const cliLaunchSpec = {
            command: process.execPath,
            args: [resolve(repoRootDir(), 'apps/cli/bin/happier.mjs')],
            cwd: repoRootDir(),
        };
        const cliCommandEnv = sanitizeDaemonEnvForSpawn({
            ...process.env,
            HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED: 'false',
        });
        daemon = await authenticateAndStartDaemon({
            page,
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            uiBaseUrl,
            extraEnv: {
                HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED: 'false',
            },
            cliLaunchSpec,
            variant: 'stable',
        });

        const externalArtifactPath = process.env.HAPPIER_SCM_EXTERNAL_ARTIFACT?.trim() ?? '';
        if (externalArtifactPath) {
            const installResult = await runPackedCli({
                cliEntrypoint: cliLaunchSpec.args[0]!,
                cwd: cliLaunchSpec.cwd,
                env: {
                    ...cliCommandEnv,
                    CI: '1',
                    HAPPIER_HOME_DIR: cliHomeDir,
                    HAPPIER_SERVER_URL: server.baseUrl,
                    HAPPIER_WEBAPP_URL: uiBaseUrl,
                    HAPPIER_VARIANT: 'stable',
                },
                args: ['plugins', 'install', externalArtifactPath, '--json'],
            });
            expect(installResult.code).not.toBe(0);
            expect(installResult.signal).toBeNull();
            const installReview = readPluginInstallReviewRequiredEnvelope(
                parseJsonEnvelope(installResult.stdout, 'plugins_install_review'),
            );
            const installOutcome = await decideAuthenticatedPluginInstallReview({
                cliHomeDir,
                serverUrl: server.baseUrl,
                pendingChangeId: installReview.pendingChangeId,
                optionalSelections: installReview.review.optionalHostAccess.map((entry) => ({
                    accessId: entry.id,
                    selected: false,
                })),
                confirmPresentUser: async () => true,
            });
            expect(installOutcome).toMatchObject({
                kind: 'committed',
                pluginId: installReview.review.pluginId,
            });
        }

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/source-control`, 180_000);

        await expect(page.getByText('Git', { exact: true })).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByText('Sapling', { exact: true })).toHaveCount(1, { timeout: 120_000 });

        const projectedGithubProvider = page.getByText('GitHub', { exact: true });
        await expect(projectedGithubProvider).toHaveCount(1, { timeout: 120_000 });
        await projectedGithubProvider.click();
        await expect(page).toHaveURL(/\/settings\/connected-services\/github(?:[/?#]|$)/, {
            timeout: 60_000,
        });

        if (externalArtifactPath) {
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/source-control`, 180_000);
            await expect(page.getByText('Packed Stacked SCM', { exact: true }))
                .toHaveCount(1, { timeout: 120_000 });
            await expect(page.getByText('Packed Forge', { exact: true }))
                .toHaveCount(1, { timeout: 120_000 });
            await page.getByText('Packed Stacked SCM', { exact: true }).click();
            const packedPendingDiffSetting = page.getByText(
                'Packed Stacked SCM default diff: Pending',
                { exact: true },
            );
            await expect(packedPendingDiffSetting).toHaveCount(1);
            await packedPendingDiffSetting.click();

            await page.getByText('Packed Forge', { exact: true }).click();
            await expect(page).toHaveURL(/\/settings\/connected-services\/forge(?:[/?#]|$)/, {
                timeout: 60_000,
            });
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/source-control`, 180_000);

            const uninstall = await runPackedCliJson({
                cliEntrypoint: cliLaunchSpec.args[0]!,
                cwd: cliLaunchSpec.cwd,
                env: {
                    ...cliCommandEnv,
                    CI: '1',
                    HAPPIER_HOME_DIR: cliHomeDir,
                    HAPPIER_SERVER_URL: server.baseUrl,
                    HAPPIER_WEBAPP_URL: uiBaseUrl,
                    HAPPIER_VARIANT: 'stable',
                },
                args: ['plugins', 'uninstall', 'acme.vertical-a', '--json'],
            }, 'plugins_uninstall');
            expect(uninstall.ok).toBe(true);
            expect(uninstall.kind).toBe('plugins_uninstall');

            const sourceControlSettingsUrl = `${uiBaseUrl}/settings/source-control`;
            await expect.poll(
                async () => {
                    await gotoDomContentLoadedWithRetries(
                        page,
                        sourceControlSettingsUrl,
                        30_000,
                    );
                    return {
                        externalBackendCount: await page
                            .getByText('Packed Stacked SCM', { exact: true })
                            .count(),
                        externalHostingProviderCount: await page
                            .getByText('Packed Forge', { exact: true })
                            .count(),
                        gitCount: await page.getByText('Git', { exact: true }).count(),
                    };
                },
                { timeout: 120_000 },
            ).toEqual({
                externalBackendCount: 0,
                externalHostingProviderCount: 0,
                gitCount: 1,
            });
            await expect(page.getByText('Packed Stacked SCM', { exact: true })).toHaveCount(0);
            await expect(page.getByText('Packed Forge', { exact: true })).toHaveCount(0);
            await expect(page.getByText('Git', { exact: true })).toHaveCount(1, {
                timeout: 120_000,
            });
        }
    });
});
