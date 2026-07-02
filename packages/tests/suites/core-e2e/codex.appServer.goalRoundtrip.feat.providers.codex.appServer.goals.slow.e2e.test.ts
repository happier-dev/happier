import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol';

import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type FakeCodexAppServerRequest,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { callLegacyEncryptedSessionRpc } from '../../src/testkit/sessionRpc';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { repoRootDir } from '../../src/testkit/paths';
import { yarnCommand } from '../../src/testkit/process/commands';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';

const run = createRunDirs({ runLabel: 'core' });

async function connectUserSocket(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<SocketCollector> {
  const socket = createUserScopedSocketCollector(params.baseUrl, params.token);
  socket.connect();
  try {
    await waitFor(async () => socket.isConnected(), {
      timeoutMs: 15_000,
      context: 'connect user-scoped socket for Codex app-server goal e2e',
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function enqueuePromptAndWaitForTranscript(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  afterSeq: number;
  text: string;
}>): Promise<void> {
  const localId = `pending-${randomUUID()}`;
  const enqueue = await enqueuePendingQueueV2({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    localId,
    ciphertext: encryptLegacyBase64(
      {
        role: 'user',
        content: { type: 'text', text: params.text },
        localId,
        meta: { source: 'ui', sentFrom: 'e2e' },
      },
      params.secret,
    ),
    timeoutMs: 20_000,
  });
  expect(enqueue.status).toBe(200);

  await waitFor(async () => {
    const pending = await listPendingQueueV2({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      timeoutMs: 20_000,
    });
    return pending.status === 200
      && Array.isArray(pending.data?.pending)
      && pending.data.pending.every((row) => row.localId !== localId);
  }, { timeoutMs: 45_000, context: 'Codex app-server drains seed prompt before goal RPC' });

  await waitFor(async () => {
    const transcriptRows = await fetchMessagesSince({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      afterSeq: params.afterSeq,
    });
    return transcriptRows.some((row) => row.localId === localId);
  }, { timeoutMs: 45_000, context: 'Codex app-server materializes seed prompt before goal RPC' });
}

function countLoggedRequests(
  requests: readonly FakeCodexAppServerRequest[],
  method: string,
): number {
  return requests.filter((request) => request.method === method).length;
}

async function runCliSessionAction(params: Readonly<{
  harness: StartedCodexAppServerRemoteHarness;
  testDir: string;
  actionId: string;
  input: Record<string, unknown>;
  label: string;
}>): Promise<void> {
  await runLoggedCommand({
    command: yarnCommand(),
    args: [
      '-s',
      'workspace',
      '@happier-dev/cli',
      'dev',
      'session',
      'actions',
      'execute',
      params.harness.sessionId,
      params.actionId,
      '--input-json',
      JSON.stringify({ sessionId: params.harness.sessionId, ...params.input }),
      '--json',
    ],
    cwd: repoRootDir(),
    env: {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: params.harness.cliHome,
      HAPPIER_SERVER_URL: params.harness.serverBaseUrl,
      HAPPIER_WEBAPP_URL: params.harness.serverBaseUrl,
      HAPPIER_CODEX_APP_SERVER_BIN: params.harness.fakeAppServerPath,
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '5000',
    },
    stdoutPath: `${params.testDir}/${params.label}.stdout.log`,
    stderrPath: `${params.testDir}/${params.label}.stderr.log`,
    timeoutMs: 120_000,
  });
}

describe('core e2e: Codex app-server goal session controls', () => {
  let harness: StartedCodexAppServerRemoteHarness | null = null;

  afterEach(async () => {
    await harness?.stop().catch(() => {});
    harness = null;
  });

  it('roundtrips native goal set/get/clear through session RPC and sessionWorkStateV1 metadata', async () => {
    const testDir = run.testDir('codex-app-server-goal-roundtrip');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-goal-roundtrip',
    });
    const { auth, requestLogPath, secret, serverBaseUrl, sessionId } = harness;
    const baselineSeq = harness.readySession.seq ?? 0;
    const objective = `ship session goal e2e ${randomUUID()}`;

    await enqueuePromptAndWaitForTranscript({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      afterSeq: baselineSeq,
      text: `start app-server thread before goal RPC ${randomUUID()}`,
    });

    const socket = await connectUserSocket({ baseUrl: serverBaseUrl, token: auth.token });
    try {
      const setGoal = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_GOAL_SET,
        req: { objective },
        secret,
        schema: SessionWorkStateGetResponseV1Schema,
        timeoutMs: 45_000,
      });

      expect(setGoal.workState).toMatchObject({
        backendId: 'codex',
        primaryItemId: 'goal:thread-started',
        items: [
          expect.objectContaining({
            id: 'goal:thread-started',
            kind: 'goal',
            status: 'active',
            title: objective,
          }),
        ],
      });

      const getGoal = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_GOAL_GET,
        req: {},
        secret,
        schema: SessionWorkStateGetResponseV1Schema,
        timeoutMs: 45_000,
      });
      expect(getGoal.workState?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'goal:thread-started', title: objective }),
      ]));

      await waitFor(async () => {
        const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        const metadata = decryptLegacyBase64Normalized(snap.metadata, secret) as Record<string, unknown> | null;
        const workState = metadata?.sessionWorkStateV1 as { items?: Array<{ id?: unknown; title?: unknown }> } | undefined;
        return workState?.items?.some((item) => item.id === 'goal:thread-started' && item.title === objective) === true;
      }, { timeoutMs: 45_000, context: 'Codex goal metadata persisted after session.goal.set RPC' });

      const clearGoal = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_GOAL_CLEAR,
        req: {},
        secret,
        schema: SessionWorkStateGetResponseV1Schema,
        timeoutMs: 45_000,
      });
      expect(clearGoal.workState?.items ?? []).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'goal:thread-started' }),
      ]));
    } finally {
      socket.close();
    }

    await waitFor(async () => {
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const metadata = decryptLegacyBase64Normalized(snap.metadata, secret) as Record<string, unknown> | null;
      const workState = metadata?.sessionWorkStateV1 as { items?: Array<{ id?: unknown }> } | undefined;
      return !(workState?.items ?? []).some((item) => item.id === 'goal:thread-started');
    }, { timeoutMs: 45_000, context: 'Codex goal metadata cleared after session.goal.clear RPC' });

    const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'thread/goal/set',
        params: expect.objectContaining({ threadId: 'thread-started', objective }),
      }),
      expect.objectContaining({
        method: 'thread/goal/get',
        params: expect.objectContaining({ threadId: 'thread-started' }),
      }),
      expect.objectContaining({
        method: 'thread/goal/clear',
        params: expect.objectContaining({ threadId: 'thread-started' }),
      }),
    ]));
  }, 240_000);

  it('mutates inactive native goal controls without starting a continuation turn', async () => {
    const testDir = run.testDir('codex-app-server-inactive-goal-controls');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-inactive-goal-controls',
      goalSetBehavior: 'nativePartial',
    });
    const { auth, requestLogPath, secret, serverBaseUrl, sessionId } = harness;
    const baselineSeq = harness.readySession.seq ?? 0;
    const objective = `inactive control goal ${randomUUID()}`;

    await enqueuePromptAndWaitForTranscript({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      afterSeq: baselineSeq,
      text: `start app-server thread before inactive goal action ${randomUUID()}`,
    });

    const socket = await connectUserSocket({ baseUrl: serverBaseUrl, token: auth.token });
    try {
      await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_GOAL_SET,
        req: { objective, tokenBudget: 7000 },
        secret,
        schema: SessionWorkStateGetResponseV1Schema,
        timeoutMs: 45_000,
      });
    } finally {
      socket.close();
    }

    const beforeInactiveControls = await readFakeCodexAppServerRequestLog(requestLogPath);
    const turnStartsBeforeInactiveControls = countLoggedRequests(beforeInactiveControls, 'turn/start');
    const resumesBeforeInactiveControls = countLoggedRequests(beforeInactiveControls, 'thread/resume');

    await harness.stopRuntime();

    await runCliSessionAction({
      harness,
      testDir,
      actionId: 'session.goal.set',
      input: { status: 'paused' },
      label: 'pause-inactive-goal',
    });

    await waitFor(async () => {
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const metadata = decryptLegacyBase64Normalized(snap.metadata, secret) as Record<string, unknown> | null;
      const workState = metadata?.sessionWorkStateV1 as { items?: Array<{ id?: unknown; status?: unknown }> } | undefined;
      return workState?.items?.some((item) => item.id === 'goal:thread-started' && item.status === 'paused') === true;
    }, { timeoutMs: 45_000, context: 'inactive session.goal.set status-only persists paused Codex goal metadata' });

    await runCliSessionAction({
      harness,
      testDir,
      actionId: 'session.goal.clear',
      input: {},
      label: 'clear-inactive-goal',
    });

    await waitFor(async () => {
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const metadata = decryptLegacyBase64Normalized(snap.metadata, secret) as Record<string, unknown> | null;
      const workState = metadata?.sessionWorkStateV1 as { items?: Array<{ id?: unknown }> } | undefined;
      return !(workState?.items ?? []).some((item) => item.id === 'goal:thread-started');
    }, { timeoutMs: 45_000, context: 'inactive session.goal.clear removes persisted Codex goal metadata' });

    const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
    const inactiveControlRequests = requests.slice(beforeInactiveControls.length);
    expect(inactiveControlRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'thread/goal/set',
        params: expect.objectContaining({
          threadId: 'thread-started',
          status: 'paused',
        }),
      }),
      expect.objectContaining({
        method: 'thread/goal/clear',
        params: expect.objectContaining({
          threadId: 'thread-started',
        }),
      }),
    ]));
    expect(countLoggedRequests(requests, 'turn/start')).toBe(turnStartsBeforeInactiveControls);
    expect(countLoggedRequests(requests, 'thread/resume')).toBe(resumesBeforeInactiveControls);
  }, 300_000);
});
