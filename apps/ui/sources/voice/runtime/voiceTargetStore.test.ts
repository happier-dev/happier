import { describe, expect, it, vi } from 'vitest';

describe('voiceTargetStore', () => {
  it('normalizes primaryActionSessionId when set', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('./voiceTargetStore');

    useVoiceTargetStore.getState().setPrimaryActionSessionId('  s1  ');
    expect(useVoiceTargetStore.getState().primaryActionSessionId).toBe('s1');

    useVoiceTargetStore.getState().setPrimaryActionSessionId('   ');
    expect(useVoiceTargetStore.getState().primaryActionSessionId).toBe(null);
  });

  it('normalizes lastFocusedSessionId when set', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('./voiceTargetStore');

    useVoiceTargetStore.getState().setLastFocusedSessionId('  s_last  ');
    expect(useVoiceTargetStore.getState().lastFocusedSessionId).toBe('s_last');

    useVoiceTargetStore.getState().setLastFocusedSessionId('   ');
    expect(useVoiceTargetStore.getState().lastFocusedSessionId).toBe(null);
  });

  it('normalizes and dedupes trackedSessionIds when set', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('./voiceTargetStore');

    useVoiceTargetStore.getState().setTrackedSessionIds(['  s2  ', 's1', 's2', '   ', 's1']);
    expect(useVoiceTargetStore.getState().trackedSessionIds).toEqual(['s1', 's2']);
  });
});
