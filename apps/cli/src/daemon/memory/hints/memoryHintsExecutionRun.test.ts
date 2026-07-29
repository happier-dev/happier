import { describe, expect, it } from 'vitest';

import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { MemoryHintsExecutionRunBackendFactory } from './runMemoryHintsExecutionRun';

describe('runMemoryHintsExecutionRun', () => {
  it('runs a single-turn ephemeral memory_hints execution using the backend overlay', async () => {
    const { runMemoryHintsExecutionRun } = await import('./runMemoryHintsExecutionRun');

    const observed: Parameters<MemoryHintsExecutionRunBackendFactory>[0][] = [];

    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    runtime = createTestExecutionRunHostRuntime({
      sessionId: 'vendor-sess-1',
      onSendPrompt() {
        // Emit fullText immediately for determinism.
        runtime.emitMessage({ type: 'model-output', fullText: '{"ok":true}' });
      },
    });

    const createBackend: MemoryHintsExecutionRunBackendFactory = (opts) => {
      observed.push(opts);
      return runtime;
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
  }, 1_000);
});
