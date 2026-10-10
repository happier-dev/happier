import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';

vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocketConnection: () => {
    const socket = Object.assign(new EventEmitter(), {
      connected: false, connect: () => {}, disconnect: () => {}, close: () => {},
    });
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));

// The boundaries are mocked once, hoisted, and each test rebinds their
// behaviour through these stable spies. The predecessor shape — `vi.doMock`
// plus `vi.resetModules()` plus a dynamic `import('./sendSessionMessage')` in
// every test — instantiated this module's (very large) graph once per test and
// exhausted an 8 GiB heap before the file could report a single result.
const boundary = vi.hoisted(() => ({
  enqueuePendingQueueV2MessageViaHttp: vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(),
  readPendingQueueV2DeliveryFailureByLocalIdFromServer:
    vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(),
  fetchEncryptedTranscriptPageAfterSeq: vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(),
  waitForTranscriptEncryptedMessageByLocalId: vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(),
  resolveSessionTransportContext: vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(),
}));

vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  enqueuePendingQueueV2MessageViaHttp: boundary.enqueuePendingQueueV2MessageViaHttp,
  readPendingQueueV2DeliveryFailureByLocalIdFromServer:
    boundary.readPendingQueueV2DeliveryFailureByLocalIdFromServer,
}));
vi.mock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
  fetchEncryptedTranscriptPageAfterSeq: boundary.fetchEncryptedTranscriptPageAfterSeq,
}));
vi.mock('@/api/session/transcriptMessageLookup', () => ({
  // Both adapters use the same HTTP lookup boundary; the direct form does not poll.
  findTranscriptEncryptedMessageByLocalId: boundary.waitForTranscriptEncryptedMessageByLocalId,
  waitForTranscriptEncryptedMessageByLocalId: boundary.waitForTranscriptEncryptedMessageByLocalId,
}));
vi.mock('./resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: boundary.resolveSessionTransportContext,
}));

import { waitForSessionInputResult } from './sendSessionMessage';

describe('waitForSessionInputResult', () => {
  afterEach(() => {
    vi.clearAllMocks();
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
    const {
      enqueuePendingQueueV2MessageViaHttp,
      readPendingQueueV2DeliveryFailureByLocalIdFromServer,
      fetchEncryptedTranscriptPageAfterSeq,
      waitForTranscriptEncryptedMessageByLocalId,
      resolveSessionTransportContext,
    } = boundary;

    enqueuePendingQueueV2MessageViaHttp.mockImplementation(async () => undefined);
    readPendingQueueV2DeliveryFailureByLocalIdFromServer.mockImplementation(async () => null);
    fetchEncryptedTranscriptPageAfterSeq.mockImplementation(async () => [
      inputRow,
      ...params.rowsAfterInput().map((value, index) => ({
        id: `row-${index + 1}`,
        localId: null,
        seq: 8 + index,
        createdAt: 101 + index,
        updatedAt: 101 + index,
        content: { t: 'plain' as const, v: value },
      })),
    ]);
    waitForTranscriptEncryptedMessageByLocalId.mockImplementation(async () => inputRow);
    resolveSessionTransportContext.mockImplementation(async () => ({
      ok: true,
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      accountEncryptionCurrentness: { mode: 'plain' },
      rawSession: {
        id: 'sess-1',
        active: true,
        metadata: '{}',
      },
    }));

    const wait = (timeoutMs = 1_000) =>
      waitForSessionInputResult({
        credentials: {
          token: 'token',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        idOrPrefix: 'sess-1',
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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      idOrPrefix: 'sess-1',
      localId: inputRow.localId,
      observation,
      ...(signal ? { signal } : {}),
    });

    return {
      wait,
      waitWithObservation,
      enqueuePendingQueueV2MessageViaHttp,
      fetchEncryptedTranscriptPageAfterSeq,
      waitForTranscriptEncryptedMessageByLocalId,
    };
  }

  it('observes without an authored deadline instead of normalizing omission to one millisecond', async () => {
    const { waitWithObservation, waitForTranscriptEncryptedMessageByLocalId } = await arrange({
      rowsAfterInput: () => [rawAssistantText('completed without a workflow deadline'), rawLifecycle('task_complete')],
    });

    await expect(waitWithObservation({ kind: 'no_deadline' })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
      result: { kind: 'final_text', text: 'completed without a workflow deadline' },
    });
    expect(waitForTranscriptEncryptedMessageByLocalId).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1', localId: 'automation:run:run-1', timeoutMs: expect.any(Number),
    }));
  });

  it('reports cancelled observation through the incumbent cancellation signal without claiming pending input evidence', async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const { waitWithObservation, waitForTranscriptEncryptedMessageByLocalId } = await arrange({
      rowsAfterInput: () => [],
    });

    await expect(waitWithObservation({ kind: 'no_deadline' }, cancellation.signal)).resolves.toEqual({
      ok: false,
      code: 'cancelled',
    });
    expect(waitForTranscriptEncryptedMessageByLocalId).not.toHaveBeenCalled();
  });

  it('uses the authored absolute deadline without restarting it at observation time', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const { waitWithObservation, waitForTranscriptEncryptedMessageByLocalId } = await arrange({
        rowsAfterInput: () => [rawAssistantText('completed under the original deadline'), rawLifecycle('task_complete')],
      });

      await expect(waitWithObservation({ kind: 'absolute_deadline', deadlineMs: 10_125 })).resolves.toEqual(
        expect.objectContaining({
          ok: true,
          result: { kind: 'final_text', text: 'completed under the original deadline' },
        }),
      );
      expect(waitForTranscriptEncryptedMessageByLocalId).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1', localId: 'automation:run:run-1', timeoutMs: 125,
      }));
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
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
      result: { kind: 'final_text', text: 'exact final answer' },
    });
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
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
      result: {
        kind: 'final_text',
        text: 'usage-bearing answer',
        usage: { inputTokens: 125, outputTokens: 37, costUsd: 0.05 },
      },
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
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
      result: { kind: 'final_text', text: 'answer for this input' },
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
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
      result: { kind: 'final_text', text: 'exact coding result' },
    });
  });

  it('rejoins an already materialized input without dispatching a second prompt', async () => {
    const { wait, enqueuePendingQueueV2MessageViaHttp, waitForTranscriptEncryptedMessageByLocalId } = await arrange({
      rowsAfterInput: () => [
        rawAssistantText('durable final answer'),
        rawLifecycle('task_complete'),
      ],
    });

    await expect(wait()).resolves.toEqual(expect.objectContaining({
      ok: true,
      result: { kind: 'final_text', text: 'durable final answer' },
    }));
    await expect(wait()).resolves.toEqual(expect.objectContaining({
      ok: true,
      result: { kind: 'final_text', text: 'durable final answer' },
    }));

    expect(enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    expect(waitForTranscriptEncryptedMessageByLocalId).toHaveBeenCalledTimes(2);
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
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
      result: { kind: 'pending' },
    });

    completed = true;

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
      result: { kind: 'final_text', text: 'completed after rejoin' },
    });
  });

  it.each([
    ['failed', rawLifecycle('turn_failed'), { kind: 'failed', message: 'Current turn failed' }],
    ['cancelled', rawLifecycle('turn_cancelled'), { kind: 'cancelled', message: 'Current turn cancelled' }],
  ] as const)('preserves an exact turn %s terminal disposition', async (_label, row, result) => {
    const { wait } = await arrange({ rowsAfterInput: () => [row] });

    await expect(wait()).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
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
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
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
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
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
      sessionId: 'sess-1',
      localId: 'automation:run:run-1',
      result: { kind: 'final_text', text },
    });
  });
});
