import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import {
  gotoDomContentLoadedWithPathFallback,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import type { StartedDaemon } from '../../src/testkit/daemon/daemon';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function createAccountWithoutDaemon(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithPathFallback(params.page, `${params.uiBaseUrl}/`, '/', 120_000);
  await ensureAccountReadyForConnect({ page: params.page, timeoutMs: 120_000 });
}

test.describe('ui e2e: server retention visibility', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('server-retention-visibility-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let secondaryServer: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI retention fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_SERVER_RETENTION__ENABLED: '1',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '200',
        HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '30',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: 'delete_older_than',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: '45',
      },
    });

    secondaryServer = await startServerLight({
      testDir: resolve(join(suiteDir, 'secondary-server')),
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_SERVER_RETENTION__ENABLED: '1',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '200',
        HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '60',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: 'delete_older_than',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: '90',
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
    await secondaryServer?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test.afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
  });

  test('shows retention in server settings for the active server', async ({ page }) => {
    test.setTimeout(240_000);
    if (!uiBaseUrl) throw new Error('missing ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await createAccountWithoutDaemon({ page, uiBaseUrl });
    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/server`, '/server', 120_000);
    await expect(page.getByTestId('server-retention-summary')).toContainText('30', { timeout: 120_000 });
    await expect(page.getByTestId('server-retention-row-accountChanges')).toContainText('45', { timeout: 60_000 });
  });

  test('shows session info retention for an active-server session', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });

    const testDir = resolve(join(suiteDir, 't2-session-info-retention'));
    await mkdir(testDir, { recursive: true });
    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      extraEnv: {
        HOME: cliHomeDir,
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });
    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/`, '/');

    const createdSession = await runCliJson({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: {
        ...process.env,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
      label: 'session-create-retention-visibility',
      args: ['session', 'create', '--tag', `retention-visibility-${run.runId}`, '--no-load-existing', '--json'],
      timeoutMs: 120_000,
    });
    expect(createdSession.ok).toBe(true);
    expect(createdSession.kind).toBe('session_create');
    const sessionId = String((createdSession as any)?.data?.session?.id ?? '');
    expect(sessionId).toMatch(/\S+/);

    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/session/${sessionId}/info`, `/session/${sessionId}/info`, 120_000);
    await expect(page.getByTestId('session-info-screen')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('session-retention-notice')).toContainText('30', { timeout: 60_000 });
  });

  test('shows retention metadata for a newly added relay in saved relays', async ({ page }) => {
    test.setTimeout(300_000);
    if (!secondaryServer || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await createAccountWithoutDaemon({ page, uiBaseUrl });

    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/server`, '/server', 120_000);
    await page.getByTestId('server-settings-add-server-toggle').click();
    await page.getByTestId('server-settings-add-url-input').fill(secondaryServer.baseUrl);
    await page.getByTestId('server-settings-add-name-input').fill('Retention B');
    await page.getByTestId('server-settings-add-confirm').click();
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/server`, '/server', 120_000);
    const retentionBRow = page.locator('[data-testid^="saved-server-row-"]').filter({ hasText: 'Retention B' });
    await expect(retentionBRow).toHaveCount(1, { timeout: 120_000 });
    await expect(retentionBRow).toContainText('Signed out', { timeout: 120_000 });
    await expect(page.getByText('Deletes inactive sessions after 60 days.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('server-retention-summary')).toContainText('30', { timeout: 120_000 });
    await expect(page.getByTestId('server-retention-row-accountChanges')).toContainText('45', { timeout: 60_000 });
  });
});
