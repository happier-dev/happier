import { describe, expect, it } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { EphemeralExecutionRunTextPromptBackendFactory } from './runEphemeralExecutionRunTextPrompt';

describe('runEphemeralExecutionRunTextPrompt', () => {
  it('runs a single-turn ephemeral execution run and returns collected model output', async () => {
    const { runEphemeralExecutionRunTextPrompt } = await import('./runEphemeralExecutionRunTextPrompt');

    const handlers = new Set<AgentMessageHandler>();
    let observedIntent: string | null = null;
    let observedRetention: string | null = null;

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
      backendId: 'claude',
      modelId: 'default',
      permissionMode: 'no_tools',
      intent: 'replay_summary',
      prompt: 'Return OK',
      createBackend: ((opts) => {
        observedIntent = opts.start.intent;
        observedRetention = opts.start.retentionPolicy;
        return backend;
      }) satisfies EphemeralExecutionRunTextPromptBackendFactory,
      timeoutMs: 1234,
    });

    expect(out).toBe('OK');
    expect(observedIntent).toBe('replay_summary');
    expect(observedRetention).toBe('ephemeral');
  });
});
