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

  it('treats malformed trackedSessionIds input as empty instead of throwing', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('./voiceTargetStore');

    useVoiceTargetStore.getState().setTrackedSessionIds(null as unknown as ReadonlyArray<string>);
    expect(useVoiceTargetStore.getState().trackedSessionIds).toEqual([]);
  });

  it('never falls through from Session scope to a retained global target', async () => {
    vi.resetModules();
    const { resolveVoiceActionTargetSessionId } = await import('./voiceTargetStore');

    expect(resolveVoiceActionTargetSessionId({
      scope: 'session',
      currentSessionId: ' current ',
      primaryActionSessionId: 'stale-global',
      lastFocusedSessionId: 'stale-focused',
    })).toBe('current');
    expect(resolveVoiceActionTargetSessionId({
      scope: 'session',
      currentSessionId: null,
      primaryActionSessionId: 'stale-global',
      lastFocusedSessionId: 'stale-focused',
    })).toBeNull();
  });

  it('uses the primary then focused target for Global scope', async () => {
    vi.resetModules();
    const { resolveVoiceActionTargetSessionId } = await import('./voiceTargetStore');

    expect(resolveVoiceActionTargetSessionId({
      scope: 'global',
      primaryActionSessionId: ' primary ',
      lastFocusedSessionId: 'focused',
    })).toBe('primary');
    expect(resolveVoiceActionTargetSessionId({
      scope: 'global',
      primaryActionSessionId: null,
      lastFocusedSessionId: ' focused ',
    })).toBe('focused');
  });
});
