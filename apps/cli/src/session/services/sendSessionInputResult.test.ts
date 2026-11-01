import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocketConnection: () => {
    const socket = Object.assign(new EventEmitter(), {
      connected: false, connect: () => {}, disconnect: () => {}, close: () => {},
    });
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));

import { waitForSessionInputResult } from './sendSessionMessage';
import { projectSessionMessageReplyOutcome } from './sessionMessageReply';

const sessionId = 'c' + 'a'.repeat(24);
const session = { serverId: 'result-home', sessionId };
const inputMessageRef = { kind: 'session', session, messageId: 'input-row' } as const;
const resultMessageRef = (row: number) => ({ kind: 'session', session, messageId: `row-${row}` } as const);

describe('waitForSessionInputResult', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function rawLifecycle(type: string) {
    return {
      role: 'agent',
      content: {
        type: 'acp',
        data: { type, id: 'turn-1' },
      },
    };
  }

  function rawAssistantText(text: string) {
    return {
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'codex',
        data: { type: 'text', text },
      },
    };
  }

  function rawTurnUsage(params: Readonly<{
    input: number;
    output: number;
    reportedUsd: number;
    scope?: 'turn_delta' | 'session_cumulative';
  }>) {
    return {
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'codex',
        data: {
          type: 'token_count',
          scope: params.scope ?? 'turn_delta',
          source: 'provider_result',
          tokens: {
            input: params.input,
            output: params.output,
          },
          cost: {
            reportedUsd: params.reportedUsd,
            estimatedUsd: 0,
            currency: 'USD',
            costSource: 'provider_reported',
          },
        },
      },
    };
  }

  function rawClaudeOutput(params: Readonly<{
    content: readonly unknown[];
    stopReason?: string;
  }>) {
    return {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: params.content,
            ...(params.stopReason ? { stop_reason: params.stopReason } : {}),
          },
        },
      },
    };
  }

  async function arrange(params: Readonly<{
    rowsAfterInput: () => readonly unknown[];
    beforeReadInput?: () => Promise<void>;
  }>) {
    const inputRow = {
      id: 'input-row',
      localId: 'automation:run:run-1',
      seq: 7,
      createdAt: 100,
      updatedAt: 100,
      content: {
        t: 'plain' as const,
        v: { role: 'user', content: { type: 'text', text: 'Please respond' } },
      },
    };
    const rows = () => [
      inputRow,
      ...params.rowsAfterInput().map((value, index) => ({
        id: `row-${index + 1}`,
        localId: null,
        seq: 8 + index,
        createdAt: 101 + index,
        updatedAt: 101 + index,
        content: { t: 'plain' as const, v: value },
      })),
    ];
    // Only HTTP and Socket.IO are substituted; resolution, crypto admission,
    // transcript parsing, exact result selection and references stay real.
    const httpGet = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
        createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true, metadata: '{}' }) } };
      if (url.includes('/messages/by-local-id/')) {
        await params.beforeReadInput?.();
        return { status: 200, data: { message: inputRow } };
      }
      // These retained inputs predate the Turn ledger. A current empty ledger
      // would authoritatively mean that this input has not begun a turn yet.
      if (url.endsWith('/turns')) return { status: 404, data: { error: 'Not found' } };
      if (url.includes('/messages?')) return { status: 200, data: { messages: rows() } };
      throw new Error(`Unexpected result HTTP read: ${url}`);
    });
    const httpPost = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Result observation cannot dispatch input'));

    const wait = (timeoutMs = 1_000) =>
      waitForSessionInputResult({
        credentials: {
          token: 'token',
          encryption: null,
        },
        serverId: session.serverId,
        idOrPrefix: sessionId,
        localId: inputRow.localId,
        timeoutMs,
      });
    const waitWithObservation = (
      observation:
        | Readonly<{ kind: 'no_deadline' }>
        | Readonly<{ kind: 'absolute_deadline'; deadlineMs: number }>,
      signal?: AbortSignal,
    ) => waitForSessionInputResult({
      credentials: {
        token: 'token',
        encryption: null,
      },
      serverId: session.serverId,
      idOrPrefix: sessionId,
      localId: inputRow.localId,
      observation,
      ...(signal ? { signal } : {}),
    });

    return {
      wait,
      waitWithObservation,
      httpGet,
      httpPost,
    };
  }

  it('observes without an authored deadline instead of normalizing omission to one millisecond', async () => {
    let releaseInput!: () => void;
    const inputHeld = new Promise<void>(resolve => { releaseInput = resolve; });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
    const { waitWithObservation, httpGet } = await arrange({
      rowsAfterInput: () => [rawAssistantText('completed without a workflow deadline'), rawLifecycle('task_complete')],
      beforeReadInput: async () => { markReadStarted(); await inputHeld; },
    });
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    let settled = false;
    const pending = waitWithObservation({ kind: 'no_deadline' }).then(result => { settled = true; return result; });
    try {
      await readStarted;
      // Cross the specific former one-millisecond cutoff while the HTTP read is held.
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(false);
    } finally {
      releaseInput();
      await pending;
    }
    await expect(pending).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: { kind: 'final_text', text: 'completed without a workflow deadline', messageRef: resultMessageRef(1) },
    });
    expect(httpGet).toHaveBeenCalledWith(expect.stringContaining('/messages/by-local-id/automation%3Arun%3Arun-1'),
      expect.objectContaining({ timeout: expect.any(Number) }));
  });

  it('reports cancelled observation through the incumbent cancellation signal without claiming pending input evidence', async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const { waitWithObservation, httpGet } = await arrange({
      rowsAfterInput: () => [],
    });

    await expect(waitWithObservation({ kind: 'no_deadline' }, cancellation.signal)).resolves.toEqual({
      ok: false,
      code: 'cancelled',
    });
    expect(httpGet.mock.calls.some(([url]) => url.includes('/messages/by-local-id/'))).toBe(false);
  });

  it('uses the authored absolute deadline without restarting it at observation time', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const { waitWithObservation, httpGet } = await arrange({
        rowsAfterInput: () => [rawAssistantText('completed under the original deadline'), rawLifecycle('task_complete')],
      });

      await expect(waitWithObservation({ kind: 'absolute_deadline', deadlineMs: 10_125 })).resolves.toEqual(
        expect.objectContaining({
          ok: true,
          result: { kind: 'final_text', text: 'completed under the original deadline', messageRef: resultMessageRef(1) },
        }),
      );
      expect(httpGet).toHaveBeenCalledWith(expect.stringContaining('/messages/by-local-id/automation%3Arun%3Arun-1'),
        expect.objectContaining({ timeout: 125 }));
    } finally {
      now.mockRestore();
    }
  });

  it('returns the exact input turn’s final assistant text under the caller-provided UTF-8 ceiling', async () => {
    const { wait } = await arrange({
      rowsAfterInput: () => [
        rawAssistantText('intermediate status'),
        rawClaudeOutput({
          content: [{ type: 'text', text: 'exact final answer' }],
          stopReason: 'end_turn',
        }),
      ],
    });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: { kind: 'final_text', text: 'exact final answer', messageRef: resultMessageRef(2) },
    });
  });

  it.each(['none', 'unavailable', 'unfulfilled', 'answer'] as const)('rejoins original reply custody %s without upgrading old inputs or inventing answers', async status => {
    const { httpGet } = await arrange({ rowsAfterInput: () => [rawAssistantText('exact answer'), rawLifecycle('task_complete')] });
    const previousGet = httpGet.getMockImplementation()!;
    const outcome = { kind: 'answer' as const, result: { sessionId, messageId: 'row-1' } };
    httpGet.mockImplementation(async (url, config) => url.endsWith('/reply') ? { status: 200, data:
      status === 'none' || status === 'unavailable' ? { v: 1, status } : { v: 1, status: 'available',
        progress: { v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId: 'turn-1', ...(status === 'answer' ? { outcome } : {}) } },
    } : previousGet(url, config));
    const observed = await waitForSessionInputResult({ credentials: { token: 'token', encryption: null }, serverId: session.serverId,
      idOrPrefix: sessionId, localId: 'automation:run:run-1', observeReply: true,
      observation: { kind: 'absolute_deadline', deadlineMs: Date.now() } });
    expect(observed).toMatchObject({ ok: true, result: status === 'none' || status === 'answer'
      ? { kind: 'final_text', text: 'exact answer', messageRef: resultMessageRef(1) } : { kind: 'pending' } });
    if (status === 'answer') expect(observed).toMatchObject({ replyOutcome: outcome });
  });

  it('returns owner-reported turn usage with the exact completed input', async () => {
    const { wait } = await arrange({
      rowsAfterInput: () => [
        rawTurnUsage({ input: 9_000, output: 4_000, reportedUsd: 8, scope: 'session_cumulative' }),
        rawTurnUsage({ input: 120, output: 30, reportedUsd: 0.04 }),
        rawTurnUsage({ input: 5, output: 7, reportedUsd: 0.01 }),
        rawAssistantText('usage-bearing answer'),
        rawLifecycle('task_complete'),
      ],
    });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: {
        kind: 'final_text',
        text: 'usage-bearing answer',
        messageRef: resultMessageRef(4),
        usage: { inputTokens: 125, outputTokens: 37, costUsd: 0.05 },
      },
    });
  });

  it.each(['row-1', 'missing'] as const)('resolves only the stopped partial row for inline and late replies (%s)', async messageId => {
    const { httpGet } = await arrange({ rowsAfterInput: () => [rawAssistantText('Stopped partial'),
      rawLifecycle('turn_cancelled'), rawAssistantText('Unrelated later answer')] });
    const previousGet = httpGet.getMockImplementation()!;
    const outcome = { kind: 'cancelled' as const, result: { sessionId, messageId } };
    httpGet.mockImplementation(async (url, config) => url.endsWith('/reply') ? { status: 200, data: {
      v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId: 'turn-1', outcome },
    } } : previousGet(url, config));
    const observed = await waitForSessionInputResult({ credentials: { token: 'token', encryption: null },
      serverId: session.serverId, idOrPrefix: sessionId, localId: 'automation:run:run-1', observeReply: true,
      observation: { kind: 'absolute_deadline', deadlineMs: Date.now() } });
    expect(observed).toMatchObject({ ok: true, replyOutcome: outcome, result: messageId === 'missing' ? { kind: 'pending' } : {
      kind: 'cancelled', partialText: 'Stopped partial', messageRef: resultMessageRef(1),
    } });
    expect(await projectSessionMessageReplyOutcome({ credentials: { token: 'token', encryption: null },
      serverId: session.serverId, sessionId, localId: 'automation:run:run-1', outcome })).toEqual(messageId === 'missing' ? null : {
      message: 'Stopped partial', sourceMessageRef: resultMessageRef(1),
    });
  });

  it('stops at the correlated turn completion and excludes later unrelated activity', async () => {
    const { wait } = await arrange({
      rowsAfterInput: () => [
        rawAssistantText('answer for this input'),
        rawLifecycle('task_complete'),
        { role: 'user', content: { type: 'text', text: 'unrelated later prompt' } },
        rawAssistantText('unrelated later answer'),
        rawLifecycle('turn_failed'),
      ],
    });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: { kind: 'final_text', text: 'answer for this input', messageRef: resultMessageRef(1) },
    });
  });

  it('continues the Agent-thread result scan across a realtime Voice user row', async () => {
    const { wait } = await arrange({
      rowsAfterInput: () => [
        rawAssistantText('intermediate coding progress'),
        {
          role: 'user',
          content: { type: 'text', text: 'spoken sentence' },
          meta: {
            happier: {
              conversationTurnOriginV1: {
                v: 1,
                channel: 'realtime_conversation',
                modality: 'voice',
              },
            },
          },
        },
        rawClaudeOutput({
          content: [{ type: 'text', text: 'exact coding result' }],
          stopReason: 'end_turn',
        }),
      ],
    });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: { kind: 'final_text', text: 'exact coding result', messageRef: resultMessageRef(3) },
    });
  });

  it('rejoins an already materialized input without dispatching a second prompt', async () => {
    const { wait, httpPost } = await arrange({
      rowsAfterInput: () => [
        rawAssistantText('durable final answer'),
        rawLifecycle('task_complete'),
      ],
    });

    await expect(wait()).resolves.toEqual(expect.objectContaining({
      ok: true,
      inputMessageRef,
      result: { kind: 'final_text', text: 'durable final answer', messageRef: resultMessageRef(1) },
    }));
    await expect(wait()).resolves.toEqual(expect.objectContaining({
      ok: true,
      inputMessageRef,
      result: { kind: 'final_text', text: 'durable final answer', messageRef: resultMessageRef(1) },
    }));

    expect(httpPost).not.toHaveBeenCalled();
  });

  it('reports pending at its wait budget, then returns the same input’s later completion', async () => {
    let completed = false;
    const { wait } = await arrange({
      rowsAfterInput: () => completed
        ? [rawAssistantText('completed after rejoin'), rawLifecycle('task_complete')]
        : [],
    });

    await expect(wait(1)).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: { kind: 'pending' },
    });

    completed = true;

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: { kind: 'final_text', text: 'completed after rejoin', messageRef: resultMessageRef(1) },
    });
  });

  it.each([
    ['failed', rawLifecycle('turn_failed'), { kind: 'failed', message: 'Current turn failed' }],
    ['cancelled', rawLifecycle('turn_cancelled'), { kind: 'cancelled', message: 'Current turn cancelled' }],
  ] as const)('preserves an exact turn %s terminal disposition', async (_label, row, result) => {
    const { wait } = await arrange({ rowsAfterInput: () => [row] });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result,
    });
  });

  it.each([
    ['fails', rawLifecycle('turn_failed'), { kind: 'failed', message: 'Current turn failed' }],
    ['is cancelled', rawLifecycle('turn_cancelled'), { kind: 'cancelled', message: 'Current turn cancelled' }],
  ] as const)('preserves usage incurred before the exact input %s', async (_label, terminal, expected) => {
    const { wait } = await arrange({
      rowsAfterInput: () => [
        rawTurnUsage({ input: 8, output: 3, reportedUsd: 0.02 }),
        terminal,
      ],
    });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: {
        ...expected,
        usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
      },
    });
  });

  it('returns an explicit terminal no-result disposition when completion has no assistant text', async () => {
    const { wait } = await arrange({ rowsAfterInput: () => [rawLifecycle('task_complete')] });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text' },
    });
  });

  it('returns the canonical final text without inventing a consumer-specific ceiling', async () => {
    const text = 'é'.repeat((512 * 1024) + 1);
    const { wait } = await arrange({
      rowsAfterInput: () => [
        rawClaudeOutput({
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
        }),
      ],
    });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId,
      localId: 'automation:run:run-1',
      inputMessageRef,
      result: { kind: 'final_text', text, messageRef: resultMessageRef(1) },
    });
  });
});
