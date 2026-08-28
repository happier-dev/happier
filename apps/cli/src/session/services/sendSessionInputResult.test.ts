import { afterEach, describe, expect, it, vi } from 'vitest';

describe('waitForSessionInputResult', () => {
  afterEach(() => {
    vi.doUnmock('@/api/session/fetchEncryptedTranscriptWindow');
    vi.doUnmock('@/api/session/pendingQueueV2Transport');
    vi.doUnmock('@/api/session/transcriptMessageLookup');
    vi.doUnmock('./resolveSessionTransportContext');
    vi.resetModules();
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
    const enqueuePendingQueueV2MessageViaHttp = vi.fn(async () => undefined);
    const readBlockedPendingQueueV2DeliveryByLocalIdFromServer = vi.fn(async () => null);
    const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [
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
    const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => inputRow);

    vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
      enqueuePendingQueueV2MessageViaHttp,
      readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
    }));
    vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
      fetchEncryptedTranscriptPageAfterSeq,
    }));
    vi.doMock('@/api/session/transcriptMessageLookup', () => ({
      waitForTranscriptEncryptedMessageByLocalId,
    }));
    vi.doMock('./resolveSessionTransportContext', () => ({
      resolveSessionTransportContext: vi.fn(async () => ({
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
      })),
    }));

    const { waitForSessionInputResult } = await import('./sendSessionMessage');
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

    return {
      wait,
      enqueuePendingQueueV2MessageViaHttp,
      fetchEncryptedTranscriptPageAfterSeq,
      waitForTranscriptEncryptedMessageByLocalId,
    };
  }

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

  it('stops at the correlated turn completion and excludes later unrelated activity', async () => {
    const { wait } = await arrange({
      rowsAfterInput: () => [
        rawAssistantText('answer for this input'),
        rawLifecycle('task_complete'),
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
