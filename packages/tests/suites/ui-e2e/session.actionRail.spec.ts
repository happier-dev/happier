import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebScriptFetchTotalTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { mutateUiE2eLocalSettings } from '../../src/testkit/uiE2e/localSettingsStorage';
import { mutateUiE2eScopedAccountSettings } from '../../src/testkit/uiE2e/scopedAccountSettingsStorage';
import { createGitRepoWithChanges, execGit } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { attachRelayMachineRpcTap, RELAY_FORWARD_TIMEOUT_ACK } from '../../src/testkit/uiE2e/desktopSetup/relayMachineRpcTap';

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

test.describe('ui e2e: session action rail', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-action-rail-suite');
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
        HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET: '1',
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

  test('confirms running session deletion, preserves failures, and keeps Archive independent', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const rpcTap = await attachRelayMachineRpcTap(page);
    const mutations: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'DELETE' || /^\/v2\/sessions\/[^/]+\/archive$/.test(path)) {
        mutations.push(`${request.method()} ${path}`);
      }
    });
    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const testDir = resolve(join(suiteDir, 'running-session-delete'));
      const actionCliHome = resolve(join(testDir, 'cli-home'));
      await mkdir(actionCliHome, { recursive: true });
      await writeFile(resolve(join(actionCliHome, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');
      runDaemon = await authenticateAndStartDaemon({
        page,
        testDir,
        cliHomeDir: actionCliHome,
        serverUrl: server.baseUrl,
        uiBaseUrl,
        extraEnv: {
          HOME: actionCliHome,
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-delete-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-delete-invocation-${run.runId}`,
        },
      });
      daemon = runDaemon;
      const repoDir = resolve(join(testDir, 'repo'));
      await createGitRepoWithChanges({ repoDir, fileCount: 1 });
      const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir });
      const sessionUrl = `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`;
      await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
      const menu = page.getByTestId('session-header-action-menu-trigger');
      await expect(menu).toBeVisible({ timeout: 120_000 });
      await page.getByTestId('session-composer-input').fill(`running delete ${run.runId}`);
      await expect(page.getByTestId('session-composer-send')).toBeEnabled();
      await page.getByTestId('session-composer-send').click();
      await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 120_000 });
      await menu.click();
      for (const action of ['stop', 'archive', 'delete']) {
        await expect(page.getByTestId(`dropdown-option-ui_session_${action}`)).toBeVisible();
      }
      await expect(page.getByTestId('session-header-info-button')).toBeVisible();
      await testInfo.attach('loaded-running-session-source', {
        body: JSON.stringify({
          uiUrl: page.url(),
          serverUrl: server.baseUrl,
          scripts: await page.locator('script[src]').evaluateAll((scripts) => scripts.map((script) => script.getAttribute('src'))),
          sourceEntrypoints: ['apps/ui', 'apps/server/sources/main.light.ts', 'apps/cli/src/index.ts'],
        }),
        contentType: 'application/json',
      });
      await page.screenshot({ path: testInfo.outputPath('running-session-delete-menu.png') });

      const stopCalls = () => rpcTap.calls().filter((call) => call.method.endsWith(':stop-session') || call.method.endsWith(':killSession'));
      const stopsBeforeCancel = stopCalls().length;
      await page.getByTestId('dropdown-option-ui_session_delete').click();
      await expect(page.getByTestId('web-modal-confirm')).toBeVisible();
      await page.getByTestId('web-modal-cancel').click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(0);
      await expect(page.getByTestId(`session-list-item-${sessionId}`)).toBeVisible();
      expect(stopCalls()).toHaveLength(stopsBeforeCancel);
      expect(mutations).toEqual([]);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${sessionId}`);

      // Fail only real relay routes; the runner and the internal lifecycle remain real.
      rpcTap.setUnresponsiveMethod('stop-session');
      rpcTap.setMethodResponse({ method: `${sessionId}:killSession`, ack: RELAY_FORWARD_TIMEOUT_ACK });
      await menu.click();
      await page.getByTestId('dropdown-option-ui_session_delete').click();
      await page.getByTestId('web-modal-confirm').click();
      await expect(page.getByTestId('web-modal-button-0')).toBeVisible({ timeout: 60_000 });
      expect(stopCalls().some((call) => call.injected)).toBe(true);
      expect(mutations).toEqual([]);
      await expect(page.getByTestId(`session-list-item-${sessionId}`)).toBeVisible();
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${sessionId}`);
      await page.screenshot({ path: testInfo.outputPath('stop-failure-preserves-running-session.png') });
      await page.getByTestId('web-modal-button-0').click();
      rpcTap.setUnresponsiveMethod(null);
      rpcTap.setMethodResponse(null);

      await menu.click();
      await expect(page.getByTestId('dropdown-option-ui_session_stop')).toBeVisible();
      await page.getByTestId('dropdown-option-ui_session_delete').click();
      const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE'
        && new URL(response.url()).pathname === `/v1/sessions/${sessionId}`);
      await page.getByTestId('web-modal-confirm').click();
      expect((await deleted).ok()).toBe(true);
      await expect.poll(() => new URL(page.url()).pathname).toBe('/');
      await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(0);
      expect(stopCalls().some((call) => !call.injected && call.ack?.ok === true)).toBe(true);
      expect(mutations).toEqual([`DELETE /v1/sessions/${sessionId}`]);
      await page.screenshot({ path: testInfo.outputPath('stop-delete-returns-home.png') });

      const archiveSessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir });
      await page.goto(`${uiBaseUrl}/session/${archiveSessionId}?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
      await expect(menu).toBeVisible({ timeout: 120_000 });
      await menu.click();
      await expect(page.getByTestId('dropdown-option-ui_session_stop')).toBeVisible();
      await expect(page.getByTestId('dropdown-option-ui_session_delete')).toBeVisible();
      const archived = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/v2/sessions/${archiveSessionId}/archive`
        && response.ok());
      await page.getByTestId('dropdown-option-ui_session_archive').click();
      await page.getByTestId('web-modal-confirm').click();
      expect((await archived).ok()).toBe(true);
      await expect(page.getByTestId(`session-list-item-${archiveSessionId}`)).toHaveCount(0);
      expect(mutations).toEqual([
        `DELETE /v1/sessions/${sessionId}`,
        `POST /v2/sessions/${archiveSessionId}/archive`,
      ]);
      await testInfo.attach('browser-diagnostics', {
        body: JSON.stringify(browserDiagnostics()),
        contentType: 'application/json',
      });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    } finally {
      await runDaemon?.stop().catch(() => {});
      if (daemon === runDaemon) daemon = null;
    }
  });

  test('opens independent panes and preserves access across responsive layouts', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1920, height: 900 });
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
      await createGitRepoWithChanges({ repoDir, fileCount: 100 });

      execGit(repoDir, ['branch', '-m', 'rail-tooltip-fixture']);

      const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir });
      const sessionUrl = `${uiBaseUrl}/session/${sessionId}`;

      await mutateUiE2eScopedAccountSettings({ page, experiments: true, featureToggles: { 'terminal.embeddedPty': true } });
      await mutateUiE2eLocalSettings({ page, settingsPatch: { themePreference: 'light', embeddedTerminalDockLocation: 'bottom', uiContentWidthMode: 'compact' } });
      await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
      await test.step('the header pins the session and copies its information without developer mode', async () => {
        const menu = page.getByTestId('session-header-action-menu-trigger');
        await expect(menu).toBeVisible({ timeout: 180_000 });
        await menu.click();
        await page.getByTestId('dropdown-option-ui_session_pin').click();
        await expect(page.getByTestId('session-list-header:pinned-v1')).toBeVisible();
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await menu.click();
        await expect(page.getByTestId('dropdown-option-ui_session_unpin')).toBeVisible();
        await page.getByTestId('dropdown-option-session_copy').click();
        await page.getByTestId('dropdown-option-session_copyDebugInformation').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toContain(`Happier session ID: ${sessionId}`);
        await menu.click();
        await page.getByTestId('dropdown-option-session_copy').click();
        await page.getByTestId('dropdown-option-session_copySessionId').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(sessionId);
        await menu.click();
        await page.screenshot({ path: testInfo.outputPath('session-header-pinned-copy-information.png') });
        await page.getByTestId('dropdown-option-ui_session_unpin').click();
        await expect(page.getByTestId('session-list-header:pinned-v1')).toHaveCount(0);
      });
      const rail = page.getByTestId('session-action-rail');
      const review = page.getByTestId('session-action-rail:review');
      const files = page.getByTestId('session-action-rail:files');
      await expect(rail).toBeVisible({ timeout: 180_000 });
      await expect(rail).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      for (const edge of ['top', 'right', 'bottom', 'left']) {
        await expect(rail).toHaveCSS(`border-${edge}-width`, '0px');
      }
      await expect(page.getByTestId('session-header-right-sidebar-button')).toHaveCount(0);
      for (const action of ['subagents', 'transcript-navigation', 'terminal']) {
        await expect(page.getByTestId(`session-header-${action}-button`)).toHaveCount(0);
      }
      await expect(page.getByTestId('session-action-rail:agents')).toBeVisible();
      await expect(page.getByTestId('session-action-rail:navigation')).toBeVisible();
      await expect(page.getByTestId('session-action-rail:terminal')).toBeVisible();
      // These live dimensions prove the current rail bundle is loaded and its targets remain compact.
      expect((await rail.boundingBox())?.width).toBe(44);
      expect((await review.boundingBox())?.width).toBe(36);
      expect((await review.boundingBox())?.height).toBe(36);
      expect((await review.locator('svg').boundingBox())?.width).toBe(18);
      await expect(rightPaneLocator(page)).toHaveCount(0);
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      const composer = page.getByTestId('session-composer-input');
      await composer.fill(`action rail alignment ${run.runId}`);
      const send = page.getByTestId('session-composer-send');
      await expect(send).toBeEnabled({ timeout: 60_000 });
      await send.click();
      await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 180_000 });
      await test.step('copies only the native Agent session ID after it is available', async () => {
        await page.getByTestId('session-header-action-menu-trigger').click();
        await page.getByTestId('dropdown-option-session_copy').click();
        await page.getByTestId('dropdown-option-session_copyProviderSessionId').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(`fake-claude-session-${run.runId}`);
      });
      await expect(page.locator('[data-testid^="transcript-message-"]').first()).toBeVisible({ timeout: 60_000 });
      const measureHeaderAlignment = async () => page.evaluate(() => {
        const avatar = document.querySelector('[data-testid="session-header-avatar"]')!;
        const info = document.querySelector('[data-testid="session-header-info-button"]')!;
        const headerRow = avatar.parentElement!;
        const wrapper = headerRow.parentElement!;
        const candidates = Array.from(document.querySelectorAll('[data-testid^="transcript-message-"] div'));
        const cappedRow = candidates.find((node) => {
          const style = getComputedStyle(node);
          return style.maxWidth === '850px' && node.getBoundingClientRect().width > 0;
        });
        if (!cappedRow) throw new Error('missing visible width-capped transcript row');
        const row = cappedRow.getBoundingClientRect();
        const outer = wrapper.getBoundingClientRect();
        const avatarRect = avatar.getBoundingClientRect();
        const infoRect = info.getBoundingClientRect();
        return { avatarLeft: avatarRect.left, transcriptLeft: row.left + 16,
          actionsRight: infoRect.right, originalActionsRight: outer.right - Math.max(0, (outer.width - 850) / 2) - 16,
          outerWidth: outer.width, rowWidth: row.width };
      });
      await expect.poll(async () => {
        const geometry = await measureHeaderAlignment();
        return Math.abs(geometry.avatarLeft - geometry.transcriptLeft);
      }).toBeLessThanOrEqual(1);
      const wideHeaderGeometry = await measureHeaderAlignment();
      expect(Math.abs(wideHeaderGeometry.actionsRight - wideHeaderGeometry.originalActionsRight)).toBeLessThanOrEqual(1);
      await testInfo.attach('closed-pane-header-geometry', { body: JSON.stringify(wideHeaderGeometry), contentType: 'application/json' });
      await page.screenshot({ path: testInfo.outputPath('rail-closed-header-alignment.png') });
      await review.click();
      await expect(detailsPaneLocator(page)).toBeVisible();
      await expect(rightPaneLocator(page)).toHaveCount(0);
      const reviewTab = page.getByTestId(`session-details-tab-${toTestIdSafeValue('scmReview:working')}`);
      await expect(reviewTab).toBeVisible();
      await review.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await review.click();
      await expect(reviewTab).toBeVisible();
      await test.step('Review content loads without opening the sidebar', async () => {
        await expect(page.getByTestId('scm-review-list')).toBeVisible({ timeout: resolveUiWebScriptFetchTotalTimeoutMs(process.env) });
        await expect(rightPaneLocator(page)).toHaveCount(0);
      });
      await files.click();
      await expect(rightPaneLocator(page)).toBeVisible();
      await expect(detailsPaneLocator(page)).toBeVisible();
      await expect(page.getByTestId('session-rightpanel-close')).toHaveCount(0);
      // Badge stays compact while the tooltip exposes all 101 tracked changed files.
      await expect(page.getByTestId('session-action-rail:git:badge')).toHaveText('99+', { timeout: 60_000 });
      const gitAction = page.getByTestId('session-action-rail:git');
      await gitAction.hover();
      const gitTooltip = page.getByTestId('session-action-rail:git-tooltip');
      await expect(gitTooltip).toBeVisible();
      const changedCount = gitTooltip.getByText('Changed files: 101', { exact: true });
      const addedLines = gitTooltip.getByText('+460', { exact: true });
      const removedLines = gitTooltip.getByText('−240', { exact: true });
      const branch = gitTooltip.getByText('Branch: rail-tooltip-fixture', { exact: true });
      await expect(changedCount).toBeVisible();
      await expect(addedLines).toBeVisible();
      await expect(removedLines).toBeVisible();
      await expect(branch).toBeVisible();
      const countBox = (await changedCount.boundingBox())!;
      const addedBox = (await addedLines.boundingBox())!;
      const branchBox = (await branch.boundingBox())!;
      expect(addedBox.y).toBeGreaterThanOrEqual(countBox.y + countBox.height);
      expect(branchBox.y).toBeGreaterThanOrEqual(addedBox.y + addedBox.height);
      const addedColor = await addedLines.evaluate((node) => getComputedStyle(node).color);
      const removedColor = await removedLines.evaluate((node) => getComputedStyle(node).color);
      expect(addedColor).not.toBe(removedColor);
      expect(addedColor).not.toBe(await changedCount.evaluate((node) => getComputedStyle(node).color));
      await page.screenshot({ path: testInfo.outputPath('git-rich-tooltip-hover.png') });
      await page.mouse.move(0, 0);
      await files.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(gitAction).toBeFocused();
      await expect(branch).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('git-rich-tooltip-keyboard.png') });
      await gitAction.blur();
      await page.mouse.move(0, 0);
      await review.blur();
      await expect(review).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const activeMarker = review.locator('div').filter({ hasNot: page.locator('svg') });
      expect(await activeMarker.evaluateAll((nodes) => nodes.some((node) => {
        const style = getComputedStyle(node);
        return style.position === 'absolute' && style.width === '2px' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
      }))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('rail-light-wide.png') });
      await review.hover();
      await expect(review).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toBeVisible();
      const tooltipBox = await tooltip.boundingBox();
      const reviewBox = await review.boundingBox();
      expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(reviewBox!.x);
      expect(reviewBox!.x - tooltipBox!.x - tooltipBox!.width).toBeLessThanOrEqual(12);
      await page.screenshot({ path: testInfo.outputPath('rail-tooltip.png') });
      await review.focus();
      await expect(review).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(files).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('rail-keyboard-focus.png') });
      const terminal = page.getByTestId('session-action-rail:terminal');
      await expect(terminal).toBeVisible();
      await terminal.click();
      await expect(page.getByTestId('multi-pane-bottom-dock')).toBeVisible();
      await terminal.click();
      await expect(page.getByTestId('multi-pane-bottom-dock')).toHaveCount(0);
      await mutateUiE2eLocalSettings({ page, settingsPatch: { themePreference: 'dark' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(rail).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('scm-review-list')).toBeVisible({ timeout: resolveUiWebScriptFetchTotalTimeoutMs(process.env) });
      await expect(page.getByTestId('repository-tree-row-src')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('rail-dark-wide.png') });
      await review.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(rail).toBeVisible();
      await page.getByTestId('session-action-rail:git').click();
      await review.click();
      await expect(page.getByTestId('multi-pane-details-overlay')).toBeVisible();
      // The host parks the right pane mounted to preserve its state while Review occludes it.
      await expect(page.getByTestId('multi-pane-right-overlay').locator('..')).toHaveCSS('opacity', '0');
      await files.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await expect(rightPaneLocator(page)).toBeVisible();
      await expect(page.getByTestId('repository-tree-row-src')).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: testInfo.outputPath('rail-narrow-files.png') });
      await mutateUiE2eLocalSettings({ page, settingsPatch: { embeddedTerminalDockLocation: 'sidebar' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(terminal).toBeVisible({ timeout: 60_000 });
      await terminal.click();
      await expect(rightPaneLocator(page)).toBeVisible();
      await review.click();
      await expect(page.getByTestId('multi-pane-details-overlay')).toBeVisible();
      // The host parks the right pane mounted to preserve its state while Review occludes it.
      await expect(page.getByTestId('multi-pane-right-overlay').locator('..')).toHaveCSS('opacity', '0');
      await terminal.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await expect(rightPaneLocator(page)).toBeVisible();
      await review.click();
      await expect(reviewTab).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('rail-narrow-review.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
      const mobileBar = page.getByTestId(`session-cockpit-tabbar-${sessionId}`);
      await expect(mobileBar).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('session-header-terminal-button')).toHaveCount(0);
      await expect(page.getByTestId('session-cockpit-tab-terminal')).toBeVisible();
      const mobileTabs = mobileBar.getByRole('tab');
      expect(await mobileTabs.count()).toBeGreaterThanOrEqual(5);
      const mobileBoxes = await mobileTabs.evaluateAll((tabs) => tabs.map((tab) => {
        const rect = tab.getBoundingClientRect();
        return { x: rect.x, width: rect.width };
      }));
      for (const [index, box] of mobileBoxes.entries()) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        if (index > 0) {
          const previous = mobileBoxes[index - 1]!;
          expect(Math.abs(box.x - previous.x - previous.width)).toBeLessThanOrEqual(1);
        }
      }
      await page.screenshot({ path: testInfo.outputPath('mobile-cockpit-spacing.png') });
      await mutateUiE2eScopedAccountSettings({ page, settingsPatch: { mobileWorkspaceExperienceV1: 'classic' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-header-terminal-button')).toBeVisible({ timeout: 60_000 });
      await expect(mobileBar).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('mobile-classic-header-fallback.png') });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    } finally {
      await runDaemon?.stop().catch(() => {});
      if (daemon === runDaemon) daemon = null;
    }
  });
});
