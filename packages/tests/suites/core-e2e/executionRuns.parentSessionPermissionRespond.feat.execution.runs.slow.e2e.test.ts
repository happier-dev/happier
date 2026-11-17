import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol';
import { readRunScopedExecutionPermissionRequestIdentity } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { readDecryptedSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { repoRootDir } from '../../src/testkit/paths';

const run = createRunDirs({ runLabel: 'core' });

function readPermissionRequestFromAgentState(agentState: unknown, runId: string): Readonly<{
  requestId: string;
}> | null {
  if (!agentState || typeof agentState !== 'object' || Array.isArray(agentState)) return null;
  const state = agentState as Record<string, unknown>;
  const requests = state.requests;
  if (!requests || typeof requests !== 'object' || Array.isArray(requests)) return null;

  for (const [requestId, requestValue] of Object.entries(requests as Record<string, unknown>)) {
    if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) continue;
    if (readRunScopedExecutionPermissionRequestIdentity(requestId)?.runId !== runId) continue;
    return { requestId };
  }

  return null;
}

function requirePermissionRequest(
  value: Readonly<{
    requestId: string;
  }> | null,
): Readonly<{
  requestId: string;
}> {
  if (!value) {
    throw new Error('Expected execution-run permission request to be mirrored into agentState');
  }
  return value;
}

describe('core e2e: execution runs (parent-session permission response)', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let person: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;

  afterAll(async () => {
    await person?.close();
    await daemon?.stop().catch(() => {});
    await server?.stop();
  }, 60_000);

  it('associates approval and denial with their own pending execution-run requests', async () => {
    const testDir = run.testDir(`execution-runs-parent-session-permission-${randomUUID()}`);
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
      'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    server = await startServerLight({ testDir, extraEnv: { NODE_OPTIONS: sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1' } });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, auth, mode: 'legacy' });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLog = resolve(join(testDir, 'fake-claude.jsonl'));

    daemon = await startTestDaemon({
      requireMachineControlReady: true,
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        NODE_OPTIONS: sourceOptions,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
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
    const controlToken = daemon.state.controlToken;

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

    person = await connectUiPersonActionClient({ serverUrl: server.baseUrl, accountSecret: auth.accountSigningSeed });
    const requester = person;

    try {
      let sessionContentObservation: unknown = null;
      const readAgentState = async () => {
        const snapshot = await readDecryptedSessionMetadataV2({
          baseUrl: server!.baseUrl,
          token: auth.token,
          sessionId,
          includeAgentState: true,
          machineKeys: [auth.accountMachineKey],
        });
        sessionContentObservation = { metadataLayoutVersion: snapshot.sessionBefore.metadataLayoutVersion,
          encryptionMode: snapshot.sessionBefore.encryptionMode,
          hasStoredAgentState: snapshot.sessionBefore.agentState !== null,
          selectedUsesDataKeyVariant: snapshot.selectedUsesDataKeyVariant };
        return snapshot.agentState;
      };
      const startRun = async () => {
        const result = await requester.executeConfirmed('execution.run.start', {
          sessionId,
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Write a file outside the workspace.',
          // This cold parent has not observed a native model; this journey exercises permission routing.
          modelSelection: null,
          permissionMode: 'safe-yolo',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
        }, { defaultSessionId: sessionId, actionCaller: { kind: 'host' } });
        if (!result.ok) throw new Error(`Execution Run refused (${result.errorCode})`);
        return ExecutionRunStartResponseSchema.parse(result.result);
      };

      const started = await startRun();
      expect(started.runId).toBeTypeOf('string');

      let permissionRequest: Readonly<{
        requestId: string;
      }> | null = null;
      let permissionObservation: unknown = null;
      await waitFor(async () => {
        const agentState = await readAgentState();
        const state = agentState && typeof agentState === 'object' && !Array.isArray(agentState)
          ? agentState as Record<string, unknown> : null;
        const requests = state?.requests && typeof state.requests === 'object' && !Array.isArray(state.requests)
          ? state.requests as Record<string, unknown> : {};
        permissionObservation = {
          sessionContent: sessionContentObservation,
          stateKeys: state ? Object.keys(state).sort() : null,
          requests: Object.entries(requests).map(([requestId, value]) => {
            const request = value && typeof value === 'object' && !Array.isArray(value)
              ? value as Record<string, unknown> : null;
            return { requestKeys: request ? Object.keys(request).sort() : null,
              runMatches: readRunScopedExecutionPermissionRequestIdentity(requestId)?.runId === started.runId };
          }),
        };
        permissionRequest = readPermissionRequestFromAgentState(agentState, started.runId);
        return Boolean(permissionRequest);
      }, { timeoutMs: 120_000, intervalMs: 250 }).catch(cause => {
        throw new Error(`Pending Run permission state observation: ${JSON.stringify(permissionObservation)}`, { cause });
      });

      expect(permissionRequest).not.toBeNull();
      const resolvedPermissionRequest = requirePermissionRequest(permissionRequest);
      const firstIdentity = readRunScopedExecutionPermissionRequestIdentity(resolvedPermissionRequest.requestId);
      expect(firstIdentity).toMatchObject({ runId: started.runId });
      expect(firstIdentity?.providerRequestId).not.toBe(resolvedPermissionRequest.requestId);

      const second = await startRun();
      let secondRequest: ReturnType<typeof readPermissionRequestFromAgentState> = null;
      await waitFor(async () => {
        secondRequest = readPermissionRequestFromAgentState(await readAgentState(), second.runId);
        return Boolean(secondRequest);
      }, { timeoutMs: 120_000, intervalMs: 250 });
      const otherRequest = requirePermissionRequest(secondRequest);
      const secondIdentity = readRunScopedExecutionPermissionRequestIdentity(otherRequest.requestId);
      expect(secondIdentity).toMatchObject({ runId: second.runId });
      expect(otherRequest.requestId).not.toBe(resolvedPermissionRequest.requestId);
      expect(secondIdentity?.providerRequestId).not.toBe(otherRequest.requestId);

      const approved = await person.executeConfirmed('session.permission.respond', {
        sessionId, requestId: resolvedPermissionRequest.requestId, decision: 'allow',
      }, { surface: 'ui', authority: 'present_user', serverId: person.serverId,
        actionCaller: { kind: 'host' } });
      expect(approved).toMatchObject({ ok: true, result: { ok: true } });

      await waitFor(async () => {
        const agentState = await readAgentState();
        if (!agentState || typeof agentState !== 'object' || Array.isArray(agentState)) return false;
        const state = agentState as Record<string, unknown>;
        const requests = state.requests && typeof state.requests === 'object' && !Array.isArray(state.requests)
          ? state.requests as Record<string, unknown>
          : {};
        const completedRequests = state.completedRequests && typeof state.completedRequests === 'object' && !Array.isArray(state.completedRequests)
          ? state.completedRequests as Record<string, { status?: unknown }>
          : {};
        return !Object.prototype.hasOwnProperty.call(requests, resolvedPermissionRequest.requestId)
          && completedRequests[resolvedPermissionRequest.requestId]?.status === 'approved'
          && Object.prototype.hasOwnProperty.call(requests, otherRequest.requestId)
          && !Object.prototype.hasOwnProperty.call(completedRequests, otherRequest.requestId);
      }, { timeoutMs: 120_000, intervalMs: 250 });

      expect(await person.executeConfirmed('session.permission.respond', {
        sessionId, requestId: otherRequest.requestId, decision: 'deny',
      }, { surface: 'ui', authority: 'present_user', serverId: person.serverId,
        actionCaller: { kind: 'host' } })).toMatchObject({ ok: true, result: { ok: true } });
      await waitFor(async () => {
        const state = await readAgentState();
        return state !== null && typeof state === 'object' && 'completedRequests' in state
          && Boolean(state.completedRequests && typeof state.completedRequests === 'object'
            && otherRequest.requestId in state.completedRequests
            && (state.completedRequests as Record<string, { status?: unknown }>)[otherRequest.requestId]?.status === 'denied');
      }, { timeoutMs: 120_000, intervalMs: 250 });

      const finalAgentState = await readAgentState();
      expect(finalAgentState).not.toBeNull();
      const finalState = finalAgentState as Record<string, unknown>;
      const finalCompletedRequests = finalState.completedRequests && typeof finalState.completedRequests === 'object' && !Array.isArray(finalState.completedRequests)
        ? finalState.completedRequests as Record<string, { status?: unknown }>
        : {};
      expect(finalCompletedRequests[resolvedPermissionRequest.requestId]).toMatchObject({ status: 'approved' });
      expect(finalCompletedRequests[otherRequest.requestId]).toMatchObject({ status: 'denied' });
    } finally {
      await person?.close();
      person = undefined;
      await daemon?.stop().catch(() => {});
      await server?.stop().catch(() => {});
      daemon = null;
      server = null;
    }
  }, 0);
});
