import { describe, expect, it, vi } from 'vitest';

describe('voiceTargetStore', () => {
  it('publishes only real changes to nullable primary and focused targets', async () => {
    const { useVoiceTargetStore } = await import('./voiceTargetStore');
    const original = useVoiceTargetStore.getState();
    original.setPrimaryActionSessionAddress(null);
    original.setLastFocusedSessionAddress(null);
    let notifications = 0;
    const off = useVoiceTargetStore.subscribe(() => { notifications += 1; });
    try {
      for (let index = 0; index < 20; index += 1) {
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
        useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
      }
      expect(notifications).toBe(0);
      const address = { serverId: 'home-a', sessionId: 'session-1' };
      useVoiceTargetStore.getState().setPrimaryActionSessionAddress(address);
      useVoiceTargetStore.getState().setLastFocusedSessionAddress(address);
      expect(notifications).toBe(2);
      useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: ' home-a ', sessionId: ' session-1 ' });
      useVoiceTargetStore.getState().setLastFocusedSessionAddress({ ...address });
      expect(notifications).toBe(2);
      useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
      useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
      expect(notifications).toBe(4);
      expect(useVoiceTargetStore.getState()).toMatchObject({ primaryActionSessionAddress: null, lastFocusedSessionAddress: null });
    } finally {
      off();
      useVoiceTargetStore.setState(original, true);
    }
  });

  it('publishes only real changes to the tracked qualified targets', async () => {
    const { useVoiceTargetStore } = await import('./voiceTargetStore');
    const original = useVoiceTargetStore.getState();
    const targets = Array.from({ length: 1000 }, (_, index) => ({ serverId: 'home-a', sessionId: `s-${index}` }));
    original.setVoiceLiveContextSessionAddresses(targets);
    const admitted = useVoiceTargetStore.getState().voiceLiveContextSessionAddresses;
    let notifications = 0;
    const off = useVoiceTargetStore.subscribe(() => { notifications += 1; });
    try {
      for (let index = 0; index < 20; index += 1) {
        const actions = useVoiceTargetStore.getState();
        actions.setVoiceLiveContextSessionAddresses([...targets].reverse());
        actions.addVoiceLiveContextSessionAddress({ serverId: ' home-a ', sessionId: ' s-1 ' });
        actions.removeVoiceLiveContextSessionAddress({ serverId: 'other-home', sessionId: 's-1' });
      }
      expect(notifications).toBe(0);
      expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toBe(admitted);

      useVoiceTargetStore.getState().addVoiceLiveContextSessionAddress({ serverId: 'home-b', sessionId: 's-1' });
      expect(notifications).toBe(1);
      expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses.find((address) => address.serverId === 'home-a' && address.sessionId === 's-1'))
        .toBe(admitted.find((address) => address.sessionId === 's-1'));
      useVoiceTargetStore.getState().removeVoiceLiveContextSessionAddress({ serverId: 'home-b', sessionId: 's-1' });
      expect(notifications).toBe(2);
      expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual(admitted);
    } finally {
      off();
      useVoiceTargetStore.setState(original, true);
    }
  });

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
  it('uses native full-window focus without aliasing a colliding main-local Session or another Account', async () => {
    const { resolveVoiceIdleTarget } = await import('./voiceTargetStore');
    const facts = { intent: { kind: 'default' as const }, scopeDefault: 'session' as const, allowsGlobalStart: true,
      focusedSessionAddress: { serverId: 'home-a', sessionId: 'same' }, lastFocusedSessionAddress: { serverId: 'home-a', sessionId: 'previous' },
      focusedWindowSurface: { homeId: 'home-b', accountId: 'alice', sessionId: 'same' }, currentAccountId: 'alice' };
    expect(resolveVoiceIdleTarget(facts)).toEqual({ kind: 'session', sessionAddress: { serverId: 'home-b', sessionId: 'same' } });
    expect(resolveVoiceIdleTarget({ ...facts, focusedWindowSurface: { ...facts.focusedWindowSurface, accountId: 'bob' } }))
      .toEqual({ kind: 'session', sessionAddress: null });
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
