import { describe, expect, it } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { MemoryHintsExecutionRunBackendFactory } from './runMemoryHintsExecutionRun';

describe('runMemoryHintsExecutionRun', () => {
  it('runs a single-turn ephemeral memory_hints execution using the backend overlay', async () => {
    const { runMemoryHintsExecutionRun } = await import('./runMemoryHintsExecutionRun');

    const observed: Parameters<MemoryHintsExecutionRunBackendFactory>[0][] = [];
    const handlers = new Set<AgentMessageHandler>();

    const backend: AgentBackend = {
      async startSession(): Promise<{ sessionId: SessionId }> {
        return { sessionId: 'vendor-sess-1' };
      },
      async sendPrompt(_sessionId: string, _prompt: string): Promise<void> {
        // Emit fullText immediately for determinism.
        for (const handler of handlers) {
          handler({ type: 'model-output', fullText: '{"ok":true}' });
        }
      },
      async cancel(): Promise<void> {},
      onMessage(handler: AgentMessageHandler): void {
        handlers.add(handler);
      },
      async waitForResponseComplete(): Promise<void> {},
      async dispose(): Promise<void> {},
    };

    const createBackend: MemoryHintsExecutionRunBackendFactory = (opts) => {
      observed.push(opts);
      return backend;
    };

    const raw = await runMemoryHintsExecutionRun({
      cwd: '/tmp',
      sessionId: 'sess-123',
      backendId: 'claude',
      modelId: 'default',
      permissionMode: 'no_tools',
      prompt: 'Return JSON',
      createBackend,
    });

    expect(raw).toContain('{"ok":true}');
    expect(observed[0]?.start?.retentionPolicy).toBe('ephemeral');
    expect(observed[0]?.start?.intent).toBe('memory_hints');
  });
});
