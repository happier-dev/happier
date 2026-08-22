import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, stopDaemonFromHomeDir, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

async function requestJson<T>(params: {
  baseUrl: string;
  token: string;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}): Promise<T> {
  const hasBody = params.body !== undefined;
  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${params.token}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(params.body) } : {}),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

describe('core e2e: automation daemon restart recovery', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let daemonHomeDir: string | null = null;

  afterEach(async () => {
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
      daemonHomeDir = null;
    }
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
    }
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('recovers a queued run through a real daemon after it comes back online', async () => {
    const testDir = run.testDir('automations-offline-recovery');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await Promise.all([
      mkdir(daemonHomeDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
    ]);

    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: serverBaseUrl,
      auth,
      mode: 'tokenOnly',
    });
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
    };

    const initialDaemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      startupTimeoutMs: 180_000,
    });
    daemon = initialDaemon;
    await waitFor(async () => {
      const machine = await requestJson<{ id: string }>({
        baseUrl: serverBaseUrl,
        token: auth.token,
        path: `/v1/machines/${encodeURIComponent(seeded.machineId)}`,
      });
      expect(machine.id).toBe(seeded.machineId);
      return true;
    }, { timeoutMs: 60_000, context: 'daemon machine registration' });

    const initialDaemonPid = initialDaemon.state.pid;
    await initialDaemon.stop();
    daemon = null;

    const automation = await requestJson<{ id: string }>({
      baseUrl: serverBaseUrl,
      token: auth.token,
      path: '/v2/automations',
      method: 'POST',
      body: {
        name: 'Offline recovery automation',
        enabled: true,
        schedule: { kind: 'interval', everyMs: 86_400_000 },
        targetType: 'new_session',
        templateCiphertext: JSON.stringify({
          kind: 'happier_automation_template_plain_v1',
          payload: {
            directory: workspaceDir,
            agent: 'claude',
            prompt: 'AUTOMATION_OFFLINE_RECOVERY',
            terminal: { mode: 'plain' },
            sessionEncryptionMode: 'plain',
          },
        }),
        assignments: [{ machineId: seeded.machineId, enabled: true, priority: 1 }],
      },
    });

    const runNow = await requestJson<{ run: { id: string; state: string } }>({
      baseUrl: serverBaseUrl,
      token: auth.token,
      path: `/v2/automations/${encodeURIComponent(automation.id)}/run-now`,
      method: 'POST',
    });
    expect(runNow.run.state).toBe('queued');

    daemon = await startTestDaemon({
      testDir: resolve(join(testDir, 'daemon-after-restart')),
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      startupTimeoutMs: 180_000,
    });
    expect(daemon.state.pid).not.toBe(initialDaemonPid);

    await waitForFakeClaudeInvocation(
      fakeLogPath,
      (invocation) => invocation.mode === 'sdk',
      { timeoutMs: 60_000 },
    );
    await waitFor(async () => {
      const history = await requestJson<{
        runs: Array<{
          id: string;
          state: string;
          claimedByMachineId: string | null;
          producedSessionId: string | null;
        }>;
      }>({
        baseUrl: serverBaseUrl,
        token: auth.token,
        path: `/v2/automations/${encodeURIComponent(automation.id)}/runs`,
      });
      const recoveredRun = history.runs.find((entry) => entry.id === runNow.run.id);
      expect(recoveredRun?.state).toBe('succeeded');
      expect(recoveredRun?.claimedByMachineId).toBe(seeded.machineId);
      expect(recoveredRun?.producedSessionId).toBeTruthy();
      return true;
    }, { timeoutMs: 120_000, context: 'automation daemon restart recovery' });
  }, 240_000);
});
