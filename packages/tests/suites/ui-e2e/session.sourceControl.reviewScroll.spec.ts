import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { createGitRepoWithChanges } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function collectBrowserDiagnostics(params: Readonly<{ page: Page }>): () => string {
  const pageConsole: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const responseErrors: string[] = [];

  params.page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
  params.page.on('pageerror', (err) => pageErrors.push(String(err)));
  params.page.on('requestfailed', (request) => {
    const failure = request.failure();
    requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
  });
  params.page.on('response', (response) => {
    const status = response.status();
    if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
  });

  return () =>
    `# Browser diagnostics\n\n` +
    `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
    `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
    `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
    `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
}

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

async function spawnSessionFromDaemon(params: {
  daemon: StartedDaemon;
  directory: string;
}): Promise<string> {
  const token = params.daemon.state.controlToken;
  if (!token) throw new Error('daemon control token missing');

  const res = await fetch(`http://127.0.0.1:${params.daemon.state.httpPort}/spawn-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-happier-daemon-token': token,
    },
    body: JSON.stringify({
      directory: params.directory,
      agent: 'claude',
    }),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok || !json || json.success !== true || typeof json.sessionId !== 'string') {
    throw new Error(`Failed to spawn session (status=${res.status}): ${JSON.stringify(json)}`);
  }
  return json.sessionId as string;
}

async function readScrollTopOfNearestScrollableAncestor(page: Page, testId: string): Promise<number> {
  return await page.getByTestId(testId).evaluate((node) => {
    const el = node as HTMLElement | null;
    if (!el) return 0;
    const isScrollable = (cursor: HTMLElement | null) => {
      if (!cursor) return false;
      const style = window.getComputedStyle(cursor);
      const overflowY = style.overflowY;
      return (overflowY === 'auto' || overflowY === 'scroll') && cursor.scrollHeight > cursor.clientHeight + 1;
    };

    // Prefer the node itself if it is the scroll container.
    if (isScrollable(el)) return el.scrollTop ?? 0;

    // React Native web can render scrollable content as a nested div inside the testId host.
    // Search within the node first for the scroll container.
    const descendants = Array.from(el.querySelectorAll('*')) as HTMLElement[];
    for (const child of descendants) {
      if (isScrollable(child)) return child.scrollTop ?? 0;
    }

    // Fall back to ancestor chain when the testId is on a nested element within the scroll root.
    let cursor: HTMLElement | null = el.parentElement;
    while (cursor) {
      if (isScrollable(cursor)) return cursor.scrollTop ?? 0;
      cursor = cursor.parentElement;
    }

    return el.scrollTop ?? 0;
  });
}

async function setScrollTopOfNearestScrollableAncestor(page: Page, testId: string, top: number): Promise<void> {
  await page.getByTestId(testId).evaluate(
    (node, nextTop) => {
      const el = node as HTMLElement | null;
      if (!el) return;
      const isScrollable = (cursor: HTMLElement | null) => {
        if (!cursor) return false;
        const style = window.getComputedStyle(cursor);
        const overflowY = style.overflowY;
        return (overflowY === 'auto' || overflowY === 'scroll') && cursor.scrollHeight > cursor.clientHeight + 1;
      };

      const findScrollable = (): HTMLElement | null => {
        if (isScrollable(el)) return el;
        const descendants = Array.from(el.querySelectorAll('*')) as HTMLElement[];
        for (const child of descendants) {
          if (isScrollable(child)) return child;
        }
        let cursor: HTMLElement | null = el.parentElement;
        while (cursor) {
          if (isScrollable(cursor)) return cursor;
          cursor = cursor.parentElement;
        }
        return null;
      };

      const target = findScrollable();
      if (!target) return;
      try {
        target.scrollTop = Math.max(0, Math.floor(Number(nextTop) || 0));
      } catch {
        // ignore
      }
    },
    top,
  );
}

async function expectScrollableToScroll(page: Page, testId: string, deltaY: number): Promise<void> {
  await setScrollTopOfNearestScrollableAncestor(page, testId, 0);
  const before = await readScrollTopOfNearestScrollableAncestor(page, testId);

  await page.getByTestId(testId).evaluate(
    (node, dy) => {
      const el = node as HTMLElement | null;
      if (!el) return;
      const isScrollable = (cursor: HTMLElement | null) => {
        if (!cursor) return false;
        const style = window.getComputedStyle(cursor);
        const overflowY = style.overflowY;
        return (overflowY === 'auto' || overflowY === 'scroll') && cursor.scrollHeight > cursor.clientHeight + 1;
      };

      const findScrollable = (): HTMLElement | null => {
        if (isScrollable(el)) return el;
        const descendants = Array.from(el.querySelectorAll('*')) as HTMLElement[];
        for (const child of descendants) {
          if (isScrollable(child)) return child;
        }
        let cursor: HTMLElement | null = el.parentElement;
        while (cursor) {
          if (isScrollable(cursor)) return cursor;
          cursor = cursor.parentElement;
        }
        return null;
      };

      const target = findScrollable();
      if (!target) return;
      const next = Math.max(0, (target.scrollTop ?? 0) + (Number(dy) || 0));
      try {
        target.scrollTop = next;
      } catch {
        // ignore
      }
    },
    deltaY,
  );

  await page.waitForTimeout(25);
  const after = await readScrollTopOfNearestScrollableAncestor(page, testId);
  expect(after).toBeGreaterThan(before + 10);
}

test.describe('ui e2e: SCM review scroll + tab state', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-scm-review-scroll-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
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

  test('scrolls Review without losing collapsed state or tab context', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

      await page.getByTestId('welcome-create-account').click();
      await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

      const testDir = resolve(join(suiteDir, 't1-review-scroll'));
      await mkdir(testDir, { recursive: true });

      const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: {
          ...process.env,
          HOME: cliHomeDir,
          CI: '1',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
        },
      });

      const connectResponse = await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
      try {
        await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
      } catch (err) {
        const debugState = await page
          .evaluate(() => ({
            href: window.location.href,
            readyState: document.readyState,
            bodyText: (document.body?.innerText ?? '').slice(0, 2000),
          }))
          .catch(() => null);
        const debugContent = await page.content().catch(() => '');
        const responseSummary = connectResponse
          ? {
              url: connectResponse.url(),
              status: connectResponse.status(),
              headers: connectResponse.headers(),
            }
          : null;
        await writeFile(
          resolve(join(testDir, 'browser-diagnostics.md')),
          `${browserDiagnostics()}\n\n## Navigation response\n\n${JSON.stringify(responseSummary, null, 2)}\n\n## Location\n\n${JSON.stringify(debugState, null, 2)}\n\n## HTML (truncated)\n\n${debugContent.slice(0, 20_000)}\n`,
          'utf8',
        ).catch(() => {});
        await test.info().attach('browser-diagnostics', {
          body: browserDiagnostics(),
          contentType: 'text/markdown',
        });
        throw err;
      }
      await page.getByTestId('terminal-connect-approve').click();
      await cliLogin.waitForSuccess();

      const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
      const fakeClaudePath = fakeClaudeFixturePath();

      runDaemon = await startTestDaemon({
        testDir,
        happyHomeDir: cliHomeDir,
        env: {
          ...process.env,
          HOME: cliHomeDir,
          CI: '1',
          HAPPIER_HOME_DIR: cliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
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

      // Agent input: "Link file" should toggle a popover on web (regression: could not close via second click).
      const linkFileTrigger = page.getByTestId('agent-input-link-file');
      await expect(linkFileTrigger).toHaveCount(1, { timeout: 60_000 });
      await linkFileTrigger.click();
      const linkFilePopover = page.getByTestId('agent-input-link-file-popover');
      await expect(linkFilePopover).toHaveCount(1, { timeout: 60_000 });
      await linkFileTrigger.click();
      await expect(linkFilePopover).toHaveCount(0, { timeout: 60_000 });

    // Right pane should open from URL state, but that can race with hydration. Ensure it is open before interacting.
    if ((await rightPaneLocator(page).count()) === 0) {
      await page.getByTestId('session-open-source-control').click();
    }
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

    // Some RN-web render paths don't forward `testID` onto the segmented tab buttons; fall back to role/name.
    const rightPane = rightPaneLocator(page);
    const gitTabByTestId = rightPane.getByTestId('session-rightpanel-tab-git');
    if (await gitTabByTestId.count()) {
      await gitTabByTestId.click();
    } else {
      await rightPane.getByRole('button', { name: 'Source control' }).click();
    }
    const openReviewByTestId = rightPane.getByTestId('session-rightpanel-git-open-review');
    if (await openReviewByTestId.count()) {
      await openReviewByTestId.click();
    } else {
      await rightPane.getByRole('button', { name: 'Review' }).click();
    }

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
    const midPath = 'src/file-10.txt';
    const laterPath = 'src/file-25.txt';
    const bigPath = 'src/big.txt';

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

    // Collapse a diff and ensure its block disappears without a big scroll jump.
    const midRow = reviewList.getByTestId(`scm-change-row-${toTestIdSafeValue(midPath)}`);
    await midRow.scrollIntoViewIfNeeded();
    const beforeBox = await midRow.boundingBox();
    await midRow.click();
    await expect(reviewList.getByTestId(`scm-review-diff-${toTestIdSafeValue(midPath)}`)).toHaveCount(0, { timeout: 60_000 });
    // Allow the scroll-preservation correction (requestAnimationFrame) to settle before measuring.
    await page.waitForTimeout(120);
    const afterBox = await midRow.boundingBox();
    if (beforeBox && afterBox) {
      expect(Math.abs(afterBox.y - beforeBox.y)).toBeLessThanOrEqual(60);
    }

    // Scroll away and back; the diff should remain collapsed.
    await reviewList.hover();
    await page.mouse.wheel(0, 1800);
    await page.mouse.wheel(0, -1800);
    await midRow.scrollIntoViewIfNeeded();
    await expect(reviewList.getByTestId(`scm-review-diff-${toTestIdSafeValue(midPath)}`)).toHaveCount(0, { timeout: 60_000 });

    // Ensure the row we want to open is mounted again before focusing (FlashList recycles rows).
    for (let i = 0; i < 20; i += 1) {
      if (await laterRow.count()) break;
      await reviewList.hover();
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(50);
    }
    await expect(laterRow).toHaveCount(1, { timeout: 60_000 });
    await laterRow.scrollIntoViewIfNeeded();
    // Record scroll position right before leaving Review (after any scroll-to-row effects).
    const scrollBefore = await readScrollTopOfNearestScrollableAncestor(page, 'scm-review-list');
    await laterRow.focus();
    await page.keyboard.press('Shift+Enter');

    const reviewTabKey = 'scmReview:working';
    await expect(page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${laterPath}`)}`)).toHaveCount(1, { timeout: 60_000 });

    // Pin icon state: preview tabs show a pin action; pinned tabs show a pinned indicator (different testId).
    const laterTabSafeKey = toTestIdSafeValue(`file:${laterPath}`);
    const pinAction = page.getByTestId(`session-details-tab-pin-${laterTabSafeKey}`);
    const pinnedIndicator = page.getByTestId(`session-details-tab-pinned-${laterTabSafeKey}`);
    if (await pinAction.count()) {
      await pinAction.click();
      await expect(pinAction).toHaveCount(0, { timeout: 60_000 });
      await expect(pinnedIndicator).toHaveCount(1, { timeout: 60_000 });
    } else {
      // If tab settings are persistent, the file may open pinned immediately; ensure we never end up in a
      // "non-preview, non-pinned" state (regression: pin icon missing / state ambiguous).
      await expect(pinnedIndicator).toHaveCount(1, { timeout: 60_000 });
    }

    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    // Scroll restoration is async on web (FlashList + RAF corrections + async diff height changes).
    // We assert we return to roughly the same area (row remains visible) without pinning an exact
    // pixel-perfect scrollTop (which is too flaky under virtualization).
    let scrollAfter = 0;
    for (let i = 0; i < 40; i += 1) {
      scrollAfter = await readScrollTopOfNearestScrollableAncestor(page, 'scm-review-list');
      const delta = Math.abs(scrollAfter - scrollBefore);
      if (delta < 150) break;
      await page.waitForTimeout(25);
    }
    expect(scrollAfter).toBeGreaterThan(50);
    await expect(laterRow).toBeVisible({ timeout: 60_000 });

    // Switch back to the file tab, enter edit mode, type, switch away/back, and ensure text persists.
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${laterPath}`)}`).click();
    await page.getByTestId('file-details-edit').click();

    const editorTextarea = detailsPaneLocator(page).locator('textarea').first();
    await expect(editorTextarea).toHaveCount(1, { timeout: 60_000 });
    await editorTextarea.focus();
    await editorTextarea.type('\nui-e2e edit');

    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${laterPath}`)}`).click();
    await expect(editorTextarea).toHaveValue(/ui-e2e edit/);

    // File details tab must remain scrollable (regression: details pane/tab content stopped scrolling).
    // Open a large file from Review to ensure scroll container is mounted and responds to wheel/scrollTop changes.
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    const bigRowForScroll = reviewList.getByTestId(`scm-change-row-${toTestIdSafeValue(bigPath)}`);
    for (let i = 0; i < 30; i += 1) {
      if (await bigRowForScroll.count()) break;
      await reviewList.hover();
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(50);
    }
    await expect(bigRowForScroll).toHaveCount(1, { timeout: 60_000 });
    await bigRowForScroll.focus();
    await page.keyboard.press('Shift+Enter');
    await expect(page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${bigPath}`)}`)).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${bigPath}`)}`).click();
    await expectScrollableToScroll(page, 'file-details-scroll', 600);

    // Ensure Review has a non-zero scrollTop persisted before switching sessions. (The file-details
    // scroll check may manipulate a shared scroll container depending on the RN-web implementation.)
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    let reviewScrollBeforeSessionSwitch = await readScrollTopOfNearestScrollableAncestor(page, 'scm-review-list');
    for (let i = 0; i < 10 && reviewScrollBeforeSessionSwitch === 0; i += 1) {
      await reviewList.hover();
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(50);
      reviewScrollBeforeSessionSwitch = await readScrollTopOfNearestScrollableAncestor(page, 'scm-review-list');
    }
    expect(reviewScrollBeforeSessionSwitch).toBeGreaterThan(0);

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
    await page.getByTestId('session-rightpanel-close').click();
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

    // Restore should keep the Review tab scroll position stable (no jump to top).
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    // Scroll restoration is async (FlashList + RAF corrections). Instead of reading `scrollTop` (which can be
    // unreliable across RN-web scroll container shapes), assert that a row that should only be mounted when
    // scrolled down is already present without additional scrolling.
    const laterRowAfterRestore = reviewList.getByTestId(`scm-change-row-${toTestIdSafeValue(laterPath)}`);
    await expect(laterRowAfterRestore).toHaveCount(1, { timeout: 60_000 });
    await expect(reviewList.getByTestId(`scm-review-diff-${toTestIdSafeValue(midPath)}`)).toHaveCount(0, { timeout: 60_000 });

    // The file tab should still contain the unsaved edits.
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${laterPath}`)}`).click();
    await expect(editorTextarea).toHaveValue(/ui-e2e edit/);

    // Close the edited file tab so subsequent file-details assertions don't collide with duplicate testIDs
    // from multiple kept-mounted file details views.
    await page.getByTestId(`session-details-tab-close-${toTestIdSafeValue(`file:${laterPath}`)}`).click();

    // Details pane focus/expand toggle should hide the main pane (composer), without closing side panes.
    // Keep this check late in the flow so layout transitions do not affect earlier scroll-jump assertions.
    const focusToggle = page.getByTestId('session-details-focus-toggle');
    if (await focusToggle.count()) {
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 60_000 });
      await focusToggle.click();
      await expect(page.getByTestId('session-composer-input')).toHaveCount(0, { timeout: 60_000 });
      await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
      await expect(detailsPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
      await focusToggle.click();
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    }

    // File-details tabs must be scrollable in both diff + file modes (regression: no scroll container on web).
    // Open the large file in a pinned tab.
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(reviewTabKey)}`).click();
    // Ensure we start from the top of the review list so stable-order files like `src/big.txt`
    // are reachable deterministically (the earlier part of this test may have scrolled deep).
    await reviewList.evaluate((el) => {
      try {
        (el as HTMLElement).scrollTop = 0;
      } catch {
        // ignore
      }
    });
    const bigRow = reviewList.getByTestId(`scm-change-row-${toTestIdSafeValue(bigPath)}`);
    for (let i = 0; i < 30; i += 1) {
      if (await bigRow.count()) break;
      await reviewList.hover();
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(50);
    }
    await expect(bigRow).toHaveCount(1, { timeout: 60_000 });
    await bigRow.scrollIntoViewIfNeeded();
    await bigRow.focus();
    await page.keyboard.press('Shift+Enter');
    await expect(page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${bigPath}`)}`)).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${bigPath}`)}`).click();

    const fileScroll = detailsPaneLocator(page).getByTestId('file-details-scroll');
    await expect(fileScroll).toHaveCount(1, { timeout: 60_000 });
    const scrollMeta = await fileScroll.evaluate((el) => ({
      overflowY: window.getComputedStyle(el as HTMLElement).overflowY,
      scrollHeight: (el as HTMLElement).scrollHeight,
      clientHeight: (el as HTMLElement).clientHeight,
    }));
	    expect(scrollMeta.overflowY === 'auto' || scrollMeta.overflowY === 'scroll').toBeTruthy();
	    expect(scrollMeta.scrollHeight).toBeGreaterThan(scrollMeta.clientHeight + 10);

	    // Diff mode scroll.
	    await expectScrollableToScroll(page, 'file-details-scroll', 1800);

	    // File mode scroll.
	    await page.getByTestId('file-details-toggle-file').click();
	    await expectScrollableToScroll(page, 'file-details-scroll', 1800);

    // Link-file popover should open and be closable (regression: popover rendered behind transcript).
    await page.getByTestId('session-details-close').click();
    await expect(detailsPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });
    await page.getByTestId('agent-input-link-file').click();
    const linkPopover = page.getByTestId('agent-input-link-file-popover');
    await expect(linkPopover).toHaveCount(1, { timeout: 60_000 });
    const linkPopoverClose = page.getByTestId('repository-tree-close');
    await expect(linkPopoverClose).toHaveCount(1, { timeout: 60_000 });

    // Clicking the chip again should toggle/close the popover.
    await page.getByTestId('agent-input-link-file').click();
    await expect(linkPopover).toHaveCount(0, { timeout: 60_000 });

    // Clicking again should re-open it (toggle open).
    await page.getByTestId('agent-input-link-file').click();
    await expect(linkPopover).toHaveCount(1, { timeout: 60_000 });

	    // Popover should size like the agent input (full-width anchor), not the chip.
	    const composerBox = await page.getByTestId('session-composer-input').boundingBox();
	    const popoverBox = await linkPopover.boundingBox();
	    if (composerBox && popoverBox) {
	      // Popover matches the composer width (allowing for composer padding vs textarea content box).
	      expect(Math.abs(popoverBox.width - composerBox.width)).toBeLessThanOrEqual(40);
	    }

    await linkPopoverClose.click();
    await expect(linkPopoverClose).toHaveCount(0, { timeout: 60_000 });
    } finally {
      // Ensure per-test daemon cleanup so retries/repeats don't leak processes.
      await runDaemon?.stop().catch(() => {});
      if (daemon === runDaemon) daemon = null;
    }
  });
});
