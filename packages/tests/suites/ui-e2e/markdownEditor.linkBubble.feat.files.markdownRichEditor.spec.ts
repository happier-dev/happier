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
    enterMarkdownRichEditorEditMode,
    expectSurfaceNearSelection,
    openMarkdownFileInRichEditor,
    saveOpenFileDetails,
} from '../../src/testkit/uiE2e/markdownRichEditorFlow';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const originalUrl = 'https://github.com';
const updatedUrl = 'https://example.com/e2e-updated';

async function clickEditorLink(params: Readonly<{
    page: Page;
    proseMirror: Locator;
    href: string;
}>): Promise<void> {
    const link = params.proseMirror.locator(`a[href="${params.href}"]`).filter({ hasText: 'GitHub' }).first();
    await expect(link).toHaveCount(1, { timeout: 60_000 });
    const box = await link.boundingBox();
    if (!box) {
        throw new Error(`Expected markdown link ${params.href} to have a visible bounding box`);
    }

    const bubbleSurface = params.page.getByTestId('markdown-link-bubble:surface');
    const bubbleUrl = params.page.getByTestId('markdown-link-bubble:url');
    const waitForBubble = async (): Promise<boolean> => {
        try {
            await expect(bubbleSurface).toHaveCount(1, { timeout: 1_500 });
            await expect(bubbleUrl).toContainText(params.href, { timeout: 1_500 });
            return true;
        } catch {
            await params.page.keyboard.press('Escape').catch(() => {});
            return false;
        }
    };

    await params.proseMirror.focus();
    const y = box.y + (box.height / 2);
    for (const x of [box.x + 2, box.x + (box.width / 2), box.x + Math.max(box.width - 2, 1)]) {
        await params.page.mouse.click(x, y);
        if (await waitForBubble()) return;
    }

    await params.page.mouse.click(Math.max(box.x - 3, 0), y);
    for (let index = 0; index < 12; index += 1) {
        await params.page.keyboard.press('ArrowRight');
        if (await waitForBubble()) return;
    }

    await params.page.mouse.move(box.x + 2, y);
    await params.page.mouse.down();
    await params.page.mouse.move(box.x + box.width - 2, y, { steps: 6 });
    await params.page.mouse.up();
    if (await waitForBubble()) return;

    throw new Error(`Could not open markdown link bubble for ${params.href} from user-level link selection`);
}

async function expectLinkBubble(page: Page, href: string): Promise<void> {
    const surface = page.getByTestId('markdown-link-bubble:surface');
    await expect(surface).toHaveCount(1, { timeout: 60_000 });
    await expect(surface).toBeVisible({ timeout: 60_000 });
    await expectSurfaceNearSelection({
        page,
        surface,
        label: 'markdown link bubble',
    });
    await expect(page.getByTestId('markdown-link-bubble:url')).toContainText(href, { timeout: 60_000 });
}

async function installWindowOpenSpy(page: Page): Promise<void> {
    await page.evaluate(() => {
        const target = window as Window & { __happierE2eWindowOpenCalls?: string[] };
        target.__happierE2eWindowOpenCalls = [];
        window.open = ((url?: string | URL) => {
            target.__happierE2eWindowOpenCalls?.push(String(url ?? ''));
            return null;
        }) as typeof window.open;
    });
}

async function readWindowOpenCalls(page: Page): Promise<readonly string[]> {
    return await page.evaluate(() => {
        const target = window as Window & { __happierE2eWindowOpenCalls?: string[] };
        return [...(target.__happierE2eWindowOpenCalls ?? [])];
    });
}

test.describe('UI e2e: markdown rich editor link bubble', () => {
    const suiteDir = run.testDir('markdown-editor-link-bubble-suite');
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
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-markdown-link-bubble`,
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

    test('opens, edits, saves, and unlinks a markdown link from the workspace rich editor bubble', async ({
        page,
    }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const browserDiagnostics = collectBrowserDiagnostics({ page });
        const testDir = resolve(join(suiteDir, 't1-markdown-link-bubble'));
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
            const repoDir = resolve(join(homeDir, 'happier-ui-e2e-projects', `happier-md-link-${randomUUID()}`));
            await mkdir(repoDir, { recursive: true });
            await initGitRepo({ repoDir });
            const filePath = 'README.md';
            const absoluteFilePath = resolve(join(repoDir, filePath));
            await writeFile(absoluteFilePath, `Link: [GitHub](${originalUrl})\n`, 'utf8');

            const opened = await openMarkdownFileInRichEditor({
                page,
                baseUrl: uiBaseUrl,
                repoDir,
                filePath,
            });

            await installWindowOpenSpy(page);
            await clickEditorLink({ page, proseMirror: opened.proseMirror, href: originalUrl });
            await expectLinkBubble(page, originalUrl);
            await page.getByTestId('markdown-link-bubble:open').click();
            await expect
                .poll(async () => (await readWindowOpenCalls(page)).some((url) => url.startsWith(originalUrl)), {
                    timeout: 60_000,
                })
                .toBe(true);

            await clickEditorLink({ page, proseMirror: opened.proseMirror, href: originalUrl });
            await expectLinkBubble(page, originalUrl);
            await page.getByTestId('markdown-link-bubble:edit').click();
            const editInput = page.getByTestId('markdown-link-bubble:edit-input:input');
            await expect(editInput).toHaveCount(1, { timeout: 60_000 });
            await editInput.fill(updatedUrl);
            await page.getByTestId('markdown-link-bubble:edit-input:save').click();
            await expectLinkBubble(page, updatedUrl);
            await expect(
                opened.proseMirror.locator(`a[href="${updatedUrl}"]`).filter({ hasText: 'GitHub' }),
            ).toHaveCount(1, { timeout: 60_000 });

            await saveOpenFileDetails(page);
            await expect
                .poll(async () => await readFile(absoluteFilePath, 'utf8'), { timeout: 120_000 })
                .toContain(`[GitHub](${updatedUrl})`);

            const reopened = await enterMarkdownRichEditorEditMode(page);
            await clickEditorLink({ page, proseMirror: reopened.proseMirror, href: updatedUrl });
            await expectLinkBubble(page, updatedUrl);
            await page.getByTestId('markdown-link-bubble:unlink').click();
            await expect(page.getByTestId('markdown-link-bubble:surface')).toHaveCount(0, { timeout: 60_000 });
            await expect(
                reopened.proseMirror.locator(`a[href="${updatedUrl}"]`).filter({ hasText: 'GitHub' }),
            ).toHaveCount(0, { timeout: 60_000 });

            await saveOpenFileDetails(page);
            await expect
                .poll(async () => await readFile(absoluteFilePath, 'utf8'), { timeout: 120_000 })
                .not.toContain('[GitHub](');
            await expect
                .poll(async () => await readFile(absoluteFilePath, 'utf8'), { timeout: 60_000 })
                .toContain('GitHub');
        } catch (error) {
            throw new Error(`${String(error)}\n\n${browserDiagnostics()}`);
        }
    });
});
