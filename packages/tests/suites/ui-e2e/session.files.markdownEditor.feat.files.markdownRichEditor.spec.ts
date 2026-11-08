import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  startCliAuthLoginForTerminalConnect,
  type StartedCliTerminalConnect,
} from '../../src/testkit/uiE2e/cliTerminalConnect';
import { initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { focusMonacoEditor } from '../../src/testkit/uiE2e/focusMonacoEditor';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithPathFallback,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import {
  collectBrowserDiagnostics,
  enableMarkdownRichEditorInSettings,
  fileDetailsTabTestId,
  openFileInWorkspaceDetails,
  workspaceDetailsPaneLocator,
} from '../../src/testkit/uiE2e/markdownRichEditorFlow';

const run = createRunDirs({ runLabel: 'ui-e2e' });

// Eligible markdown: clean Phase-1 constructs only (no reference links / HTML).
const ELIGIBLE_MARKDOWN = '# Rich editor doc\n\nHello **world**.\n\n- one\n- two\n';
// Ineligible markdown: reference-style link definition -> the layered gate (§5.3)
// blocks rich editing with reason `reference-links`, so the file edits as raw.
const INELIGIBLE_MARKDOWN = 'See [the docs][ref].\n\n[ref]: https://example.com\n';

async function positionRichEditorSelection(editor: Locator, word: string, mode: 'text' | 'after'): Promise<void> {
  await editor.focus();
  await editor.evaluate((element, target) => {
    const document = element.ownerDocument;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(target.word) ?? -1;
      if (start < 0) continue;
      const end = start + target.word.length;
      const range = document.createRange();
      range.setStart(node, target.mode === 'text' ? start : end);
      if (target.mode === 'text') range.setEnd(node, end);
      else range.collapse(true);
      const selection = document.defaultView?.getSelection();
      if (!selection) throw new Error('Rich editor has no browser selection');
      selection.removeAllRanges();
      selection.addRange(range);
      if (target.mode === 'text' && selection.toString() !== target.word) {
        throw new Error(`Rich editor did not select ${target.word}`);
      }
      if (target.mode === 'after' && (selection.anchorNode !== node || selection.anchorOffset !== end)) {
        throw new Error(`Rich editor did not position after ${target.word}`);
      }
      return;
    }
    throw new Error(`Rich editor is missing ${target.word}`);
  }, { word, mode });
}

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
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
    },
  });

  await gotoDomContentLoadedWithPathFallback(page, cliLogin.connectUrl, '/terminal/connect', 180_000);
  await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('terminal-connect-approve').click();
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

  await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/?happier_hmr=0`, '/', 180_000);

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

test.describe('ui e2e: markdown rich editor (feat.files.markdownRichEditor)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('workspace-files-markdown-editor-suite');
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
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-workspace-markdown`,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    if (keepProcsOnFailure) {
      // Local debugging helper: keep metro + server running so the failing bundle
      // and sourcemaps can be inspected after the test aborts. CI must not set this.
      return;
    }
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('edits an eligible markdown file in the workspace rich surface and writes clean markdown to disk', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      daemon = await ensureSignedInAndConnected({
        page,
        server,
        uiBaseUrl,
        suiteDir,
        cliHomeDir,
        flowDirName: 't1-connect',
      });

      // Prime server-scoped state before the Projects flow (Projects add requires
      // a resolved server id).
      await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/new?happier_hmr=0`, '/new', 180_000);
      await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 180_000 });

      // Turn on the experimental rich-markdown-editor flag so the Raw<->Rich
      // toggle + rich surface are available (the feat.* suffix marks this gate).
      await enableMarkdownRichEditorInSettings({ baseUrl: uiBaseUrl, page });

      // Keep the repo under HOME so the daemon's filesystem access policy (allowed
      // directories) permits opening/saving files in it.
      const homeDir = process.env.HOME ? resolve(process.env.HOME) : suiteDir;
      const repoDir = resolve(join(homeDir, 'happier-ui-e2e-projects', `happier-md-rich-${randomUUID()}`));
      await mkdir(repoDir, { recursive: true });
      await initGitRepo({ repoDir });
      const eligiblePath = 'README.md';
      const ineligiblePath = 'refs.md';
      await writeFile(resolve(join(repoDir, eligiblePath)), ELIGIBLE_MARKDOWN, 'utf8');
      await writeFile(resolve(join(repoDir, ineligiblePath)), INELIGIBLE_MARKDOWN, 'utf8');

      // --- Eligible file: add workspace -> open file tab -> rich surface -> toggle -> type -> Save ---
      await openFileInWorkspaceDetails({ page, baseUrl: uiBaseUrl, repoDir, filePath: eligiblePath });

      // The read-only preview uses MarkdownView (file-markdown-preview).
      await expect(workspaceDetailsPaneLocator(page).getByTestId('file-markdown-preview')).toHaveCount(1, {
        timeout: 120_000,
      });

      // Enter edit mode. With markdownDefaultEditMode='rich' (the dev default) and
      // the file eligible, the rich surface mounts (file-details-rich-editor).
      await page.getByTestId('file-details-edit').click();
      const richEditor = workspaceDetailsPaneLocator(page).getByTestId('file-details-rich-editor');
      await expect(richEditor).toHaveCount(1, { timeout: 120_000 });

      // The edit-mode control is the Rich / Raw segmented switch; Rich is the
      // active mode (the rich surface mounted above).
      await expect(workspaceDetailsPaneLocator(page).getByTestId('markdown-edit-mode:rich')).toHaveCount(1, {
        timeout: 60_000,
      });

      // Toggle to Raw and back to Rich; no data loss is asserted via the final
      // on-disk content below (flush + reseed on every toggle, R-A6).
      await workspaceDetailsPaneLocator(page).getByTestId('markdown-edit-mode:raw').click();
      const rawEditor = workspaceDetailsPaneLocator(page).getByTestId('file-details-editor');
      await expect(rawEditor).toHaveCount(1, { timeout: 60_000 });

      // Type an appended line in raw mode (Monaco), the most deterministic way to
      // make a precise on-disk assertion across the rich<->raw round-trip.
      await focusMonacoEditor(rawEditor);
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\nAppended by e2e.');
      await expect(rawEditor.locator('.view-lines')).toContainText('Appended by e2e.');

      // Switch back to Rich; the rich surface must remount with the latest text
      // (no character loss across the toggle).
      await workspaceDetailsPaneLocator(page).getByTestId('markdown-edit-mode:rich').click();
      await expect(workspaceDetailsPaneLocator(page).getByTestId('file-details-rich-editor')).toHaveCount(1, {
        timeout: 60_000,
      });

      await expect(richEditor.locator('.ProseMirror')).toContainText('Appended by e2e.');
      await richEditor.locator('.ProseMirror').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Rich draft survives lazy remount.');
      await workspaceDetailsPaneLocator(page).getByTestId('markdown-edit-mode:raw').click({ force: true });
      await expect(rawEditor).toBeVisible({ timeout: 60_000 });
      await workspaceDetailsPaneLocator(page).getByTestId('markdown-edit-mode:rich').click({ force: true });
      await expect(richEditor.locator('.ProseMirror')).toContainText('Rich draft survives lazy remount.');
      await expect(richEditor.locator('.ProseMirror')).toContainText('Appended by e2e.');

      // Save and assert the on-disk content contains the original eligible
      // markdown plus the appended line (no clobber / no lost edit).
      await page.getByTestId('file-details-save').click();

      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 120_000 })
        .toContain('Appended by e2e.');
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toContain('Rich draft survives lazy remount.');
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toContain('Hello');

      // After save, re-opening shows the updated preview (re-render).
      await expect(workspaceDetailsPaneLocator(page).getByTestId('file-markdown-preview')).toHaveCount(1, {
        timeout: 120_000,
      });

      // --- Ineligible file: raw fallback + disabled Rich, no rich surface ---
      const ineligibleRow = page.getByTestId(`repository-tree-row-${toTestIdSafeValue(ineligiblePath)}`);
      await expect(ineligibleRow).toHaveCount(1, { timeout: 120_000 });
      await ineligibleRow.click();
      await expect(page.getByTestId(fileDetailsTabTestId(ineligiblePath))).toHaveCount(1, { timeout: 120_000 });
      await expect(workspaceDetailsPaneLocator(page).getByTestId('file-markdown-preview')).toHaveCount(1, {
        timeout: 120_000,
      });

      await page.getByTestId('file-details-edit').click();

      // The ineligible file must fall back to the raw editor; the rich surface
      // must NOT mount.
      await expect(workspaceDetailsPaneLocator(page).getByTestId('file-details-editor')).toHaveCount(1, {
        timeout: 120_000,
      });
      await expect(workspaceDetailsPaneLocator(page).getByTestId('file-details-rich-editor')).toHaveCount(0, {
        timeout: 30_000,
      });

      // The switch shows Rich DISABLED (the gate blocks reference-link files);
      // the segment announces the reason with its name.
      const richSegment = workspaceDetailsPaneLocator(page).getByTestId('markdown-edit-mode:rich');
      await expect(richSegment).toHaveCount(1, { timeout: 60_000 });
      await expect(richSegment).toHaveAttribute('aria-disabled', 'true', { timeout: 60_000 });
    } catch (error) {
      throw new Error(`${String(error)}\n\n${browserDiagnostics()}`);
    }
  });

  test('formats text in the workspace rich (TipTap) surface via the toolbar and writes the formatting to disk', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      // Each test gets its own daemon (afterEach-style isolation is handled by the
      // serial flow seeding a fresh repo + connection below).
      daemon = await ensureSignedInAndConnected({
        page,
        server,
        uiBaseUrl,
        suiteDir,
        cliHomeDir,
        flowDirName: 't2-connect',
      });

      await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/new?happier_hmr=0`, '/new', 180_000);
      await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 180_000 });

      await enableMarkdownRichEditorInSettings({ baseUrl: uiBaseUrl, page });

      const homeDir = process.env.HOME ? resolve(process.env.HOME) : suiteDir;
      const repoDir = resolve(join(homeDir, 'happier-ui-e2e-projects', `happier-md-rich-fmt-${randomUUID()}`));
      await mkdir(repoDir, { recursive: true });
      await initGitRepo({ repoDir });
      const eligiblePath = 'README.md';
      await writeFile(resolve(join(repoDir, eligiblePath)), ELIGIBLE_MARKDOWN, 'utf8');

      // --- Eligible file: add workspace -> open file tab -> Edit -> rich mounts ---
      await openFileInWorkspaceDetails({ page, baseUrl: uiBaseUrl, repoDir, filePath: eligiblePath });
      await expect(workspaceDetailsPaneLocator(page).getByTestId('file-markdown-preview')).toHaveCount(1, {
        timeout: 120_000,
      });

      await page.getByTestId('file-details-edit').click();
      const richEditor = workspaceDetailsPaneLocator(page).getByTestId('file-details-rich-editor');
      await expect(richEditor).toHaveCount(1, { timeout: 120_000 });

      // The TipTap web surface renders a real `.ProseMirror` contenteditable inside
      // the rich panel. Scope to the rich-editor testID so we never pick up an
      // unrelated ProseMirror surface elsewhere on the page.
      const proseMirror = richEditor.locator('.ProseMirror');
      await expect(proseMirror).toHaveCount(1, { timeout: 60_000 });
      await proseMirror.click();

      // Move to the very end of the document, then start a fresh paragraph so the
      // formatting we apply doesn't disturb the seeded eligible markdown.
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');

      // 1) Bold: select exactly the new word before using the toolbar. Home
      //    and double-click selection differ across macOS/Linux.
      const boldWord = 'BoldByE2E';
      await page.keyboard.type(boldWord);
      await positionRichEditorSelection(proseMirror, boldWord, 'text');
      await workspaceDetailsPaneLocator(page)
        .getByTestId('file-details-rich-editor-toolbar:bold')
        .click({ force: true });
      await expect(proseMirror.locator('strong', { hasText: boldWord })).toHaveCount(1);
      await expect(proseMirror.locator('p').first().locator('strong')).toHaveCount(0);

      // 2) List: start a new line, type an item, toggle a bullet list. Serializes
      //    with a `- ` marker.
      await positionRichEditorSelection(proseMirror, boldWord, 'after');
      await page.keyboard.press('Enter');
      await expect(proseMirror.locator('strong', { hasText: boldWord })).toHaveCount(1);
      const listItem = 'ListItemByE2E';
      await page.keyboard.type(listItem);
      await workspaceDetailsPaneLocator(page)
        .getByTestId('file-details-rich-editor-toolbar:bulletList')
        .click({ force: true });
      await expect(proseMirror.locator('li')).toContainText(listItem);
      await expect(proseMirror.locator('strong', { hasText: boldWord })).toHaveCount(1);

      // 3) Heading: start a new line, type text, apply H1. Serializes as `# `.
      await positionRichEditorSelection(proseMirror, listItem, 'after');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      const headingText = 'HeadingByE2E';
      await page.keyboard.type(headingText);
      await workspaceDetailsPaneLocator(page)
        .getByTestId('file-details-rich-editor-toolbar:heading1')
        .click({ force: true });
      await expect(proseMirror.locator('h1')).toContainText(headingText);

      // Save and assert the on-disk markdown reflects the toolbar formatting:
      // a bold span (`**...**`), a bullet-list marker (`- `), and an H1 (`# `).
      await page.getByTestId('file-details-save').click();

      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 120_000 })
        .toContain(`**${boldWord}**`);
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toContain(`- ${listItem}`);
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toContain(`# ${headingText}`);

      // The original seeded content must survive the rich round-trip (no clobber).
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toContain('Hello');

      // After save, the preview re-renders.
      await expect(workspaceDetailsPaneLocator(page).getByTestId('file-markdown-preview')).toHaveCount(1, {
        timeout: 120_000,
      });
    } catch (error) {
      throw new Error(`${String(error)}\n\n${browserDiagnostics()}`);
    }
  });
});
