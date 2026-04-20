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

  it('leaves the existing target state untouched when no canonical local-agent binding exists', async () => {
    vi.resetModules();
    vi.doMock('@/voice/context/resolveActiveLocalVoiceAgentBinding', () => ({
      resolveActiveLocalVoiceAgentBinding: () => null,
    }));
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveEffectiveVoiceTargetState } = await import('./resolveEffectiveVoiceTargetState');

    useVoiceTargetStore.setState({
      scope: 'global',
      primaryActionSessionId: 'existing-session',
      trackedSessionIds: ['existing-session'],
      lastFocusedSessionId: null,
    } as any);

    expect(resolveEffectiveVoiceTargetState('s1')).toEqual({
      primaryActionSessionId: 'existing-session',
      trackedSessionIds: ['existing-session'],
    });
  });
});
