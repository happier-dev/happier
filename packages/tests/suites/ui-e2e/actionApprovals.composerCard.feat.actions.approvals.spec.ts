import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import {
  createEncryptedArtifactViaApi,
  decodeEncryptedArtifactJsonBase64ForCliAccessKey,
  fetchArtifactViaApi,
} from '../../src/testkit/artifactApi';
import type { CliAccessKey } from '../../src/testkit/cliAccessKey';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function createSessionTitleApprovalArtifact(params: Readonly<{
  baseUrl: string;
  token: string;
  cliAccessKey: CliAccessKey;
  sessionId: string;
}>): Promise<string> {
  const artifactId = randomUUID();
  const createdAtMs = Date.now();
  const title = 'Approved from composer card';
  const request = {
    v: 1,
    status: 'open',
    createdAtMs,
    updatedAtMs: createdAtMs,
    createdBy: { surface: 'mcp', sessionId: params.sessionId },
    requestedSurface: 'mcp',
    actionId: 'session.title.set',
    actionArgs: { sessionId: params.sessionId, title },
    summary: 'Set session title',
    preview: { actionId: 'session.title.set', actionArgs: { sessionId: params.sessionId, title } },
    approval: { flow: 'deferred', result: 'none' },
  };
  await createEncryptedArtifactViaApi({
    baseUrl: params.baseUrl,
    token: params.token,
    cliAccessKey: params.cliAccessKey,
    artifactId,
    headerJson: {
      v: 1,
      kind: 'approval_request.v1',
      title: 'Set session title',
      approvalStatus: 'open',
      actionId: 'session.title.set',
      sessionId: params.sessionId,
      sessions: [params.sessionId],
    },
    bodyJson: {
      body: JSON.stringify(request),
    },
  });
  return artifactId;
}

test.describe('ui e2e: action approvals (composer card)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('action-approvals-composer-card-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-action-approvals-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_NO_DEV: '0',
      HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS ?? '480000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(cliHomeDir, { recursive: true });

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
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
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

  test('approves a session-scoped action approval from the composer card', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const testDir = resolve(join(suiteDir, 't1-composer-action-approval'));
    await mkdir(testDir, { recursive: true });

    let thrown: unknown = null;
    try {
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

      const fakeClaudePath = fakeClaudeFixturePath();
      daemon = await authenticateAndStartDaemon({
        page,
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        uiBaseUrl,
        extraEnv: {
          HOME: cliHomeDir,
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
        },
      });

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`, 120_000);
      await expect(page.getByTestId('session-getting-started-kind-start_daemon')).toHaveCount(0, { timeout: 120_000 });

      const sessionId = await spawnSessionFromDaemon({
        daemon,
        directory: repoRootDir(),
        agent: 'claude',
      });
      const accessKey = await readCliAccessKey(cliHomeDir);
      if (!accessKey) throw new Error('expected CLI access key after terminal connect');
      const token = accessKey.token;
      const artifactId = await createSessionTitleApprovalArtifact({
        baseUrl: server.baseUrl,
        token,
        cliAccessKey: accessKey,
        sessionId,
      });

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}`, 120_000);
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
      await expect(page.getByTestId('approval-prompt-card')).toHaveCount(1, { timeout: 180_000 });

      await page.getByTestId('approval-prompt-approve').click();
      await expect(page.getByTestId('approval-prompt-card')).toHaveCount(0, { timeout: 120_000 });

      await waitFor(async () => {
        const artifact = await fetchArtifactViaApi({ baseUrl: server!.baseUrl, token, artifactId });
        const bodyEnvelope = decodeEncryptedArtifactJsonBase64ForCliAccessKey<{ body?: unknown }>({
          encryptedJsonBase64: artifact.body,
          dataEncryptionKeyBase64: artifact.dataEncryptionKey,
          cliAccessKey: accessKey,
        });
        if (typeof bodyEnvelope?.body !== 'string') return false;
        const body = JSON.parse(bodyEnvelope.body) as Record<string, unknown>;
        if (body.status === 'failed') {
          const execution = body.execution && typeof body.execution === 'object'
            ? body.execution as Record<string, unknown>
            : {};
          throw new Error(`approval execution failed: ${String(execution.errorCode ?? 'unknown')}`);
        }
        return body.status === 'executed';
      }, { timeoutMs: 60_000, intervalMs: 500, context: 'approval artifact to execute after composer approval' });
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (thrown) {
        await testInfo.attach('note.txt', { body: 'action approval composer card e2e failed', contentType: 'text/plain' });
      }
    }
  });
});
