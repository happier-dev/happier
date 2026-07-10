import { describe, expect, it, vi } from 'vitest';

import { RuntimeEventV1Schema } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { createAntigravityCliPrintSessionRuntime } from './runtime.js';
import { AntigravityCliPrintOneShotError } from './oneShot.js';

function expectValidRuntimeEvents(events: readonly unknown[]): void {
  for (const event of events) {
    expect(RuntimeEventV1Schema.safeParse(event).success).toBe(true);
  }
}

describe('Antigravity cliPrint runtime', () => {
  it('runs the first turn through one-shot, discovers the conversation id, and emits a descriptor update', async () => {
    const events: unknown[] = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => ({ status: 'completed', stdout: 'done', stderr: '' })),
      discoverConversationId: vi.fn(async () => ({ status: 'found', conversationId: 'conv-1' })),
      now: () => 123,
    });
    runtime.events.subscribe((event) => events.push(event));

    await expect(runtime.send({ v: 1, text: 'hello' }, { turnId: 'turn-1' })).resolves.toEqual({
      status: 'accepted',
      turnId: 'turn-1',
      agentTurnId: 'conv-1',
    });

    expect(runtime.identity.read()).toEqual({ providerSessionId: 'conv-1' });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'descriptor-update',
      descriptor: expect.objectContaining({
        agentId: 'antigravity',
        agent: expect.objectContaining({
          runtimeMode: 'cliPrint',
          agyConversationId: 'conv-1',
        }),
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId: 'turn-1' }));
    expectValidRuntimeEvents(events);
  });

  it('emits assistant transcript events from transcript evidence when stdout is empty', async () => {
    const events: unknown[] = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => ({
        status: 'completed' as const,
        stdout: '',
        stderr: '',
        transcriptSteps: [
          { id: 'assistant-1', kind: 'assistant_message' as const, text: 'from transcript' },
        ],
      })),
      now: () => 123,
    });
    runtime.events.subscribe((event) => events.push(event));

    await expect(runtime.send({ v: 1, text: 'hello' }, { turnId: 'turn-1' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'turn-1',
    });

    expect(events.map((event) => (event as { kind?: string }).kind)).toEqual([
      'turn-start',
      'transcript-agent-message-committed',
      'turn-complete',
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      agentId: 'antigravity',
      localId: 'assistant-1',
      body: { type: 'message', message: 'from transcript' },
    }));
    expectValidRuntimeEvents(events);
  });

  it('confirms provider acceptance only after one-shot output evidence', async () => {
    const events: unknown[] = [];
    let resolveRun: ((result: { status: 'completed'; stdout: string; stderr: string }) => void) | null = null;
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(() => new Promise((resolve) => {
        resolveRun = resolve;
      })),
      now: () => 123,
    });
    const accepted = vi.fn();
    runtime.events.subscribe((event) => events.push(event));
    runtime.setOnPromptAcceptedByProvider?.(accepted);

    const send = runtime.send({ v: 1, text: 'hello' }, {
      turnId: 'turn-1',
      localInputId: 'local-1',
      localInputIds: ['local-1', 'local-2'],
      userMessageSeq: 12,
      userMessageSeqs: [12, 13],
    });
    await Promise.resolve();

    expect(accepted).not.toHaveBeenCalled();

    resolveRun?.({ status: 'completed', stdout: 'done', stderr: '' });
    await expect(send).resolves.toMatchObject({ status: 'accepted' });

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith({
      localInputId: 'local-1',
      localInputIds: ['local-1', 'local-2'],
      userMessageSeq: 12,
      userMessageSeqs: [12, 13],
    });
    expect(events.map((event) => (event as { kind?: string }).kind)).toEqual([
      'turn-start',
      'message-delta',
      'turn-complete',
    ]);
  });

  it('fails completed one-shot turns without stdout or transcript evidence', async () => {
    const events: unknown[] = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => ({ status: 'completed', stdout: '', stderr: '' })),
      now: () => 123,
    });
    runtime.events.subscribe((event) => events.push(event));

    await expect(runtime.send({ v: 1, text: 'hello' }, { turnId: 'turn-1' })).resolves.toEqual({
      status: 'accepted',
      turnId: 'turn-1',
    });

    expect(events
      .map((event) => (event as { kind?: string }).kind)
      .filter((kind) => kind === 'turn-failed' || kind === 'turn-complete'))
      .toEqual(['turn-failed']);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      issue: expect.objectContaining({
        code: 'antigravity_cliprint_empty_response',
        source: 'agent_status_error',
      }),
    }));
  });

  it('uses a fresh generated turn id as the transcript namespace when the host does not provide one', async () => {
    const eventsA: unknown[] = [];
    const runtimeA = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      createTurnId: () => 'generated-turn-a',
      runOneShot: async (input) => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        transcriptSteps: [
          { id: `antigravity-turn-${input.turnId}-step-2`, kind: 'assistant_message' as const, text: 'first' },
        ],
      }),
    });
    runtimeA.events.subscribe((event) => eventsA.push(event));

    const eventsB: unknown[] = [];
    const runtimeB = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      createTurnId: () => 'generated-turn-b',
      runOneShot: async (input) => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        transcriptSteps: [
          { id: `antigravity-turn-${input.turnId}-step-2`, kind: 'assistant_message' as const, text: 'second' },
        ],
      }),
    });
    runtimeB.events.subscribe((event) => eventsB.push(event));

    await expect(runtimeA.send({ v: 1, text: 'first' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'generated-turn-a',
    });
    await expect(runtimeB.send({ v: 1, text: 'second' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'generated-turn-b',
    });

    expect(eventsA).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      localId: 'antigravity-turn-generated-turn-a-step-2',
    }));
    expect(eventsB).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      localId: 'antigravity-turn-generated-turn-b-step-2',
    }));
  });

  it('fails a provider-accepted turn when transcript evidence contains an error step', async () => {
    const events: unknown[] = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => ({
        status: 'completed' as const,
        stdout: '',
        stderr: '',
        transcriptSteps: [
          { id: 'error-1', kind: 'error' as const, message: 'agy failed while applying changes' },
        ],
      })),
      now: () => 123,
    });
    runtime.events.subscribe((event) => events.push(event));

    await expect(runtime.send({ v: 1, text: 'hello' }, { turnId: 'turn-1' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'turn-1',
    });

    expect(events
      .map((event) => (event as { kind?: string }).kind)
      .filter((kind) => kind === 'turn-failed' || kind === 'turn-complete'))
      .toEqual(['turn-failed']);
    expectValidRuntimeEvents(events);
  });

  it('treats cliPrint stdout error text as provider-owned failed-turn evidence without rethrowing to the host fallback', async () => {
    const events: unknown[] = [];
    const accepted = vi.fn();
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => {
        throw new AntigravityCliPrintOneShotError({
          code: 'antigravity_cliprint_stdout_error',
          message: 'timed out waiting for response',
        });
      }),
      now: () => 123,
    });
    runtime.events.subscribe((event) => events.push(event));
    runtime.setOnPromptAcceptedByProvider?.(accepted);

    await expect(runtime.send({ v: 1, text: 'hello' }, {
      turnId: 'turn-stdout-error',
      localInputId: 'local-stdout-error',
      userMessageSeq: 41,
      userMessageSeqs: [41],
    })).resolves.toEqual({
      status: 'accepted',
      turnId: 'turn-stdout-error',
    });

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith({
      localInputId: 'local-stdout-error',
      userMessageSeq: 41,
      userMessageSeqs: [41],
    });
    expect(events
      .map((event) => (event as { kind?: string }).kind)
      .filter((kind) => kind === 'turn-failed' || kind === 'turn-complete'))
      .toEqual(['turn-failed']);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      issue: expect.objectContaining({
        code: 'antigravity_cliprint_stdout_error',
        source: 'agent_status_error',
        sanitizedPreview: 'timed out waiting for response',
      }),
    }));
    expectValidRuntimeEvents(events);
  });

  it('does not confirm provider acceptance for pre-provider one-shot launch failures', async () => {
    const events: unknown[] = [];
    const accepted = vi.fn();
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => {
        throw new Error('spawn ENOENT');
      }),
      now: () => 123,
    });
    runtime.events.subscribe((event) => events.push(event));
    runtime.setOnPromptAcceptedByProvider?.(accepted);

    await expect(runtime.send({ v: 1, text: 'hello' }, {
      turnId: 'turn-spawn-failed',
      localInputId: 'local-spawn-failed',
      userMessageSeq: 51,
    })).resolves.toEqual({
      status: 'unavailable',
      turnId: 'turn-spawn-failed',
      diagnostic: 'spawn ENOENT',
    });

    expect(accepted).not.toHaveBeenCalled();
    expect(events
      .map((event) => (event as { kind?: string }).kind)
      .filter((kind) => kind === 'turn-failed' || kind === 'turn-complete'))
      .toEqual(['turn-failed']);
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      issue: expect.objectContaining({
        code: 'antigravity_cliprint_launch_failed',
        source: 'agent_process_exit',
        sanitizedPreview: 'spawn ENOENT',
      }),
    }));
    expectValidRuntimeEvents(events);
  });

  it('keeps provider acceptance when best-effort conversation discovery fails after output evidence', async () => {
    const events: unknown[] = [];
    const accepted = vi.fn();
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(async () => ({ status: 'completed', stdout: 'done', stderr: '' })),
      discoverConversationId: vi.fn(async () => {
        throw new Error('conversation store unavailable');
      }),
      now: () => 123,
    });
    runtime.events.subscribe((event) => events.push(event));
    runtime.setOnPromptAcceptedByProvider?.(accepted);

    await expect(runtime.send({ v: 1, text: 'hello' }, {
      turnId: 'turn-discovery-failed',
      localInputId: 'local-discovery-failed',
      userMessageSeq: 61,
    })).resolves.toEqual({
      status: 'accepted',
      turnId: 'turn-discovery-failed',
      agentTurnId: undefined,
    });

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(events
      .map((event) => (event as { kind?: string }).kind)
      .filter((kind) => kind === 'turn-failed' || kind === 'turn-complete'))
      .toEqual(['turn-complete']);
    expectValidRuntimeEvents(events);
  });

  it('passes a known conversation id on resume and reports steering as unsupported', async () => {
    const runOneShot = vi.fn(async () => ({ status: 'completed' as const, stdout: 'ok', stderr: '' }));
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      conversationId: 'conv-existing',
      promptTimeoutMs: 1_000,
      runOneShot,
    });

    await expect(runtime.send({ v: 1, text: 'steer?' }, { deliverAs: 'steer', turnId: 'turn-steer' }))
      .resolves.toMatchObject({
        status: 'unsupported',
        diagnostic: expect.stringMatching(/steer/i),
      });

    await runtime.send({ v: 1, text: 'resume' }, { turnId: 'turn-2' });
    expect(runOneShot).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-existing',
      prompt: 'resume',
    }));
    expect(runtime.permissions).toBeUndefined();
  });

  it('rejects blank prompts before launching agy print mode', async () => {
    const runOneShot = vi.fn(async () => ({ status: 'completed' as const, stdout: 'should not run', stderr: '' }));
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot,
    });

    await expect(runtime.send({ v: 1, text: '   ' }, { turnId: 'turn-empty' })).resolves.toMatchObject({
      status: 'rejected',
      turnId: 'turn-empty',
      diagnostic: expect.stringMatching(/non-empty prompt/i),
    });
    expect(runOneShot).not.toHaveBeenCalled();
  });

  it('kills an in-flight cliPrint process on cancellation', async () => {
    let signal: AbortSignal | null = null;
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(({ signal: runSignal }) => {
        signal = runSignal ?? null;
        return new Promise(() => undefined);
      }),
    });

    void runtime.send({ v: 1, text: 'long running' }, { turnId: 'turn-1' });
    await expect(runtime.cancel?.({ turnId: 'turn-1', reason: 'user' })).resolves.toEqual({ status: 'cancelled' });
    expect(signal?.aborted).toBe(true);
  });

  it('does not publish a second terminal failure when cancellation aborts one-shot', async () => {
    const events: unknown[] = [];
    const runtime = createAntigravityCliPrintSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      executable: '/bin/agy',
      promptTimeoutMs: 1_000,
      runOneShot: vi.fn(({ signal: runSignal }) => new Promise((_, reject) => {
        runSignal?.addEventListener('abort', () => {
          reject(new AntigravityCliPrintOneShotError({
            code: 'antigravity_cliprint_cancelled',
            message: 'Antigravity CLI print run was cancelled.',
          }));
        }, { once: true });
      })),
      now: () => 123,
    });
    runtime.events.subscribe((event) => events.push(event));

    const send = runtime.send({ v: 1, text: 'long running' }, { turnId: 'turn-1' }).catch(() => undefined);
    await expect(runtime.cancel?.({ turnId: 'turn-1', reason: 'user' })).resolves.toEqual({ status: 'cancelled' });
    await send;

    expect(events
      .map((event) => (event as { kind?: string }).kind)
      .filter((kind) => kind === 'turn-cancelled' || kind === 'turn-failed' || kind === 'turn-complete'))
      .toEqual(['turn-cancelled']);
    expectValidRuntimeEvents(events);
  });
});
