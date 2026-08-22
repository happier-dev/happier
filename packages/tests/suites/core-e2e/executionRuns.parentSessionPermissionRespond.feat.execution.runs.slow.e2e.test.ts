import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { callLegacyEncryptedSessionRpc } from '../../src/testkit/sessionRpc';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { fetchSessionV2 } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

function createAnyObjectSchema<T>(): { safeParse: (input: unknown) => { success: true; data: T } | { success: false } } {
  return {
    safeParse(input: unknown) {
      return input && typeof input === 'object' ? { success: true, data: input as T } : { success: false };
    },
  };
}

function readPermissionRequestFromAgentState(agentState: unknown): Readonly<{
  requestId: string;
  responseTarget: Readonly<Record<string, unknown>> | null;
}> | null {
  if (!agentState || typeof agentState !== 'object' || Array.isArray(agentState)) return null;
  const state = agentState as Record<string, unknown>;
  const requests = state.requests;
  if (!requests || typeof requests !== 'object' || Array.isArray(requests)) return null;

  for (const [requestId, requestValue] of Object.entries(requests as Record<string, unknown>)) {
    if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) continue;
    const request = requestValue as Record<string, unknown>;
    const executionRun = request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments)
      ? (request.arguments as Record<string, unknown>).executionRun
      : null;
    if (!executionRun || typeof executionRun !== 'object' || Array.isArray(executionRun)) continue;
    const responseTarget = (executionRun as Record<string, unknown>).responseTarget;
    if (!responseTarget || typeof responseTarget !== 'object' || Array.isArray(responseTarget)) continue;
    if ((responseTarget as Record<string, unknown>).kind !== 'execution_run_host_bridge') continue;

    return {
      requestId,
      responseTarget: responseTarget as Readonly<Record<string, unknown>>,
    };
  }

  return null;
}

function requirePermissionRequest(
  value: Readonly<{
    requestId: string;
    responseTarget: Readonly<Record<string, unknown>> | null;
  }> | null,
): Readonly<{
  requestId: string;
  responseTarget: Readonly<Record<string, unknown>> | null;
}> {
  if (!value) {
    throw new Error('Expected execution-run permission request to be mirrored into agentState');
  }
  return value;
}

describe('core e2e: execution runs (parent-session permission response)', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  }, 60_000);

  it('surfaces a permission request and completes the parent-session approval round trip', async () => {
    const testDir = run.testDir(`execution-runs-parent-session-permission-${randomUUID()}`);
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, auth, mode: 'legacy' });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLog = resolve(join(testDir, 'fake-claude.jsonl'));

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
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
        HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
      },
    });
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

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
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
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

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    try {
      const started = await callLegacyEncryptedSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
        req: {
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Write a file outside the workspace.',
          permissionMode: 'safe-yolo',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
        },
        secret,
        schema: ExecutionRunStartResponseSchema,
        timeoutMs: 45_000,
      });

      expect(started.runId).toBeTypeOf('string');

      let permissionRequest: Readonly<{
        requestId: string;
        responseTarget: Readonly<Record<string, unknown>> | null;
      }> | null = null;
      await waitFor(async () => {
        const session = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        const agentState = session.agentState ? decryptLegacyBase64(session.agentState, secret) : null;
        permissionRequest = readPermissionRequestFromAgentState(agentState);
        return Boolean(
          permissionRequest
          && permissionRequest.responseTarget?.runId === started.runId
          && permissionRequest.responseTarget?.callId === started.callId
          && permissionRequest.responseTarget?.sidechainId === started.sidechainId,
        );
      }, { timeoutMs: 120_000, intervalMs: 250 });

      expect(permissionRequest).not.toBeNull();
      const resolvedPermissionRequest = requirePermissionRequest(permissionRequest);
      expect(resolvedPermissionRequest.responseTarget).toMatchObject({
        kind: 'execution_run_host_bridge',
        sessionId,
        runId: started.runId,
        callId: started.callId,
        sidechainId: started.sidechainId,
        backendId: 'claude',
        providerRequestId: resolvedPermissionRequest.requestId,
      });

      const approved = await callLegacyEncryptedSessionRpc({
        ui,
        sessionId,
        method: `${sessionId}:permission`,
        req: { id: resolvedPermissionRequest.requestId, approved: true },
        secret,
        schema: createAnyObjectSchema<{ ok: boolean }>(),
        timeoutMs: 45_000,
      });
      expect(approved).toMatchObject({ ok: true });

      await waitFor(async () => {
        const session = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        const agentState = session.agentState ? decryptLegacyBase64(session.agentState, secret) : null;
        if (!agentState || typeof agentState !== 'object' || Array.isArray(agentState)) return false;
        const state = agentState as Record<string, unknown>;
        const requests = state.requests && typeof state.requests === 'object' && !Array.isArray(state.requests)
          ? state.requests as Record<string, unknown>
          : {};
        const completedRequests = state.completedRequests && typeof state.completedRequests === 'object' && !Array.isArray(state.completedRequests)
          ? state.completedRequests as Record<string, { status?: unknown }>
          : {};
        return !Object.prototype.hasOwnProperty.call(requests, resolvedPermissionRequest.requestId)
          && completedRequests[resolvedPermissionRequest.requestId]?.status === 'approved';
      }, { timeoutMs: 120_000, intervalMs: 250 });

      const finalSession = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const finalAgentState = finalSession.agentState ? decryptLegacyBase64(finalSession.agentState, secret) : null;
      expect(finalAgentState).not.toBeNull();
      const finalState = finalAgentState as Record<string, unknown>;
      const finalCompletedRequests = finalState.completedRequests && typeof finalState.completedRequests === 'object' && !Array.isArray(finalState.completedRequests)
        ? finalState.completedRequests as Record<string, { status?: unknown }>
        : {};
      expect(finalCompletedRequests[resolvedPermissionRequest.requestId]).toMatchObject({ status: 'approved' });
    } finally {
      ui.disconnect();
      await daemon?.stop().catch(() => {});
      await server?.stop().catch(() => {});
      daemon = null;
      server = null;
    }
  }, 360_000);
});
