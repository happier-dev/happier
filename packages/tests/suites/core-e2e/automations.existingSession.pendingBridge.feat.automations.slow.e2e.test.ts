import { afterEach, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type AutomationDefinitionResponse = Readonly<{
  id: string;
  targetType: 'existingSession';
}>;

type AutomationRunResponse = Readonly<{
  id: string;
  state: string;
  producedSessionId: string | null;
  errorCode: string | null;
}>;

type SessionMessagesResponse = Readonly<{
  messages: ReadonlyArray<Readonly<{
    localId: string | null;
    content: unknown;
  }>>;
}>;

async function requestJson<T>(params: {
  baseUrl: string;
  token: string;
  path: string;
  method?: 'GET' | 'POST';
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

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

describe('core e2e: existing_session automation target', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('admits the Run-owned prompt through the daemon into an existing Session', async () => {
    const testDir = run.testDir('automations-existing-session-pending-bridge');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const daemonAuth = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'tokenOnly',
    });
    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });

    await waitFor(async () => {
      const machine = await requestJson<{ id: string }>({
        baseUrl: server!.baseUrl,
        token: auth.token,
        path: `/v1/machines/${encodeURIComponent(daemonAuth.machineId)}`,
      });
      return machine.id === daemonAuth.machineId;
    }, { timeoutMs: 60_000, intervalMs: 100, context: 'Automation daemon machine registration' });

    const controlToken = (daemon.state as { controlToken?: string }).controlToken;
    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: server.baseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
          HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        },
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    await waitForFakeClaudeInvocation(
      fakeClaudeLogPath,
      (invocation) => invocation.mode === 'sdk',
      { timeoutMs: 60_000, pollMs: 100 },
    );

    const prompt = 'E2E_AUTOMATION_EXISTING_SESSION_PENDING_BRIDGE';
    const created = await requestJson<AutomationDefinitionResponse>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v3/automations',
      method: 'POST',
      body: {
        name: 'Existing-session pending bridge',
        enabled: true,
        trigger: {
          kind: 'schedule',
          schedule: {
            kind: 'interval',
            scheduleExpr: null,
            everyMs: 86_400_000,
            timezone: null,
          },
        },
        executionRecipe: {
          v: 1,
          templateVersion: 1,
          template: { t: 'plain', v: { v: 1, prompt } },
          triggerEvidence: null,
          target: { kind: 'existingSession', sessionId },
        },
        assignments: [{ machineId: daemonAuth.machineId, enabled: true, priority: 1 }],
      },
    });
    expect(created.targetType).toBe('existingSession');

    const runNow = await requestJson<{ run: AutomationRunResponse }>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v3/automations/${encodeURIComponent(created.id)}/run-now`,
      method: 'POST',
    });
    expect(runNow.run.state).toBe('queued');

    await waitFor(async () => {
      const current = await requestJson<AutomationRunResponse>({
        baseUrl: server!.baseUrl,
        token: auth.token,
        path: `/v3/automations/${encodeURIComponent(created.id)}/runs/${encodeURIComponent(runNow.run.id)}`,
      });
      if (current.state !== 'succeeded' && current.state !== 'failed' && current.state !== 'cancelled') {
        return false;
      }
      return true;
    }, { timeoutMs: 90_000, intervalMs: 100, context: 'Automation Run terminal settlement' });

    const terminal = await requestJson<AutomationRunResponse>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v3/automations/${encodeURIComponent(created.id)}/runs/${encodeURIComponent(runNow.run.id)}`,
    });
    expect(terminal.state).toBe('succeeded');
    expect(terminal.producedSessionId).toBe(sessionId);
    expect(terminal.errorCode).toBeNull();

    await waitForFakeClaudeUserText(
      fakeClaudeLogPath,
      (text) => text.includes(prompt),
      { timeoutMs: 90_000, pollMs: 100 },
    );

    const expectedLocalId = `automation:run:${runNow.run.id}`;
    await waitFor(async () => {
      const messages = await requestJson<SessionMessagesResponse>({
        baseUrl: server!.baseUrl,
        token: auth.token,
        path: `/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`,
      });
      return messages.messages.some((message) => message.localId === expectedLocalId);
    }, { timeoutMs: 90_000, intervalMs: 100, context: 'Automation Session input materialization' });

    const messages = await requestJson<SessionMessagesResponse>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`,
    });
    const automationInput = messages.messages.find((message) => message.localId === expectedLocalId);
    expect(automationInput).toBeDefined();
    if (!automationInput) throw new Error('Missing Automation Session input');
    expect(automationInput.content).toEqual(
      expect.objectContaining({
        t: 'plain',
        v: expect.objectContaining({
          role: 'user',
          content: expect.objectContaining({ type: 'text', text: prompt }),
        }),
      }),
    );
  }, 240_000);
});
