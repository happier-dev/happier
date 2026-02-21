import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

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

async function toggleAccountEncryptionMode(params: Readonly<{ page: Page; uiBaseUrl: string; expectedMode: 'plain' | 'e2ee' }>): Promise<void> {
  await params.page.goto(`${params.uiBaseUrl}/settings/account`, { waitUntil: 'domcontentloaded' });
  await expect(params.page.getByTestId('settings-account-encryption-mode-switch')).toHaveCount(1, { timeout: 120_000 });
  const patchOk = params.page.waitForResponse(
    (resp) => resp.url().endsWith('/v1/account/encryption') && resp.request().method() === 'PATCH' && resp.status() === 200,
    { timeout: 60_000 },
  );
  await params.page.getByTestId('settings-account-encryption-mode-switch').click();
  const patchResp = await patchOk;
  const patchJson = (await patchResp.json()) as { mode?: unknown };
  expect(patchJson?.mode).toBe(params.expectedMode);
}

test.describe('ui e2e: encryption opt-out mode switching', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('encryption-optout-mode-switch-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    await mkdir(cliHomeDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        // Keep web create-account stable (binding signature is not reliably available on web).
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
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
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('switches modes and keeps old sessions readable (e2ee → plain → e2ee)', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    if (!uiBaseUrl) throw new Error('missing ui base url');

    const testDir = resolve(join(suiteDir, 't1-mode-switch'));
    await mkdir(testDir, { recursive: true });

    const diagnostics = collectBrowserDiagnostics({ page });

    let cliLogin: StartedCliTerminalConnect | null = null;
    let thrown: unknown = null;
    try {
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await page.getByTestId('welcome-create-account').click();
      await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

      cliLogin = await startCliAuthLoginForTerminalConnect({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: {
          ...process.env,
          CI: '1',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
        },
      });

      await gotoDomContentLoadedWithRetries(page, cliLogin.connectUrl, 90_000);
      await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('terminal-connect-approve').click();
      await cliLogin.waitForSuccess();

      const tagA = `ui-e2e-e2ee-a-${run.runId}`;
      const msgA = `hello e2ee A ${run.runId}`;

      const createA = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: process.env,
        label: 'session-create-a',
        args: ['session', 'create', '--tag', tagA, '--no-load-existing', '--json'],
        timeoutMs: 120_000,
      });
      expect(createA.ok).toBe(true);
      expect(createA.kind).toBe('session_create');
      expect((createA as any)?.data?.session?.encryptionMode).toBe('e2ee');
      const sessionAId = String((createA as any)?.data?.session?.id ?? '');
      expect(sessionAId).toMatch(/\S+/);

      const sendA = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: process.env,
        label: 'session-send-a',
        args: ['session', 'send', sessionAId, msgA, '--json'],
        timeoutMs: 120_000,
      });
      expect(sendA.ok).toBe(true);
      expect(sendA.kind).toBe('session_send');

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionAId}`, 120_000);
      await expect(page.getByText(msgA)).toHaveCount(1, { timeout: 120_000 });

      await toggleAccountEncryptionMode({ page, uiBaseUrl, expectedMode: 'plain' });

      const tagB = `ui-e2e-plain-b-${run.runId}`;
      const msgB = `hello plain B ${run.runId}`;

      const createB = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: process.env,
        label: 'session-create-b',
        args: ['session', 'create', '--tag', tagB, '--no-load-existing', '--json'],
        timeoutMs: 120_000,
      });
      expect(createB.ok).toBe(true);
      expect(createB.kind).toBe('session_create');
      expect((createB as any)?.data?.session?.encryptionMode).toBe('plain');
      const sessionBId = String((createB as any)?.data?.session?.id ?? '');
      expect(sessionBId).toMatch(/\S+/);

      const sendB = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: process.env,
        label: 'session-send-b',
        args: ['session', 'send', sessionBId, msgB, '--json'],
        timeoutMs: 120_000,
      });
      expect(sendB.ok).toBe(true);
      expect(sendB.kind).toBe('session_send');

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionBId}`, 120_000);
      await expect(page.getByText(msgB)).toHaveCount(1, { timeout: 120_000 });

      await toggleAccountEncryptionMode({ page, uiBaseUrl, expectedMode: 'e2ee' });

      const tagC = `ui-e2e-e2ee-c-${run.runId}`;
      const msgC = `hello e2ee C ${run.runId}`;

      const createC = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: process.env,
        label: 'session-create-c',
        args: ['session', 'create', '--tag', tagC, '--no-load-existing', '--json'],
        timeoutMs: 120_000,
      });
      expect(createC.ok).toBe(true);
      expect(createC.kind).toBe('session_create');
      expect((createC as any)?.data?.session?.encryptionMode).toBe('e2ee');
      const sessionCId = String((createC as any)?.data?.session?.id ?? '');
      expect(sessionCId).toMatch(/\S+/);

      const sendC = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: process.env,
        label: 'session-send-c',
        args: ['session', 'send', sessionCId, msgC, '--json'],
        timeoutMs: 120_000,
      });
      expect(sendC.ok).toBe(true);
      expect(sendC.kind).toBe('session_send');

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionCId}`, 120_000);
      await expect(page.getByText(msgC)).toHaveCount(1, { timeout: 120_000 });

      // Ensure older sessions remain readable after toggling account mode.
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionAId}`, 120_000);
      await expect(page.getByText(msgA)).toHaveCount(1, { timeout: 120_000 });

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionBId}`, 120_000);
      await expect(page.getByText(msgB)).toHaveCount(1, { timeout: 120_000 });
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      await cliLogin?.stop().catch(() => {});
      if (thrown) {
        await testInfo.attach('browser-diagnostics.md', { body: diagnostics(), contentType: 'text/markdown' });
      }
    }
  });
});

