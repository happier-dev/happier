import { describe, expect, it } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import { createExecutionRunHostRuntimeFromAgentBackend } from '@/agent/executionRuns/runtime/backend.testkit';
import type { EphemeralExecutionRunTextPromptRuntimeFactory } from './ephemeralTextPrompt';

describe('runEphemeralExecutionRunTextPrompt', () => {
  it('runs a single-turn ephemeral execution run and returns collected model output', async () => {
    const { runEphemeralExecutionRunTextPrompt } = await import('./ephemeralTextPrompt');

    const handlers = new Set<AgentMessageHandler>();
    let observedIntent: string | null = null;
    let observedRetention: string | null = null;
    let observedBackendTarget: unknown = null;

    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'vendor-sess-1' };
      },
      async sendPrompt(_sessionId: string, _prompt: string): Promise<void> {
        for (const handler of handlers) {
          handler({ type: 'model-output', fullText: 'OK' });
        }
      },
      async cancel(): Promise<void> {},
      onMessage(handler: AgentMessageHandler): void {
        handlers.add(handler);
      },
      async waitForResponseComplete(): Promise<void> {},
      async dispose(): Promise<void> {},
    };

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
        return createExecutionRunHostRuntimeFromAgentBackend(backend);
      }) satisfies EphemeralExecutionRunTextPromptRuntimeFactory,
      timeoutMs: 1234,
    });

    expect(out).toBe('OK');
    expect(observedIntent).toBe('replay_summary');
    expect(observedRetention).toBe('ephemeral');
    expect(observedBackendTarget).toEqual({ kind: 'builtInAgent', agentId: 'acme.runtime.backend' });
  });

  it('applies session configuration before sending the prompt', async () => {
    const { runEphemeralExecutionRunTextPrompt } = await import('./ephemeralTextPrompt');

    const handlers = new Set<AgentMessageHandler>();
    const events: string[] = [];

    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        events.push('start');
        return { sessionId: 'vendor-sess-1' };
      },
      async sendPrompt(_sessionId: string, _prompt: string): Promise<void> {
        events.push('send');
        for (const handler of handlers) {
          handler({ type: 'model-output', fullText: 'OK' });
        }
      },
      async cancel(): Promise<void> {},
      onMessage(handler: AgentMessageHandler): void {
        handlers.add(handler);
      },
      async waitForResponseComplete(): Promise<void> {},
      async dispose(): Promise<void> {},
    };

    const out = await runEphemeralExecutionRunTextPrompt({
      cwd: '/tmp',
      sessionId: 'sess-123',
      backendId: 'customAcp',
      permissionMode: 'no_tools',
      intent: 'replay_summary',
      prompt: 'Return OK',
      createRuntime: (() => createExecutionRunHostRuntimeFromAgentBackend(backend)) satisfies EphemeralExecutionRunTextPromptRuntimeFactory,
      configureSession: async (sessionId) => {
        events.push(`configure:${sessionId}`);
      },
    });

    expect(out).toBe('OK');
    expect(events).toEqual(['start', 'configure:vendor-sess-1', 'send']);
  });
});
