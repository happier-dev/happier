import { describe, expect, it, vi } from 'vitest';

const resolveEffectiveCodingPromptText = vi.fn(async () => 'PROMPT');

vi.mock('@/agent/prompting/coding/resolveEffectiveCodingPrompt', () => ({
  resolveEffectiveCodingPromptText,
}));

describe('resolveGeminiSystemPromptText', () => {
  it('includes the shell-bridge tool delivery context (session id + directory)', async () => {
    const { resolveGeminiSystemPromptText } = await import('./resolveGeminiSystemPromptText');

    const out = await resolveGeminiSystemPromptText({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      settings: {},
      profileId: 'p1',
      baseOverride: 'BASE',
      executionRunsFeatureEnabled: false,
      sessionId: 'sess_1',
      runtimeDirectory: '/tmp/worktree',
      machineId: 'machine_1',
    });

    expect(out).toBe('PROMPT');
    expect(resolveEffectiveCodingPromptText).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'gemini',
      toolDelivery: 'shell_bridge',
      toolDeliverySessionId: 'sess_1',
      toolDeliveryDirectory: '/tmp/worktree',
      memoryMachineId: 'machine_1',
    }));
  });
});

