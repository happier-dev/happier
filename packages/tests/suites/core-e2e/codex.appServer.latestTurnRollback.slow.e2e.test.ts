import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  SessionRollbackRpcResultSchema,
  SessionUserMessageSendResponseSchema,
  readSessionRollbackRangesV1FromMetadata,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesSince, fetchSessionV2, type SessionMessageRow } from '../../src/testkit/sessions';
import { callLegacyEncryptedSessionRpc } from '../../src/testkit/sessionRpc';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function waitForSocketConnection(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<ReturnType<typeof createUserScopedSocketCollector>> {
  const socket = createUserScopedSocketCollector(params.baseUrl, params.token);
  socket.connect();
  try {
    await waitFor(async () => socket.isConnected(), { timeoutMs: 15_000, context: 'connect user-scoped socket' });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function sendSessionUserMessage(params: Readonly<{
  socket: Awaited<ReturnType<typeof waitForSocketConnection>>;
  sessionId: string;
  secret: Uint8Array;
  text: string;
  localId: string;
}>): Promise<void> {
  const result = await callLegacyEncryptedSessionRpc({
    ui: params.socket,
    sessionId: params.sessionId,
    method: SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
    req: {
      text: params.text,
      localId: params.localId,
      meta: { source: 'codex-app-server-turn-boundary-e2e' },
    },
    secret: params.secret,
    schema: SessionUserMessageSendResponseSchema,
    timeoutMs: 30_000,
  });
  expect(result).toMatchObject({ ok: true });
}

async function waitForLoggedRequest(params: Readonly<{
  requestLogPath: string;
  context: string;
  predicate: (entry: Readonly<{ method?: string; params?: Record<string, unknown> | null }>) => boolean;
}>): Promise<void> {
  await waitFor(async () => {
    const requests = await readFakeCodexAppServerRequestLog(params.requestLogPath);
    return requests.some(params.predicate);
  }, { timeoutMs: 45_000, intervalMs: 250, context: params.context });
}

async function readDecryptedSessionMetadata(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}>): Promise<Record<string, unknown>> {
  const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
  const metadata = decryptLegacyBase64Normalized(snap.metadata, params.secret);
  return isRecord(metadata) ? metadata : {};
}

function readRuntimeTurnIndex(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const value = metadata.sessionRuntimeTurnIndexV1;
  return isRecord(value) ? value : null;
}

function readRuntimeTurnEntries(index: Record<string, unknown> | null): Record<string, unknown>[] {
  const turns = index?.turns;
  return Array.isArray(turns) ? turns.filter(isRecord) : [];
}

async function waitForRuntimeTurnIndex(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  context: string;
  predicate: (index: Record<string, unknown>) => boolean;
}>): Promise<Record<string, unknown>> {
  let matched: Record<string, unknown> | null = null;
  await waitFor(async () => {
    const metadata = await readDecryptedSessionMetadata(params);
    const index = readRuntimeTurnIndex(metadata);
    if (!index || !params.predicate(index)) return false;
    matched = index;
    return true;
  }, { timeoutMs: 45_000, intervalMs: 250, context: params.context });

  if (!matched) {
    throw new Error(`Missing runtime turn index after wait: ${params.context}`);
  }
  return matched;
}

async function waitForPointRollbackRejection(params: Readonly<{
  socket: Awaited<ReturnType<typeof waitForSocketConnection>>;
  sessionId: string;
  secret: Uint8Array;
  targetUserMessageSeq: number;
  context: string;
}>): Promise<void> {
  await waitFor(async () => {
    try {
      const rollback = await callLegacyEncryptedSessionRpc({
        ui: params.socket,
        sessionId: params.sessionId,
        method: 'session.rollback',
        req: { v: 1 as const, target: { type: 'before_user_message' as const, userMessageSeq: params.targetUserMessageSeq } },
        secret: params.secret,
        schema: SessionRollbackRpcResultSchema,
        timeoutMs: 5_000,
      });
      if (rollback.ok === true) {
        throw new Error(`Unsafe point rollback target was accepted: ${JSON.stringify(rollback)}`);
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('(invalid_parameters)')) return true;
      if (message.includes('(turn_in_flight)')) return false;
      throw error;
    }
  }, {
    timeoutMs: 45_000,
    intervalMs: 500,
    context: params.context,
    shouldRetryOnError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes('Unsafe point rollback target was accepted');
    },
  });
}

async function waitForPromptTranscript(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  afterSeq: number;
  localId: string;
  userText: string;
}>): Promise<Readonly<{
  rows: SessionMessageRow[];
  userRow: SessionMessageRow;
  sessionSeq: number;
}>> {
  let latestRows: SessionMessageRow[] = [];
  let latestSessionSeq = params.afterSeq;

  await waitFor(async () => {
    latestRows = await fetchMessagesSince({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      afterSeq: params.afterSeq,
    });
    const userRow = latestRows.find((row) => row.localId === params.localId) ?? null;
    if (!userRow) return false;
    const userRecord = decryptLegacyBase64Normalized(userRow.content.c, params.secret) as Record<string, unknown> | null;
    const userContent = userRecord?.content as Record<string, unknown> | undefined;
    if (!(userRecord?.role === 'user' && userContent?.type === 'text' && userContent.text === params.userText)) return false;

    const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    latestSessionSeq = typeof snap.seq === 'number' ? snap.seq : params.afterSeq;
    return latestRows.length > 0 && latestSessionSeq > params.afterSeq;
  }, { timeoutMs: 45_000, context: `materialize transcript for ${params.userText}` });

  const userRow = latestRows.find((row) => row.localId === params.localId);
  if (!userRow) {
    throw new Error(`missing transcript rows for ${params.userText}`);
  }

  return {
    rows: latestRows,
    userRow,
    sessionSeq: latestSessionSeq,
  };
}

describe('core e2e: Codex app-server latest-turn rollback', () => {
  let harness: StartedCodexAppServerRemoteHarness | null = null;

  afterEach(async () => {
    await harness?.stop().catch(() => {});
    harness = null;
  });

  it('rolls back the latest turn via session RPC and records rollback metadata for the latest turn seq range', async () => {
    const testDir = run.testDir('codex-app-server-latest-turn-rollback');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-latest-turn-rollback',
    });
    const { auth, requestLogPath, secret, serverBaseUrl, sessionId } = harness;

    const baselineSeq = harness.readySession.seq ?? 0;

    const socket = await waitForSocketConnection({ baseUrl: serverBaseUrl, token: auth.token });
    let rollbackThreadId: string | null = null;
    try {
      const firstPrompt = `rollback-first-${randomUUID()}`;
      const firstLocalId = `rollback-first-${randomUUID()}`;
      await sendSessionUserMessage({ socket, sessionId, secret, text: firstPrompt, localId: firstLocalId });
      const firstTurn = await waitForPromptTranscript({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        afterSeq: baselineSeq,
        localId: firstLocalId,
        userText: firstPrompt,
      });

      await waitForRuntimeTurnIndex({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        context: 'runtime turn index records first completed latest rollback turn',
        predicate: (index) => readRuntimeTurnEntries(index).some((turn) =>
          turn.status === 'completed' && turn.startUserMessageSeq === firstTurn.userRow.seq,
        ),
      });

      const secondPrompt = `rollback-second-${randomUUID()}`;
      const secondLocalId = `rollback-second-${randomUUID()}`;
      await sendSessionUserMessage({ socket, sessionId, secret, text: secondPrompt, localId: secondLocalId });
      const secondTurn = await waitForPromptTranscript({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        afterSeq: firstTurn.sessionSeq,
        localId: secondLocalId,
        userText: secondPrompt,
      });

      await waitForRuntimeTurnIndex({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        context: 'runtime turn index records two completed latest rollback turns',
        predicate: (index) => readRuntimeTurnEntries(index).some((turn) =>
          turn.status === 'completed' && turn.startUserMessageSeq === secondTurn.userRow.seq,
        ),
      });

      const rollback = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: 'session.rollback',
        req: { v: 1 as const, target: { type: 'latest_turn' as const } },
        secret,
        schema: SessionRollbackRpcResultSchema,
        timeoutMs: 30_000,
      });
      expect(rollback).toMatchObject({
        ok: true,
        target: { type: 'latest_turn' },
        threadId: expect.any(String),
      });
      rollbackThreadId = typeof rollback.threadId === 'string' ? rollback.threadId : null;
      if (typeof rollbackThreadId !== 'string') {
        throw new Error('Expected rollback to return an app-server thread id');
      }

      await waitFor(async () => {
        const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        const metadata = decryptLegacyBase64Normalized(snap.metadata, secret) as Record<string, unknown> | null;
        const rollbackRanges = readSessionRollbackRangesV1FromMetadata(metadata);
        const latestRange = rollbackRanges?.ranges.at(-1) ?? null;
        return Boolean(
          latestRange
          && latestRange.target.type === 'latest_turn'
          && latestRange.startSeqInclusive <= secondTurn.userRow.seq
          && latestRange.endSeqInclusive >= secondTurn.userRow.seq,
        );
      }, { timeoutMs: 45_000, context: 'codex app-server rollback metadata persists latest-turn range' });

      const finalSession = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const finalMetadata = decryptLegacyBase64Normalized(finalSession.metadata, secret) as Record<string, unknown> | null;
      const rollbackRanges = readSessionRollbackRangesV1FromMetadata(finalMetadata);
      const latestRange = rollbackRanges?.ranges.at(-1) ?? null;
      expect(latestRange).toMatchObject({
        target: { type: 'latest_turn' },
        rolledBackAt: expect.any(Number),
      });
      expect(latestRange?.startSeqInclusive).toBeLessThanOrEqual(secondTurn.userRow.seq);
      expect(latestRange?.endSeqInclusive).toBeGreaterThanOrEqual(secondTurn.userRow.seq);

      expect(secondTurn.userRow.seq).toBeGreaterThan(firstTurn.sessionSeq);
      expect(secondTurn.rows.some((row) => row.seq >= (latestRange?.startSeqInclusive ?? Number.MAX_SAFE_INTEGER) && row.seq <= (latestRange?.endSeqInclusive ?? -1))).toBe(true);

      const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'thread/start' }),
        expect.objectContaining({ method: 'thread/rollback', params: { threadId: rollbackThreadId, numTurns: 1 } }),
      ]));
    } finally {
      socket.close();
    }
  }, 240_000);

  it('rolls back from the first completed turn start across two completed turns', async () => {
    const testDir = run.testDir('codex-app-server-first-turn-rollback');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-first-turn-rollback',
    });
    const { auth, requestLogPath, secret, serverBaseUrl, sessionId } = harness;

    const baselineSeq = harness.readySession.seq ?? 0;

    const socket = await waitForSocketConnection({ baseUrl: serverBaseUrl, token: auth.token });
    let rollbackThreadId: string | null = null;
    try {
      const firstPrompt = `rollback-first-point-${randomUUID()}`;
      const firstLocalId = `rollback-first-point-${randomUUID()}`;
      await sendSessionUserMessage({ socket, sessionId, secret, text: firstPrompt, localId: firstLocalId });
      const firstTurn = await waitForPromptTranscript({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        afterSeq: baselineSeq,
        localId: firstLocalId,
        userText: firstPrompt,
      });

      await waitForRuntimeTurnIndex({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        context: 'runtime turn index records first completed point rollback turn',
        predicate: (index) => readRuntimeTurnEntries(index).some((turn) =>
          turn.status === 'completed' && turn.startUserMessageSeq === firstTurn.userRow.seq,
        ),
      });

      const secondPrompt = `rollback-second-point-${randomUUID()}`;
      const secondLocalId = `rollback-second-point-${randomUUID()}`;
      await sendSessionUserMessage({ socket, sessionId, secret, text: secondPrompt, localId: secondLocalId });
      const secondTurn = await waitForPromptTranscript({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        afterSeq: firstTurn.sessionSeq,
        localId: secondLocalId,
        userText: secondPrompt,
      });

      await waitForRuntimeTurnIndex({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        context: 'runtime turn index records two completed point rollback turns',
        predicate: (index) => readRuntimeTurnEntries(index).some((turn) =>
          turn.status === 'completed' && turn.startUserMessageSeq === secondTurn.userRow.seq,
        ),
      });

      const rollback = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: 'session.rollback',
        req: { v: 1 as const, target: { type: 'before_user_message' as const, userMessageSeq: firstTurn.userRow.seq } },
        secret,
        schema: SessionRollbackRpcResultSchema,
        timeoutMs: 30_000,
      });
      expect(rollback).toMatchObject({
        ok: true,
        target: { type: 'before_user_message', userMessageSeq: firstTurn.userRow.seq },
        threadId: expect.any(String),
      });
      rollbackThreadId = typeof rollback.threadId === 'string' ? rollback.threadId : null;
      if (typeof rollbackThreadId !== 'string') {
        throw new Error('Expected point rollback to return an app-server thread id');
      }

      await waitFor(async () => {
        const metadata = await readDecryptedSessionMetadata({ baseUrl: serverBaseUrl, token: auth.token, sessionId, secret });
        const rollbackRanges = readSessionRollbackRangesV1FromMetadata(metadata);
        const pointRange = rollbackRanges?.ranges.at(-1) ?? null;
        return Boolean(
          pointRange
          && pointRange.target.type === 'before_user_message'
          && pointRange.target.userMessageSeq === firstTurn.userRow.seq
          && pointRange.startSeqInclusive <= firstTurn.userRow.seq
          && pointRange.endSeqInclusive >= secondTurn.userRow.seq,
        );
      }, { timeoutMs: 45_000, context: 'codex app-server rollback metadata persists first-turn point range' });

      const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'thread/start' }),
        expect.objectContaining({ method: 'thread/rollback', params: { threadId: rollbackThreadId, numTurns: 2 } }),
      ]));
    } finally {
      socket.close();
    }
  }, 240_000);

  it('rejects a steer user row as an old-UI point rollback target while allowing the parent turn start', async () => {
    const testDir = run.testDir('codex-app-server-steer-turn-boundary-rollback');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-steer-turn-boundary-rollback',
      cliEnvOverrides: {
        HAPPIER_E2E_FAKE_CODEX_APP_SERVER_TURN_DELAY_MS: '2500',
      },
    });
    const { auth, requestLogPath, secret, serverBaseUrl, sessionId } = harness;
    const baselineSeq = harness.readySession.seq ?? 0;

    const socket = await waitForSocketConnection({ baseUrl: serverBaseUrl, token: auth.token });
    try {
      const startText = `rollback-steer-start-${randomUUID()}`;
      const startLocalId = `rollback-steer-start-${randomUUID()}`;
      await sendSessionUserMessage({
        socket,
        sessionId,
        secret,
        text: startText,
        localId: startLocalId,
      });

      await waitForLoggedRequest({
        requestLogPath,
        context: 'Codex app-server receives primary turn/start before steer rollback e2e',
        predicate: (entry) => entry.method === 'turn/start',
      });

      const steerText = `rollback-steer-nudge-${randomUUID()}`;
      const steerLocalId = `rollback-steer-nudge-${randomUUID()}`;
      await sendSessionUserMessage({
        socket,
        sessionId,
        secret,
        text: steerText,
        localId: steerLocalId,
      });

      await waitForLoggedRequest({
        requestLogPath,
        context: 'Codex app-server receives turn/steer before rollback e2e',
        predicate: (entry) => entry.method === 'turn/steer',
      });

      const startTurn = await waitForPromptTranscript({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        afterSeq: baselineSeq,
        localId: startLocalId,
        userText: startText,
      });
      const steerTurn = await waitForPromptTranscript({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        afterSeq: baselineSeq,
        localId: steerLocalId,
        userText: steerText,
      });

      await waitForPointRollbackRejection({
        socket,
        sessionId,
        secret,
        targetUserMessageSeq: steerTurn.userRow.seq,
        context: 'steer user row is rejected as a point rollback target',
      });

      const turnIndex = await waitForRuntimeTurnIndex({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        secret,
        context: 'runtime turn index records completed steer turn',
        predicate: (index) => readRuntimeTurnEntries(index).some((turn) =>
          turn.status === 'completed'
          && turn.startUserMessageSeq === startTurn.userRow.seq
          && Array.isArray(turn.userMessageSeqs)
          && turn.userMessageSeqs.includes(startTurn.userRow.seq)
          && turn.userMessageSeqs.includes(steerTurn.userRow.seq)
          && typeof turn.endSeqInclusive === 'number',
        ),
      });
      expect(readRuntimeTurnEntries(turnIndex)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'completed',
          startUserMessageSeq: startTurn.userRow.seq,
          userMessageSeqs: expect.arrayContaining([startTurn.userRow.seq, steerTurn.userRow.seq]),
          endSeqInclusive: expect.any(Number),
        }),
      ]));

      const startRollback = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: 'session.rollback',
        req: { v: 1 as const, target: { type: 'before_user_message' as const, userMessageSeq: startTurn.userRow.seq } },
        secret,
        schema: SessionRollbackRpcResultSchema,
        timeoutMs: 30_000,
      });
      expect(startRollback).toMatchObject({
        ok: true,
        target: { type: 'before_user_message', userMessageSeq: startTurn.userRow.seq },
        threadId: expect.any(String),
      });
      const rollbackThreadId = typeof startRollback.threadId === 'string' ? startRollback.threadId : null;
      if (typeof rollbackThreadId !== 'string') {
        throw new Error('Expected steer parent rollback to return an app-server thread id');
      }

      await waitForLoggedRequest({
        requestLogPath,
        context: 'Codex app-server receives parent turn rollback after steer rejection',
        predicate: (entry) =>
          entry.method === 'thread/rollback'
          && entry.params?.threadId === rollbackThreadId
          && entry.params?.numTurns === 1,
      });
    } finally {
      socket.close();
    }
  }, 240_000);

  it('uses persisted turn-index metadata as durable rollback evidence without process-local turn ranges', async () => {
    const testDir = run.testDir('codex-app-server-durable-turn-index-rollback');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-durable-turn-index-rollback',
      metadataOverrides: {
        codexSessionId: 'thread-started',
        sessionRuntimeTurnIndexV1: {
          v: 1,
          backendId: 'codex-app-server',
          agentId: 'codex',
          providerThreadId: 'thread-started',
          updatedAt: 300,
          turns: [
            {
              turnId: 'persisted-turn-1',
              startUserMessageSeq: 101,
              startUserMessageLocalId: 'persisted-local-1',
              userMessageSeqs: [101],
              userMessageLocalIds: ['persisted-local-1'],
              startSeqInclusive: 101,
              endSeqInclusive: 110,
              status: 'completed',
              startedAt: 100,
              completedAt: 110,
              updatedAt: 110,
            },
            {
              turnId: 'persisted-turn-2',
              startUserMessageSeq: 121,
              startUserMessageLocalId: 'persisted-local-2',
              userMessageSeqs: [121],
              userMessageLocalIds: ['persisted-local-2'],
              startSeqInclusive: 121,
              endSeqInclusive: 130,
              status: 'completed',
              startedAt: 120,
              completedAt: 130,
              updatedAt: 130,
            },
          ],
        },
      },
    });
    const { auth, requestLogPath, secret, serverBaseUrl, sessionId } = harness;

    await waitForLoggedRequest({
      requestLogPath,
      context: 'Codex app-server starts or resumes durable turn-index rollback session',
      predicate: (entry) => entry.method === 'thread/start' || entry.method === 'thread/resume',
    });

    const socket = await waitForSocketConnection({ baseUrl: serverBaseUrl, token: auth.token });
    try {
      const rollback = await callLegacyEncryptedSessionRpc({
        ui: socket,
        sessionId,
        method: 'session.rollback',
        req: { v: 1 as const, target: { type: 'before_user_message' as const, userMessageSeq: 101 } },
        secret,
        schema: SessionRollbackRpcResultSchema,
        timeoutMs: 30_000,
      });
      expect(rollback).toMatchObject({
        ok: true,
        target: { type: 'before_user_message', userMessageSeq: 101 },
        threadId: expect.any(String),
      });
      const rollbackThreadId = typeof rollback.threadId === 'string' ? rollback.threadId : null;
      if (typeof rollbackThreadId !== 'string') {
        throw new Error('Expected durable metadata rollback to return an app-server thread id');
      }

      await waitForLoggedRequest({
        requestLogPath,
        context: 'Codex app-server receives durable metadata point rollback',
        predicate: (entry) =>
          entry.method === 'thread/rollback'
          && entry.params?.threadId === rollbackThreadId
          && entry.params?.numTurns === 2,
      });
    } finally {
      socket.close();
    }
  }, 240_000);
});
