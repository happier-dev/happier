import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestExecutionRunHostRuntime } from '../testkit/runtime';
import { runEphemeralExecutionRunTextPrompt } from './textPrompt';
import type { EphemeralExecutionRunTextPromptRuntimeFactory } from './textPrompt';

const mockedConfiguration = vi.hoisted(() => ({
  executionRunsBoundedTimeoutMs: null as number | null,
}));

vi.mock('@/configuration', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/configuration')>();
  const configuration = new Proxy(original.configuration, {
    get(target, property, receiver) {
      if (property === 'executionRunsBoundedTimeoutMs') {
        return mockedConfiguration.executionRunsBoundedTimeoutMs;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    ...original,
    configuration,
  };
});

describe('runEphemeralExecutionRunTextPrompt', () => {
  afterEach(() => {
    mockedConfiguration.executionRunsBoundedTimeoutMs = null;
  });

  it('runs a single-turn ephemeral execution run and returns collected model output', async () => {
    mockedConfiguration.executionRunsBoundedTimeoutMs = 9_999;

    let observedIntent: string | null = null;
    let observedRetention: string | null = null;
    let observedBackendTarget: unknown = null;
    const waitTimeouts: Array<number | null | undefined> = [];

    const runtime = createTestExecutionRunHostRuntime({
      sessionId: 'vendor-sess-1',
      sendPrompt: (_sessionId, _prompt, actions) => {
        actions.emit({ type: 'model-output', fullText: 'OK' });
      },
      waitForTurnCompletion: async (timeoutMs?: number | null): Promise<void> => {
        waitTimeouts.push(timeoutMs);
      },
    }).runtime;

    const out = await runEphemeralExecutionRunTextPrompt({
      cwd: '/tmp',
      sessionId: 'sess-123',
      backendId: 'acme.runtime.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.runtime.backend' as never },
      modelId: 'default',
      permissionMode: 'no_tools',
      intent: 'replay_summary',
      prompt: 'Return OK',
      createRuntime: ((opts) => {
        observedIntent = opts.start.intent;
        observedRetention = opts.start.retentionPolicy;
        observedBackendTarget = opts.backendTarget ?? null;
        return runtime;
      }) satisfies EphemeralExecutionRunTextPromptRuntimeFactory,
      timeoutMs: 1234,
    });

    expect(out).toBe('OK');
    expect(observedIntent).toBe('replay_summary');
    expect(observedRetention).toBe('ephemeral');
    expect(observedBackendTarget).toEqual({ kind: 'builtInAgent', agentId: 'acme.runtime.backend' });
    expect(waitTimeouts).toEqual([1234]);
  });

  it('applies session configuration before sending the prompt', async () => {
    const events: string[] = [];

    const runtime = createTestExecutionRunHostRuntime({
      async provisionSession() {
        events.push('start');
        return { sessionId: 'vendor-sess-1' };
      },
      sendPrompt: (_sessionId, _prompt, actions) => {
        events.push('send');
        actions.emit({ type: 'model-output', fullText: 'OK' });
      },
      waitForTurnCompletion: async () => {},
    }).runtime;

    const out = await runEphemeralExecutionRunTextPrompt({
      cwd: '/tmp',
      sessionId: 'sess-123',
      backendId: 'customAcp',
      permissionMode: 'no_tools',
      intent: 'replay_summary',
      prompt: 'Return OK',
      createRuntime: (() => runtime) satisfies EphemeralExecutionRunTextPromptRuntimeFactory,
      configureSession: async (sessionId) => {
        events.push(`configure:${sessionId}`);
      },
    });

    expect(out).toBe('OK');
    expect(events).toEqual(['start', 'configure:vendor-sess-1', 'send']);
  });

  it('falls back to the configured execution-run timeout when timeoutMs is omitted', async () => {
    mockedConfiguration.executionRunsBoundedTimeoutMs = 4_321;

    const waitTimeouts: Array<number | null | undefined> = [];

    const runtime = createTestExecutionRunHostRuntime({
      sessionId: 'vendor-sess-1',
      sendPrompt: (_sessionId, _prompt, actions) => {
        actions.emit({ type: 'model-output', fullText: 'OK' });
      },
      waitForTurnCompletion: async (timeoutMs?: number | null): Promise<void> => {
        waitTimeouts.push(timeoutMs);
      },
    }).runtime;

    const out = await runEphemeralExecutionRunTextPrompt({
      cwd: '/tmp',
      sessionId: 'sess-123',
      backendId: 'customAcp',
      permissionMode: 'no_tools',
      intent: 'memory_hints',
      prompt: 'Return OK',
      createRuntime: (() => runtime) satisfies EphemeralExecutionRunTextPromptRuntimeFactory,
    });

    expect(out).toBe('OK');
    expect(waitTimeouts).toEqual([4_321]);
  });
});
