import { describe, expect, it, vi } from 'vitest';

import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';

import { createAntigravityCliPrintSessionRuntime } from './runtime.js';
import { AntigravityCliPrintOneShotError } from './oneShot.js';

function sendRequest(text: string, turnId = 'turn-1', kind: 'newTurn' | 'steer' = 'newTurn') {
  return {
    inputIds: ['input-1'],
    input: { text },
    delivery: { kind, turnId },
  } as const;
}

describe('Antigravity cliPrint native session runtime', () => {
  it('publishes custody before native lifecycle/output and discovers provider identity', async () => {
    const events: unknown[] = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: 'agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => ({ status: 'completed', stdout: 'done', stderr: '' })),
      discoverConversationId: vi.fn(async () => ({ status: 'found', conversationId: 'conv-1' })),
      now: () => 123,
    });
    runtime.watch((event) => events.push(event));

    await expect(runtime.send(sendRequest('hello'))).resolves.toEqual({ status: 'admitted' });
    expect(events.map((event) => (event as { kind: string }).kind)).toEqual([
      'input-accepted',
      'turn-start',
      'message-delta',
      'provider-session-id',
      'turn-complete',
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'message-delta',
      channel: 'assistant',
      text: 'done',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'provider-session-id',
      providerSessionId: 'conv-1',
    }));
    for (const event of events) expect(AgentSessionRuntimeEventSchema.safeParse(event).success).toBe(true);
  });

  it('maps transcript evidence and a provider error into native events', async () => {
    const events: Array<{ kind: string }> = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: 'agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        transcriptSteps: [
          { kind: 'assistant_message', text: 'answer' },
          { kind: 'error', message: 'provider failed' },
        ],
      })),
    });
    runtime.watch((event) => events.push(event));

    await expect(runtime.send(sendRequest('hello'))).resolves.toEqual({ status: 'admitted' });
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'input-accepted',
      'transcript-message-committed',
      'turn-failed',
    ]));
    expect(events.map((event) => event.kind)).not.toContain('turn-complete');
  });

  it('fails a completed one-shot without provider output evidence', async () => {
    const events: Array<{ kind: string; diagnostic?: { code: string } }> = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: 'agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => ({ status: 'completed', stdout: '', stderr: '' })),
    });
    runtime.watch((event) => events.push(event));

    await expect(runtime.send(sendRequest('hello'))).resolves.toEqual({ status: 'admitted' });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      diagnostic: expect.objectContaining({ code: 'antigravity_cliprint_empty_response' }),
    }));
  });

  it('rejects steering and blank input before launching', async () => {
    const runOneShot = vi.fn();
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: 'agy',
      promptTimeoutMs: 1_000,
      runOneShot,
    });

    await expect(runtime.send(sendRequest('steer', 'turn-steer', 'steer'))).resolves.toMatchObject({
      status: 'unsupported',
    });
    await expect(runtime.send(sendRequest('   '))).resolves.toMatchObject({ status: 'rejected' });
    expect(runOneShot).not.toHaveBeenCalled();
  });

  it('aborts an in-flight one-shot through the native cancel contract', async () => {
    let signal: AbortSignal | undefined;
    const events: Array<{ kind: string }> = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: 'agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async (input) => {
        signal = input.signal;
        await new Promise<void>((_resolve, reject) => input.signal?.addEventListener('abort', () => {
          reject(new AntigravityCliPrintOneShotError({
            code: 'antigravity_cliprint_cancelled',
            message: 'cancelled',
          }));
        }, { once: true }));
        return { status: 'completed', stdout: '', stderr: '' };
      }),
    });
    runtime.watch((event) => events.push(event));

    const send = runtime.send(sendRequest('long running'));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await expect(runtime.cancel?.({ turnId: 'turn-1', reason: 'user' })).resolves.toEqual({
      status: 'requested',
      turnId: 'turn-1',
    });
    expect(signal?.aborted).toBe(true);
    await expect(send).resolves.toMatchObject({ status: 'unavailable' });
    // A one-shot killed before it produced output never proves the provider took the prompt:
    // the CLI carries it in argv of a process that may have written nothing, and the aborted
    // run discovers no conversation id, so the next send opens a fresh conversation. Custody
    // must therefore stay unknown — an `input-accepted` here would admit the prompt upstream
    // and retire a replay activation seed whose text no provider ever received.
    expect(events.map((event) => event.kind)).toEqual(['turn-cancelled', 'input-custody-unknown']);
  });

  it('keeps a delivered one-shot admitted when cancel lands after provider output', async () => {
    const events: Array<{ kind: string }> = [];
    let cancelResult: unknown;
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: 'agy',
      promptTimeoutMs: 1_000,
      // The real host exec races the abort against process exit: the CLI can produce its
      // output and exit 0 while the cancel is in flight. Cancelling here, immediately before
      // the completed result, models that race and covers the whole post-delivery window.
      runOneShot: vi.fn(async () => {
        cancelResult = await runtime.cancel?.({ turnId: 'turn-1', reason: 'user' });
        return { status: 'completed', stdout: 'answer', stderr: '' } as const;
      }),
      discoverConversationId: vi.fn(async () => ({ status: 'not_found' } as const)),
    });
    runtime.watch((event) => events.push(event));

    // The incident shape: the provider took the prompt, then the turn was aborted. Delivery
    // is confirmed, so the input stays admitted, `sendTurnPrompt` resolves, and the host
    // retires the replay seed — the next prompt must not carry it a second time.
    await expect(runtime.send(sendRequest('hello'))).resolves.toEqual({ status: 'admitted' });
    expect(cancelResult).toEqual({ status: 'requested', turnId: 'turn-1' });
    expect(events.map((event) => event.kind)).toContain('input-accepted');
    expect(events.map((event) => event.kind)).not.toContain('input-custody-unknown');
  });

  it('reports unknown custody when one-shot launch outcome is unknown', async () => {
    const events: Array<{ kind: string }> = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: 'agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => { throw new Error('spawn outcome unknown'); }),
    });
    runtime.watch((event) => events.push(event));

    await expect(runtime.send(sendRequest('hello'))).resolves.toMatchObject({
      status: 'unavailable',
      retryable: true,
    });
    expect(events.map((event) => event.kind)).toEqual(['input-custody-unknown']);
  });
});
