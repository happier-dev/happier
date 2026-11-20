import { test, expect } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema, sealProviderAccountUsageSnapshot } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { enableDirectSessionsFeature } from '../../src/testkit/uiE2e/enableDirectSessionsFeature';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { fetchJson } from '../../src/testkit/http';
import { createPlainSession } from '../../src/testkit/uiE2e/sessionFoldersDrag';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return jsonlLine({ type: 'response_item', timestamp: params.timestamp, payload: params.payload });
}

test.describe('ui e2e: direct Codex sessions browse/open/tail', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-direct-codex-browse-open-tail-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const codexHomeDir = resolve(join(suiteDir, '.codex'));
  const remoteSessionId = '11111111-1111-1111-1111-111111111111';
  const rolloutFile = resolve(join(codexHomeDir, 'sessions', '2026', '03', '06', `rollout-2026-03-06T00-00-00-${remoteSessionId}.jsonl`));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(540_000);
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(resolve(join(codexHomeDir, 'sessions', '2026', '03', '06')), { recursive: true });
    await writeFile(
      rolloutFile,
      [
        jsonlLine({
          type: 'session_meta',
          payload: {
            id: remoteSessionId,
            timestamp: '2026-03-06T00:00:00.000Z',
            cwd: '/tmp/direct-codex-ui-project',
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'older direct codex ui message' }] },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'latest direct codex ui reply' }] },
        }),
      ].join(''),
      'utf8',
    );

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES__QUOTAS__ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPIER_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-codex`,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('links a provider-backed Codex direct session and follows appended rollout lines', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
    const diagnostics = collectBrowserDiagnostics({ page });
    try {

    const testDir = resolve(join(suiteDir, 't1-direct-codex-browse-open-tail'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        CODEX_HOME: codexHomeDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    await enableDirectSessionsFeature(page, uiBaseUrl);
    for (const featureId of ['connectedServices', 'connectedServices.quotas']) {
      await setUiFeatureToggle({ page, baseUrl: uiBaseUrl, featureId, enabled: true });
    }
    const auth = await readCliAccessKey(cliHomeDir);
    if (!auth || !('secret' in auth)) throw new Error('Fixture requires legacy test credentials');
    const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir });
    const recordKey = { providerId: 'codex', accountSubjectId: 'direct-usage-fixture', subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
      observedAtMs: Date.now(), fetchedAtMs: Date.now(), staleAfterMs: 300_000,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', accountLabel: 'Native Codex fixture',
      meters: [{ meterId: 'weekly', label: 'Weekly', used: 100, limit: 100, unit: 'count', utilizationPct: 100,
        resetsAt: Date.now() + 3_600_000, status: 'ok', details: { limitCategory: 'usage_limit' } }],
    });
    const write = await fetchJson(`${server.baseUrl}/v2/connect/provider-account-usage/${snapshot.recordId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordKey,
        sealed: sealProviderAccountUsageSnapshot({ material: { type: 'legacy', secret: Buffer.from(auth.secret, 'base64') }, snapshot, randomBytes }),
        metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
      }), timeoutMs: 20_000,
    });
    expect(write.status).toBe(200);
    await createPlainSession({ baseUrl: server.baseUrl, token: auth.token, machineId,
      title: 'Earlier Codex usage evidence', rootPath: '/tmp/direct-codex-ui-project', tagPrefix: 'native-usage',
      metadata: { flavor: 'codex', providerAccountUsageRefsV1: { v: 1, recordIds: [snapshot.recordId], updatedAtMs: Date.now() } },
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`);
    await expect(page.getByTestId('sessions-list-storage-tab:direct')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('sessions-list-storage-tab:direct').click();

    await expect(page.getByTestId('direct-sessions-browse-button')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('direct-sessions-browse-button').click();
    await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(1, { timeout: 60_000 });

    const searchInput = page.getByTestId('direct-session-candidates-search-input');
    await expect(searchInput).toHaveCount(1, { timeout: 60_000 });
    await searchInput.fill('older direct codex');

    const candidate = page.getByTestId(`direct-session-candidate:${remoteSessionId}`);
    await expect(candidate).toHaveCount(1, { timeout: 120_000 });
    await expect(candidate).toContainText('older direct codex ui message', { timeout: 120_000 });
    await page.getByTestId(`direct-session-candidate:${remoteSessionId}`).click();

    const transcript = page.getByTestId('transcript-chat-list');
    await expect(transcript).toHaveCount(1, { timeout: 120_000 });
    await expect(transcript.getByText('older direct codex ui message')).toHaveCount(1, { timeout: 60_000 });
    await expect(transcript.getByText('latest direct codex ui reply')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('session-chatFooter-directControl')).toBeVisible();
    await expect(page.getByTestId('agent-input-provider-usage-value')).toHaveText('0');
    await page.getByTestId('agent-input-provider-usage-badge').click();
    await expect(page.getByTestId('agent-input-provider-usage-meter')).toBeVisible();
    await page.getByTestId('agent-input-provider-usage-badge').click();
    await page.screenshot({ path: join(testDir, 'direct-codex-usage-before-takeover.png') });

    await appendFile(
      rolloutFile,
      responseItemLine({
        timestamp: '2026-03-06T00:00:03.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'tail appended direct codex ui message' }] },
      }),
      'utf8',
    );

    await expect(transcript.getByText('tail appended direct codex ui message')).toHaveCount(1, { timeout: 60_000 });
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
