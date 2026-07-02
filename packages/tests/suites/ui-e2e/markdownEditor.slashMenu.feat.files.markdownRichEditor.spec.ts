import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import {
    collectBrowserDiagnostics,
    enableMarkdownRichEditorInSettings,
    expectSurfaceNearSelection,
    openMarkdownFileInRichEditor,
    saveOpenFileDetails,
} from '../../src/testkit/uiE2e/markdownRichEditorFlow';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function runMarkdownSlashCommand(params: Readonly<{
    page: Page;
    proseMirror: Locator;
    query: string;
    optionId: string;
}>): Promise<void> {
    await params.proseMirror.click();
    await params.page.keyboard.type(params.query);

    const surface = params.page.getByTestId('markdown-slash-menu:surface');
    await expect(surface).toHaveCount(1, { timeout: 60_000 });
    await expect(surface).toBeVisible({ timeout: 60_000 });
    await expectSurfaceNearSelection({
        page: params.page,
        surface,
        label: 'markdown slash menu',
    });

    const option = params.page.getByTestId(`markdown-slash-menu:list:command-menu-root:option:${params.optionId}`);
    await expect(option).toHaveCount(1, { timeout: 60_000 });
    await params.page.keyboard.press('Enter');
    await expect(surface).toHaveCount(0, { timeout: 60_000 });
}

test.describe('UI e2e: markdown rich editor slash menu', () => {
    const suiteDir = run.testDir('markdown-editor-slash-menu-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let daemon: StartedDaemon | null = null;
    let uiBaseUrl: string | null = null;

    test.beforeAll(async () => {
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

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
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
                HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-markdown-slash-menu`,
                EXPO_PUBLIC_DEBUG: '1',
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

    test('inserts heading and bullet blocks from the workspace rich editor slash menu and saves markdown', async ({
        page,
    }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const browserDiagnostics = collectBrowserDiagnostics({ page });
        const testDir = resolve(join(suiteDir, 't1-markdown-slash-menu'));
        await mkdir(testDir, { recursive: true });

        try {
            await page.setViewportSize({ width: 1440, height: 900 });
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 420_000);
            await waitForInitialAppUi({ page, timeoutMs: 420_000, browserDiagnostics });

            daemon = await authenticateAndStartDaemon({
                page,
                testDir,
                cliHomeDir,
                serverUrl: server.baseUrl,
                uiBaseUrl,
                initialUiReadyTimeoutMs: 180_000,
                terminalConnectUrlTimeoutMs: 180_000,
                extraEnv: {
                    HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                    HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
                    HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                    HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
                },
            });

            await enableMarkdownRichEditorInSettings({ baseUrl: uiBaseUrl, page });

            const homeDir = process.env.HOME ? resolve(process.env.HOME) : suiteDir;
            const repoDir = resolve(join(homeDir, 'happier-ui-e2e-projects', `happier-md-slash-${randomUUID()}`));
            await mkdir(repoDir, { recursive: true });
            await initGitRepo({ repoDir });
            const filePath = 'README.md';
            const absoluteFilePath = resolve(join(repoDir, filePath));
            await writeFile(absoluteFilePath, 'Seed\n', 'utf8');

            const { proseMirror } = await openMarkdownFileInRichEditor({
                page,
                baseUrl: uiBaseUrl,
                repoDir,
                filePath,
            });
            await proseMirror.click();
            await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
            await page.keyboard.press('Backspace');

            await runMarkdownSlashCommand({ page, proseMirror, query: '/h1', optionId: 'heading1' });
            await page.keyboard.type('Heading by E2E');
            await page.keyboard.press('Enter');

            await runMarkdownSlashCommand({ page, proseMirror, query: '/bullet', optionId: 'bulletList' });
            await page.keyboard.type('Bullet by E2E');

            await saveOpenFileDetails(page);

            await expect
                .poll(async () => await readFile(absoluteFilePath, 'utf8'), { timeout: 120_000 })
                .toContain('# Heading by E2E');
            await expect
                .poll(async () => await readFile(absoluteFilePath, 'utf8'), { timeout: 60_000 })
                .toContain('- Bullet by E2E');
        } catch (error) {
            throw new Error(`${String(error)}\n\n${browserDiagnostics()}`);
        }
    });
});
