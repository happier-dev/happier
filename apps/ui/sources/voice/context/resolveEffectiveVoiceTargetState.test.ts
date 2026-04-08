import { describe, expect, it, vi } from 'vitest';

describe('resolveEffectiveVoiceTargetState', () => {
  it('treats malformed trackedSessionIds state as empty instead of throwing', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveEffectiveVoiceTargetState } = await import('./resolveEffectiveVoiceTargetState');

    useVoiceTargetStore.setState({
      scope: 'global',
      primaryActionSessionId: null,
      trackedSessionIds: null,
      lastFocusedSessionId: null,
    } as any);

    expect(
      resolveEffectiveVoiceTargetState('s1', {
        targetSessionId: 's1',
      }),
    ).toEqual({
      primaryActionSessionId: 's1',
      trackedSessionIds: ['s1'],
    });
  });
});
