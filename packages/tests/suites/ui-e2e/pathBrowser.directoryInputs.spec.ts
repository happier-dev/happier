import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function enableEnhancedSessionWizardInSettings(page: Page, baseUrl: string) {
    await page.goto(`${baseUrl}/settings/features`, { waitUntil: 'domcontentloaded' });
    const enhancedWizardToggle = page.getByTestId('settings-feature-toggle-useEnhancedSessionWizard');
    await expect(enhancedWizardToggle).toHaveCount(1, { timeout: 60_000 });
    await enhancedWizardToggle.click();
}

async function ensureSignedInAndConnected(params: Readonly<{
    page: Page;
    server: StartedServer;
    uiBaseUrl: string;
    suiteDir: string;
    cliHomeDir: string;
}>): Promise<StartedDaemon> {
    const { page, server, uiBaseUrl, suiteDir, cliHomeDir } = params;

    await gotoDomContentLoadedWithRetries(page, uiBaseUrl, 420_000);
    await waitForInitialAppUi({ page, timeoutMs: 420_000 });

    const createAccountByTestId = page.getByTestId('welcome-create-account');
    const createAccountByRole = page.getByRole('button', { name: 'Create account' });
    const createAccount =
        (await createAccountByTestId.count()) ? createAccountByTestId
            : (await createAccountByRole.count()) ? createAccountByRole
                : null;
    if (createAccount) {
        await createAccount.click({ timeout: 60_000, force: true });
        await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });
    }

    const testDir = resolve(join(suiteDir, 'connect-daemon'));
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

    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();

    try {
        const okButton = page.getByRole('button', { name: 'OK' });
        await expect(okButton).toBeVisible({ timeout: 5_000 });
        await okButton.click();
        await expect(okButton).toBeHidden({ timeout: 30_000 });
    } catch {
        // success dialog is optional
    }

    await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });

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

async function selectDirectoryFromPathBrowser(page: Page): Promise<string> {
    await expect(page.getByTestId('path-browser-modal')).toHaveCount(1, { timeout: 60_000 });
    const candidates = ['/tmp', '/Users'] as const;
    let visiblePath: string | null = null;

    const findVisibleCandidate = async () => {
        for (const candidate of candidates) {
            if (await page.getByTestId(`path-browser-row:${candidate}`).count()) {
                visiblePath = candidate;
                return true;
            }
        }
        return false;
    };

    const candidateAppearedFromInitialExpansion = await page.waitForFunction(
        async (candidateIds: readonly string[]) => {
            for (const candidateId of candidateIds) {
                if (document.querySelector(`[data-testid="${candidateId}"]`)) {
                    return true;
                }
            }
            return false;
        },
        candidates.map((candidate) => `path-browser-row:${candidate}`),
        { timeout: 5_000 }
    ).then(() => true).catch(() => false);

    if (candidateAppearedFromInitialExpansion) {
        await findVisibleCandidate();
    }

    if (!candidateAppearedFromInitialExpansion && !(await findVisibleCandidate())) {
        const rootToggle = page.getByTestId('path-browser-toggle:/').first();
        await rootToggle.scrollIntoViewIfNeeded();
        await rootToggle.evaluate((element: HTMLElement) => {
            element.click();
        });

        await expect
            .poll(findVisibleCandidate, { timeout: 60_000 })
            .toBe(true);
    }
    if (!visiblePath) {
        throw new Error('expected a machine root child directory to become visible');
    }

    const visibleRow = page.getByTestId(`path-browser-row:${visiblePath}`).first();
    await visibleRow.scrollIntoViewIfNeeded();
    await visibleRow.evaluate((element: HTMLElement) => {
        element.click();
    });
    const confirmButton = page.getByTestId('path-browser-confirm').first();
    await confirmButton.scrollIntoViewIfNeeded();
    await confirmButton.evaluate((element: HTMLElement) => {
        element.click();
    });
    await expect(page.getByTestId('path-browser-modal')).toHaveCount(0, { timeout: 30_000 });
    return visiblePath;
}

test.describe('ui e2e: directory path browser reuse', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('path-browser-directory-inputs-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

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
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('uses the shared path browser from the new-session directory input', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        daemon = await ensureSignedInAndConnected({
            page,
            server,
            uiBaseUrl,
            suiteDir,
            cliHomeDir,
        });

        await enableEnhancedSessionWizardInSettings(page, uiBaseUrl);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new`);
        await expect(page.getByTestId('path-browser-trigger')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('path-browser-trigger').click();
        const selectedPath = await selectDirectoryFromPathBrowser(page);
        await expect(page.getByTestId('path-selector-input')).toHaveValue(selectedPath, { timeout: 30_000 });
    });

    test('uses the shared path browser from the MCP detected-directory settings input', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        if (!daemon) {
            await page.setViewportSize({ width: 1440, height: 900 });
            daemon = await ensureSignedInAndConnected({
                page,
                server,
                uiBaseUrl,
                suiteDir,
                cliHomeDir,
            });
        }

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/mcp`);
        await expect(page.getByTestId('settings.mcpServers.segment:detected')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('settings.mcpServers.segment:detected').click();
        await expect(page.getByTestId('settings.mcpServers.detect.directoryInput')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('path-browser-trigger')).toHaveCount(1, { timeout: 60_000 });

        await page.getByTestId('path-browser-trigger').click();
        const selectedPath = await selectDirectoryFromPathBrowser(page);
        await expect(page.getByTestId('settings.mcpServers.detect.directoryInput')).toHaveValue(selectedPath, { timeout: 30_000 });
    });
});
