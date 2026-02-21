import { test, expect, type Page, type BrowserContext } from '@playwright/test';
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

async function extractPublicShareUrlFromDialog(params: Readonly<{ dialog: ReturnType<Page['getByRole']> }>): Promise<string> {
  const locator = params.dialog.locator('text=/https?:\\/\\/[^\\s]+\\/share\\/[0-9a-f]+/i').first();
  const raw = (await locator.innerText()).trim();
  const match = raw.match(/https?:\/\/[^\s]+\/share\/[0-9a-f]+/i);
  if (!match) throw new Error(`Failed to extract share URL from dialog text: ${JSON.stringify(raw)}`);
  return match[0];
}

async function openShareInFreshContext(params: Readonly<{ baseContext: BrowserContext; url: string }>): Promise<Page> {
  const browser = params.baseContext.browser();
  if (!browser) throw new Error('Missing browser instance');
  const context = await browser.newContext();
  const page = await context.newPage();
  await gotoDomContentLoadedWithRetries(page, params.url, 90_000);
  return page;
}

test.describe('ui e2e: plaintext mode + public share', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('encryption-optout-public-share-suite');
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
        // Make presence timeouts fast enough for UI E2E reconnect flows.
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

  test('toggles account to plaintext, writes a plaintext session, and opens a public link', async ({ page, context }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    if (!uiBaseUrl) throw new Error('missing ui base url');

    const testDir = resolve(join(suiteDir, 't1-plaintext-public-share'));
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

      await page.goto(`${uiBaseUrl}/settings/account`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('settings-account-encryption-mode-switch')).toHaveCount(1, { timeout: 120_000 });

      const patchOk = page.waitForResponse((resp) => resp.url().endsWith('/v1/account/encryption') && resp.request().method() === 'PATCH' && resp.status() === 200, { timeout: 60_000 });
      await page.getByTestId('settings-account-encryption-mode-switch').click();
      const patchResp = await patchOk;
      const patchJson = (await patchResp.json()) as { mode?: unknown };
      expect(patchJson?.mode).toBe('plain');

      const tag = `ui-e2e-plain-${run.runId}`;
      const message = `hello from plain ${run.runId}`;

      const createEnvelope = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: process.env,
        label: 'session-create',
        args: ['session', 'create', '--tag', tag, '--no-load-existing', '--json'],
        timeoutMs: 120_000,
      });
      expect(createEnvelope.ok).toBe(true);
      expect(createEnvelope.kind).toBe('session_create');
      const createdSessionId = (createEnvelope as any)?.data?.session?.id;
      expect(typeof createdSessionId).toBe('string');
      expect((createEnvelope as any)?.data?.session?.encryptionMode).toBe('plain');

      const sessionId = String(createdSessionId);

      const sendEnvelope = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: process.env,
        label: 'session-send',
        args: ['session', 'send', sessionId, message, '--json'],
        timeoutMs: 120_000,
      });
      expect(sendEnvelope.ok).toBe(true);
      expect(sendEnvelope.kind).toBe('session_send');

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}`, 120_000);
      await expect(page.getByText(message)).toHaveCount(1, { timeout: 120_000 });

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}/sharing`, 120_000);
      await expect(page.getByText('Create public link')).toHaveCount(1, { timeout: 120_000 });
      await page.getByText('Create public link').click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Create public link' })).toHaveCount(1, { timeout: 60_000 });
      await dialog.getByRole('button', { name: 'Create public link' }).click();

      const shareUrl = await extractPublicShareUrlFromDialog({ dialog });
      expect(shareUrl).toContain('/share/');

      const sharePage = await openShareInFreshContext({ baseContext: context, url: shareUrl });
      await expect(sharePage.getByText('Consent required')).toHaveCount(1, { timeout: 120_000 });
      await sharePage.getByText('Accept and view').click();
      await expect(sharePage.getByText('Public link (read-only)')).toHaveCount(1, { timeout: 120_000 });
      await expect(sharePage.getByText(message)).toHaveCount(1, { timeout: 120_000 });
      await sharePage.context().close().catch(() => {});
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
