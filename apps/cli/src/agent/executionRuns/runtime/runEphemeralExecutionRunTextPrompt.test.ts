import { describe, expect, it } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { EphemeralExecutionRunTextPromptBackendFactory } from './runEphemeralExecutionRunTextPrompt';

describe('runEphemeralExecutionRunTextPrompt', () => {
  it('runs a single-turn ephemeral execution run and returns collected model output', async () => {
    const { runEphemeralExecutionRunTextPrompt } = await import('./runEphemeralExecutionRunTextPrompt');

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
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelId: 'default',
      permissionMode: 'no_tools',
      intent: 'replay_summary',
      prompt: 'Return OK',
      createBackend: ((opts) => {
        observedIntent = opts.start.intent;
        observedRetention = opts.start.retentionPolicy;
        observedBackendTarget = opts.backendTarget ?? null;
        return backend;
      }) satisfies EphemeralExecutionRunTextPromptBackendFactory,
      timeoutMs: 1234,
    });

    expect(out).toBe('OK');
    expect(observedIntent).toBe('replay_summary');
    expect(observedRetention).toBe('ephemeral');
    expect(observedBackendTarget).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
  });

  it('applies session configuration before sending the prompt', async () => {
    const { runEphemeralExecutionRunTextPrompt } = await import('./runEphemeralExecutionRunTextPrompt');

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
      createBackend: (() => backend) satisfies EphemeralExecutionRunTextPromptBackendFactory,
      configureSession: async (sessionId) => {
        events.push(`configure:${sessionId}`);
      },
    });

    expect(out).toBe('OK');
    expect(events).toEqual(['start', 'configure:vendor-sess-1', 'send']);
  });
});
