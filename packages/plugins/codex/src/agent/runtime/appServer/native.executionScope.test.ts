import type {
  AgentExecutionRunConversationEventV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it } from 'vitest';

import type { CodexAppServerEvent, CodexAppServerSession } from './core.js';
import { createCodexNativeAppServerExecutionRunConversationRuntime } from './native.js';

function createExecutionRunConversationHarness(): Readonly<{
  runtime: CodexAppServerSession;
  publish(event: CodexAppServerEvent): void;
}> {
  const listeners = new Set<(event: CodexAppServerEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) listener(event);
    },
    runtime: {
      compact: async () => ({ status: 'admitted' }),
      identity: { read: () => ({ providerSessionId: null }) },
      events: {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      rollbackNativeConversation: async () => ({ status: 'notApplied' }),
      reconcileNativeConversationRollback: async () => ({ status: 'notApplied' }),
      send: async () => ({ status: 'accepted' }),
      dispose: async () => undefined,
    },
  };
}

describe('Codex App Server detached execution conversation', () => {
  it('publishes idle provider termination as runtime-ended without a Session identity', () => {
    const appServer = createExecutionRunConversationHarness();
    const runtime = createCodexNativeAppServerExecutionRunConversationRuntime(
      appServer.runtime,
      'run-codex-1',
    );
    const events: AgentExecutionRunConversationEventV1[] = [];
    runtime.watch((event) => { events.push(event); });

    appServer.publish({
      kind: 'turn-complete',
      executionRunId: 'run-codex-1',
      turnId: 'turn-1',
      emittedAtMs: 1,
    });
    appServer.publish({
      kind: 'session-ended',
      executionRunId: 'run-codex-1',
      reason: 'provider conversation closed',
      emittedAtMs: 2,
    });

    expect(events).toEqual([
      { kind: 'turn-complete', turnId: 'turn-1', emittedAtMs: 1 },
      { kind: 'runtime-ended', cause: 'providerEnded', retryable: false,
        diagnostic: { code: 'codex_runtime_ended', severity: 'error', message: 'provider conversation closed' },
        emittedAtMs: 2 },
    ]);
    expect(events.every((event) => !('sessionId' in event) && !('sequence' in event))).toBe(true);
  });
});
