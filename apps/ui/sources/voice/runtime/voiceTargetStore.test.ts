import { describe, expect, it, vi } from 'vitest';

describe('voiceTargetStore', () => {
  it('shares default scope/capability policy while preserving explicit composer and Home intents', async () => {
    const { resolveVoiceIdleTarget } = await import('./voiceTargetStore');
    const focusedSessionAddress = { serverId: 'home-b', sessionId: 'open' };
    const lastFocusedSessionAddress = { serverId: 'home-a', sessionId: 'previous' };
    const facts = { scopeDefault: 'global' as const, allowsGlobalStart: true, focusedSessionAddress, lastFocusedSessionAddress };
    expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'default' } })).toEqual({ kind: 'global' });
    expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'default' }, scopeDefault: 'session' })).toEqual({ kind: 'session', sessionAddress: focusedSessionAddress });
    expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'default' }, allowsGlobalStart: false })).toEqual({ kind: 'session', sessionAddress: focusedSessionAddress });
    expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'default' }, allowsGlobalStart: false, focusedSessionAddress: null })).toEqual({ kind: 'session', sessionAddress: lastFocusedSessionAddress });
    expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'default' }, scopeDefault: 'session', focusedSessionAddress: null, lastFocusedSessionAddress: null })).toEqual({ kind: 'session', sessionAddress: null });
    expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'session', sessionAddress: null } })).toEqual({ kind: 'session', sessionAddress: null });
    expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'global' }, scopeDefault: 'session', allowsGlobalStart: false })).toEqual({ kind: 'global' });
  });
  it('stores primary, focused, and tracked targets by qualified address', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('./voiceTargetStore');

    useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: ' home-a ', sessionId: ' same ' });
    useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'home-b', sessionId: 'same' });
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
      { serverId: 'home-b', sessionId: 'same' },
      { serverId: 'home-a', sessionId: 'same' },
      { serverId: 'home-b', sessionId: 'same' },
    ]);

    expect(useVoiceTargetStore.getState().primaryActionSessionAddress)
      .toEqual({ serverId: 'home-a', sessionId: 'same' });
    expect(useVoiceTargetStore.getState().lastFocusedSessionAddress)
      .toEqual({ serverId: 'home-b', sessionId: 'same' });
    expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([
      { serverId: 'home-a', sessionId: 'same' },
      { serverId: 'home-b', sessionId: 'same' },
    ]);
  });

  it('resolves the exact qualified action target', async () => {
    vi.resetModules();
    const { resolveVoiceActionTargetAddress } = await import('./voiceTargetStore');

    expect(resolveVoiceActionTargetAddress({
      scope: 'global',
      primaryActionSessionAddress: { serverId: 'home-b', sessionId: 'same' },
      lastFocusedSessionAddress: { serverId: 'home-a', sessionId: 'same' },
    })).toEqual({ serverId: 'home-b', sessionId: 'same' });
  });

  it('treats malformed tracked addresses as empty instead of throwing', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('./voiceTargetStore');

    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses(
      null as unknown as ReadonlyArray<{ serverId: string; sessionId: string }>,
    );
    expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([]);
  });

  it('never falls through from Session scope to a retained global target', async () => {
    vi.resetModules();
    const { resolveVoiceActionTargetAddress } = await import('./voiceTargetStore');

    expect(resolveVoiceActionTargetAddress({
      scope: 'session',
      currentSessionAddress: { serverId: 'home', sessionId: ' current ' },
      primaryActionSessionAddress: { serverId: 'home', sessionId: 'stale-global' },
      lastFocusedSessionAddress: { serverId: 'home', sessionId: 'stale-focused' },
    })).toEqual({ serverId: 'home', sessionId: 'current' });
    expect(resolveVoiceActionTargetAddress({
      scope: 'session',
      currentSessionAddress: null,
      primaryActionSessionAddress: { serverId: 'home', sessionId: 'stale-global' },
      lastFocusedSessionAddress: { serverId: 'home', sessionId: 'stale-focused' },
    })).toBeNull();
  });

  it('uses the primary then focused target for Global scope', async () => {
    vi.resetModules();
    const { resolveVoiceActionTargetAddress } = await import('./voiceTargetStore');

    expect(resolveVoiceActionTargetAddress({
      scope: 'global',
      primaryActionSessionAddress: { serverId: 'home', sessionId: ' primary ' },
      lastFocusedSessionAddress: { serverId: 'home', sessionId: 'focused' },
    })).toEqual({ serverId: 'home', sessionId: 'primary' });
    expect(resolveVoiceActionTargetAddress({
      scope: 'global',
      primaryActionSessionAddress: null,
      lastFocusedSessionAddress: { serverId: 'home', sessionId: ' focused ' },
    })).toEqual({ serverId: 'home', sessionId: 'focused' });
  });
});
