import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { SessionRollbackRpcResultSchema, readSessionRollbackRangesV1FromMetadata } from '@happier-dev/protocol';

import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesSince, fetchSessionV2, type SessionMessageRow } from '../../src/testkit/sessions';
import { callLegacyEncryptedSessionRpc } from '../../src/testkit/sessionRpc';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

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

async function enqueuePromptAndWaitForDrain(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  text: string;
}>): Promise<string> {
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
  }, { timeoutMs: 45_000, context: `drain queued prompt ${params.text}` });

  return localId;
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

    const firstPrompt = `rollback-first-${randomUUID()}`;
    const firstLocalId = await enqueuePromptAndWaitForDrain({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: firstPrompt,
    });
    const firstTurn = await waitForPromptTranscript({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      afterSeq: baselineSeq,
      localId: firstLocalId,
      userText: firstPrompt,
    });

    const secondPrompt = `rollback-second-${randomUUID()}`;
    const secondLocalId = await enqueuePromptAndWaitForDrain({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: secondPrompt,
    });
    const secondTurn = await waitForPromptTranscript({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      afterSeq: firstTurn.sessionSeq,
      localId: secondLocalId,
      userText: secondPrompt,
    });

    const socket = await waitForSocketConnection({ baseUrl: serverBaseUrl, token: auth.token });
    try {
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
        threadId: sessionId,
      });
    } finally {
      socket.close();
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
      expect.objectContaining({ method: 'thread/resume', params: expect.objectContaining({ threadId: sessionId }) }),
      expect.objectContaining({ method: 'thread/rollback', params: { threadId: sessionId, numTurns: 1 } }),
    ]));
  }, 240_000);
});
