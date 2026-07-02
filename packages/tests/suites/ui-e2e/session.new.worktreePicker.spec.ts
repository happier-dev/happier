import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import {
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
    waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const execFileAsync = promisify(execFile);

async function createGitRepository(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: path });
}

async function selectGitWorkingDirectory(params: Readonly<{
    page: Page;
    repoDir: string;
}>): Promise<void> {
    const pathInput = params.page.getByTestId('path-selection-list:header:input');
    if ((await pathInput.count()) === 0) {
        await expect(params.page.getByTestId('agent-input-path-chip')).toHaveCount(1, { timeout: 60_000 });
        await params.page.getByTestId('agent-input-path-chip').click();
    }

    await expect(pathInput).toBeVisible({ timeout: 60_000 });
    await pathInput.fill(params.repoDir);
    await expect(pathInput).toHaveValue(params.repoDir);
    await pathInput.press('Enter');

    await expect
        .poll(async () => await params.page.getByTestId('new-session-checkout-chip').count(), { timeout: 120_000 })
        .toBe(1);
}

test.describe('ui e2e: /new worktree picker', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('new-session-worktree-picker-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
    const worktreeRepoDir = resolve(join(suiteDir, 'worktree-picker-repo'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(900_000);
        await mkdir(cliHomeDir, { recursive: true });
        await createGitRepository(worktreeRepoDir);

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

    test('opens the worktree picker from the checkout chip without dismissing /new', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 420_000);
        daemon = await authenticateAndStartDaemon({
            page,
            testDir: suiteDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            uiBaseUrl,
            terminalConnectUrlTimeoutMs: 180_000,
            daemonStartupTimeoutMs: 180_000,
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

        await enableEnhancedSessionWizard({ page, baseUrl: uiBaseUrl, timeoutMs: 180_000 });
        const newSessionUrl = `${uiBaseUrl}/new?happier_hmr=0`;
        await gotoDomContentLoadedWithRetries(page, newSessionUrl, 120_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/new',
            requiredTestIds: ['new-session-composer-input'],
            targetUrl: newSessionUrl,
            timeoutMs: 120_000,
        });
        await expect(page.getByTestId('new-session-composer-input')).toBeVisible({ timeout: 120_000 });

        const draftText = 'worktree picker pointer smoke';
        await page.getByTestId('new-session-composer-input').fill(draftText);
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue(draftText);
        await selectGitWorkingDirectory({ page, repoDir: worktreeRepoDir });

        await expect(page.getByTestId('new-session-checkout-chip')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('new-session-checkout-chip').click();

        expect(new URL(page.url()).pathname).toBe('/new');
        await expect(page.getByTestId('new-session-composer-input')).toBeVisible();
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue(draftText);
        await expect(page.getByTestId('agent-input-selection-list-popover')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('selection-list:worktree-root:option:current_path')).toBeVisible();
        await expect(page.getByTestId('selection-list:worktree-root:option:create_git_worktree')).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(page.getByTestId('agent-input-selection-list-popover')).toBeHidden({ timeout: 30_000 });
        expect(new URL(page.url()).pathname).toBe('/new');
        await expect(page.getByTestId('new-session-composer-input')).toBeVisible();
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue(draftText);
    });
});
