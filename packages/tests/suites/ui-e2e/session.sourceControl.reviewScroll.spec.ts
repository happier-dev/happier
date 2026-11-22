import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { focusMonacoEditor } from '../../src/testkit/uiE2e/focusMonacoEditor';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { clickScopedButtonByTestIdOrRole } from '../../src/testkit/uiE2e/clickScopedButtonByTestIdOrRole';
import { createGitRepoWithChanges } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function detailsPaneLocator(page: Page) {
  return page
    .getByTestId('multi-pane-details-docked')
    .or(page.getByTestId('multi-pane-details-overlay'));
}

function rightPaneLocator(page: Page) {
  return page
    .getByTestId('multi-pane-right-docked')
    .or(page.getByTestId('multi-pane-right-overlay'));
}

test.describe('ui e2e: SCM review position + tab state', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-scm-review-scroll-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    // Expo web bundling + first-run Metro startup can exceed 7 minutes on cold caches.
    // Keep this generous to avoid flaking the suite before we even reach UI assertions.
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        // On cold caches, the initial Metro web bundle can take >2 minutes; avoid aborting the request
        // before it has a chance to complete (which can cause repeated restarts and flakiness).
        HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '420000',
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

  test('preserves review position and open-file state through refreshes and tab changes', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await waitForInitialAppUi({ page, browserDiagnostics });

      await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

      const testDir = resolve(join(suiteDir, 't1-review-scroll'));
      await mkdir(testDir, { recursive: true });

      const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
      const fakeClaudePath = fakeClaudeFixturePath();

      runDaemon = await authenticateAndStartDaemon({
        page,
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        uiBaseUrl,
        extraEnv: {
          HOME: cliHomeDir,
          // Machine-scoped RPC (used as a fallback when a newly-spawned session has no encryption context yet)
          // must be allowed to read the repo fixture directory.
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });
      daemon = runDaemon;

      const repoDir = resolve(join(testDir, 'repo'));
      await createGitRepoWithChanges({ repoDir, fileCount: 30 });

      const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir });
      const sessionUrl = `${uiBaseUrl}/session/${sessionId}`;

      // Spawn a second session so we can validate cross-session state retention without reloading the app.
      const repoDir2 = resolve(join(testDir, 'repo-2'));
      await createGitRepoWithChanges({ repoDir: repoDir2, fileCount: 12 });
      const sessionId2 = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir2 });

      await page.goto(`${sessionUrl}?right=files`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    // Right pane should open from URL state, but that can race with hydration. Ensure it is open before interacting.
    if ((await rightPaneLocator(page).count()) === 0) {
      await page.getByTestId('session-open-source-control').click();
    }
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

    // Some RN-web render paths don't forward `testID` onto the segmented tab buttons; fall back to role/name.
    const rightPane = rightPaneLocator(page);
	    await clickScopedButtonByTestIdOrRole({
	      scope: page.getByTestId('session-action-rail'),
	      testId: 'session-action-rail:git',
	      roleName: 'Source control',
	      timeoutMs: 60_000,
	    });
    await page.getByTestId('session-action-rail:review').click();

    await expect(detailsPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    const reviewList = detailsPaneLocator(page).getByTestId('scm-review-list');
    await expect(reviewList).toHaveCount(1, { timeout: 60_000 });

    // Regression guard: Review must be scrollable within the details pane (not expand to full content height).
    const detailsBox = await detailsPaneLocator(page).boundingBox();
    const listBox = await reviewList.boundingBox();
    if (detailsBox && listBox) {
      expect(listBox.height).toBeLessThanOrEqual(detailsBox.height);
    }

    const firstPath = 'src/file-00.txt';
    const laterPath = 'src/file-25.txt';

    await expect(reviewList.getByTestId(`scm-review-diff-${toTestIdSafeValue(firstPath)}`)).toHaveCount(1, { timeout: 120_000 });

    // Scroll down until a later file's row is visible (virtualized list).
    const laterRow = reviewList.getByTestId(`scm-change-row-${toTestIdSafeValue(laterPath)}`);
    for (let i = 0; i < 20; i += 1) {
      if (await laterRow.count()) break;
      await reviewList.hover();
      await page.mouse.wheel(0, 1200);
      // Give FlashList a moment to recycle rows.
      await page.waitForTimeout(50);
    }
    await expect(laterRow).toHaveCount(1, { timeout: 60_000 });
    await laterRow.scrollIntoViewIfNeeded();
    await expect(reviewList.getByTestId(`scm-review-diff-${toTestIdSafeValue(laterPath)}`)).toHaveCount(1, { timeout: 60_000 });

    // Ensure the row we want to open is mounted again before focusing (FlashList recycles rows).
    for (let i = 0; i < 20; i += 1) {
      if (await laterRow.count()) break;
      await reviewList.hover();
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(50);
    }
    await expect(laterRow).toHaveCount(1, { timeout: 60_000 });
    await laterRow.scrollIntoViewIfNeeded();
    await laterRow.focus();
    await page.keyboard.press('Shift+Enter');

    const reviewTabKey = 'scmReview:working';
    await expect(page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${laterPath}`)}`)).toHaveCount(1, { timeout: 60_000 });

    // Pin icon state: preview tabs show a pin action; pinned tabs show an unpin action.
    const laterTabSafeKey = toTestIdSafeValue(`file:${laterPath}`);
    const pinAction = page.getByTestId(`session-details-tab-pin-${laterTabSafeKey}`);
    const unpinAction = page.getByTestId(`session-details-tab-unpin-${laterTabSafeKey}`);
    if (await pinAction.count()) {
      await pinAction.click();
      await expect(pinAction).toHaveCount(0, { timeout: 60_000 });
      await expect(unpinAction).toHaveCount(1, { timeout: 60_000 });
    } else {
      // If tab settings are persistent, the file may open pinned immediately; ensure we never end up in a
      // "non-preview, non-unpinnable" state (regression: pin icon missing / state ambiguous).
      await expect(unpinAction).toHaveCount(1, { timeout: 60_000 });
    }

    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    // FlashList may restore the same visible row with a different internal scroll container or
    // offset. The user-facing contract is that returning to Review restores the reading position.
    await expect(laterRow).toBeVisible({ timeout: 60_000 });

    // Exercise the actual file viewer too: refreshed repository bytes must
    // replace the rendered patch without depending on renderer-internal DOM ids.
    await clickScopedButtonByTestIdOrRole({
      scope: page.getByTestId('session-action-rail'),
      testId: 'session-action-rail:files',
      roleName: 'Files',
      timeoutMs: 60_000,
    });
    // Playwright checks the next target before moving its synthetic pointer. Move into the
    // repository surface first, matching a real pointer transition and dismissing the rail tooltip.
    await rightPane.getByTestId('repository-tree-search').hover();
    await expect(page.getByTestId('session-action-rail:files-tooltip')).toHaveCount(0);
    const bigPath = 'src/big.txt';
    const bigTreeRow = rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(bigPath)}`);
    if (await bigTreeRow.count() === 0) {
      await rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue('src')}`).click();
    }
    await expect(bigTreeRow).toBeVisible({ timeout: 60_000 });
    await bigTreeRow.dblclick();
    const bigTab = page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${bigPath}`)}`);
    await expect(bigTab).toBeVisible({ timeout: 60_000 });
    await bigTab.click();
    await detailsPaneLocator(page).locator('[data-testid="file-details-view-mode-menu"]:visible').click();
    await page.getByTestId('dropdown-option-file').click();
    const fileScroll = detailsPaneLocator(page).locator('[data-testid="file-details-scroll"]:visible');
    await expect(fileScroll).toBeVisible({ timeout: 60_000 });
    const refreshFiles = async () => {
      await rightPane.getByTestId('repository-tree-refresh').click();
      await expect(rightPane.getByTestId('repository-tree-refresh-loading')).toHaveCount(0, { timeout: 60_000 });
    };
    const insertedLines = Array.from({ length: 12 }, (_, index) => `inserted ${index}`);
    const originalLines = Array.from({ length: 360 }, (_, index) => `changed ${index}`);
    await detailsPaneLocator(page).locator('[data-testid="file-details-view-mode-menu"]:visible').click();
    await page.getByTestId('dropdown-option-diff').click();
    const pierre = detailsPaneLocator(page).locator('[data-testid="pierre-diff-viewer"]:visible');
    await expect(pierre).toBeVisible({ timeout: 60_000 });
    const diffPassage = pierre.locator('[data-line]').filter({ hasText: /^changed 180\n?$/ });
    for (let i = 0; i < 40 && await diffPassage.count() === 0; i += 1) {
      await pierre.hover();
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(50);
    }
    await expect(diffPassage).toHaveCount(1, { timeout: 60_000 });
    const initialDiffLineNumber = Number(await diffPassage.getAttribute('data-line'));
    expect(Number.isFinite(initialDiffLineNumber)).toBe(true);
    await writeFile(resolve(join(repoDir, bigPath)), `${[...insertedLines, ...originalLines].join('\n')}\n`, 'utf8');
    await refreshFiles();
    // The semantic line identity proves the changed patch was rendered without
    // depending on Pierre's internal virtualizer offsets or offscreen DOM layout.
    await expect(diffPassage).toHaveAttribute('data-line', String(initialDiffLineNumber + insertedLines.length), { timeout: 60_000 });
    await writeFile(resolve(join(repoDir, bigPath)), `${originalLines.join('\n')}\n`, 'utf8');
    await refreshFiles();
    await expect(diffPassage).toHaveAttribute('data-line', String(initialDiffLineNumber), { timeout: 60_000 });
    await page.getByTestId(`session-details-tab-close-${toTestIdSafeValue(`file:${bigPath}`)}`).click();

    // Switch back to the file tab, enter edit mode, type, switch away/back, and ensure text persists.
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${laterPath}`)}`).click();
    await page.getByTestId('file-details-edit').click();

    const editorSurface = page.getByTestId('file-details-editor');
    await expect(editorSurface).toHaveCount(1, { timeout: 60_000 });
    await focusMonacoEditor(editorSurface);
    await page.keyboard.type('\nui-e2e edit');

    // Ensure the edit landed before switching tabs (otherwise the next assertion is ambiguous).
    const markerMatch = laterPath.match(/file-(\d+)\.txt$/);
    const marker = markerMatch ? `hello ${markerMatch[1]}` : null;

    const readMonacoValue = async () =>
      page.evaluate((valueMarker) => {
        const monaco = (window as any).monaco;
        const models: any[] = monaco?.editor?.getModels?.() ?? [];
        const model = valueMarker
          ? models.find((m) => {
            try {
              return typeof m?.getValue === 'function' && String(m.getValue()).includes(String(valueMarker));
            } catch {
              return false;
            }
          })
          : models[0];
        try {
          return typeof model?.getValue === 'function' ? (model.getValue() as string) : null;
        } catch {
          return null;
        }
      }, marker);

    await expect
      .poll(async () => readMonacoValue(), { timeout: 60_000 })
      .toContain('ui-e2e edit');

    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${laterPath}`)}`).click();
    await expect
      .poll(async () => readMonacoValue(), { timeout: 60_000 })
      .toContain('ui-e2e edit');

    // Return to the later review row before switching sessions. FlashList owns the internal pixel
    // offset, so preserve and assert the user-visible reading position instead of its DOM layout.
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    await expect(laterRow).toBeVisible({ timeout: 60_000 });

    // Navigate to a different session and back, asserting we can continue where we left off:
    // - right sidebar + details pane still open
    // - Review collapsed diff state persisted
    // - unsaved editor text persisted
    // Switch sessions via the permanent sidebar (desktop web) to avoid full-page reloads.
    const sidebarExpand = page.getByTestId('sidebar-expand-button');
    if (await sidebarExpand.count()) {
      await sidebarExpand.click({ force: true });
    }
    await expect(page.getByTestId(`session-list-item-${sessionId2}`)).toHaveCount(1, { timeout: 90_000 });
    await page.getByTestId(`session-list-item-${sessionId2}`).click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId2}(\\?|$)`), { timeout: 90_000 });
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });

    // Per-session pane state: closing the right pane in session 2 should not affect session 1.
    // Ensure the right pane is open so we can close it explicitly.
    if ((await rightPaneLocator(page).count()) === 0) {
      await page.getByTestId('session-open-source-control').click();
    }
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    const session2GitAction = page.getByTestId('session-action-rail:git');
    const session2GitSurface = rightPaneLocator(page).getByTestId('session-rightpanel-surface-git');
    if (!(await session2GitSurface.isVisible().catch(() => false))) {
      await session2GitAction.click();
      await expect(session2GitSurface).toBeVisible({ timeout: 60_000 });
    }
    await session2GitAction.click();
    await expect(rightPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });

    await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(1, { timeout: 90_000 });
    await page.getByTestId(`session-list-item-${sessionId}`).click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}(\\?|$)`), { timeout: 90_000 });
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });

    // The pane layout should restore for this session.
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

    // Switch back to session 2 and ensure it remembers the closed right pane state.
    await page.getByTestId(`session-list-item-${sessionId2}`).click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId2}(\\?|$)`), { timeout: 90_000 });
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
    await expect(rightPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });

    // Return to session 1 for the remaining assertions.
    await page.getByTestId(`session-list-item-${sessionId}`).click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}(\\?|$)`), { timeout: 90_000 });
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });

    // Return to Review before restoring the retained file tab.
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();

    // The retained file tab should reactivate its editor and unsaved draft.
    const retainedFileTab = page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${laterPath}`)}`);
    await expect(async () => {
      await retainedFileTab.click({ timeout: 5_000, position: { x: 20, y: 12 } });
      await expect(page.getByTestId('file-details-editor')).toHaveCount(1, { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect
      .poll(async () => readMonacoValue(), { timeout: 60_000 })
      .toContain('ui-e2e edit');

    } finally {
      // Ensure per-test daemon cleanup so retries/repeats don't leak processes.
      await runDaemon?.stop().catch(() => {});
      if (daemon === runDaemon) daemon = null;
    }
  });
});
