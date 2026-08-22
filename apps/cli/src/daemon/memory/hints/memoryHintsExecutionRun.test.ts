import { describe, expect, it, vi } from 'vitest';

import type { MemoryHintsExecutionRunTextPromptRunner } from './runMemoryHintsExecutionRun';

describe('runMemoryHintsExecutionRun', () => {
  it('uses the canonical text-prompt Action path for one bounded memory_hints run', async () => {
    const { runMemoryHintsExecutionRun } = await import('./runMemoryHintsExecutionRun');

    const runTextPrompt: MemoryHintsExecutionRunTextPromptRunner = vi.fn(
      async () => '{"ok":true}',
    );

    const raw = await runMemoryHintsExecutionRun({
      cwd: '/tmp',
      sessionId: 'sess-123',
      backendId: 'claude',
      modelId: 'default',
      permissionMode: 'no_tools',
      prompt: 'Return JSON',
      runTextPrompt,
    });

    expect(raw).toContain('{"ok":true}');
    expect(runTextPrompt).toHaveBeenCalledWith({
      cwd: '/tmp',
      sessionId: 'sess-123',
      runner: {
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
      intent: 'memory_hints',
      prompt: 'Return JSON',
      timeoutMs: undefined,
    });
  });
});
