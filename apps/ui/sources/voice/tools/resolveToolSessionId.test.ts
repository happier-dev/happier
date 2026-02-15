import { describe, expect, it, vi } from 'vitest';

describe('resolveToolSessionId', () => {
  it('prefers explicit sessionId', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveToolSessionId } = await import('./resolveToolSessionId');

    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: 's_global' } as any);
    expect(resolveToolSessionId({ explicitSessionId: 's_explicit', currentSessionId: 's_current' })).toBe('s_explicit');
  });

  it('uses global primaryActionSessionId when scope is global', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveToolSessionId } = await import('./resolveToolSessionId');

    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: 's_global' } as any);
    expect(resolveToolSessionId({ explicitSessionId: null, currentSessionId: 's_current' })).toBe('s_global');
  });

  it('falls back to currentSessionId when scope is global but no target is set', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveToolSessionId } = await import('./resolveToolSessionId');

    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: null, lastFocusedSessionId: null } as any);
    expect(resolveToolSessionId({ explicitSessionId: null, currentSessionId: 's_current' })).toBe('s_current');
  });

  it('falls back to lastFocusedSessionId when scope is global and no explicit/current target is set', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveToolSessionId } = await import('./resolveToolSessionId');

    useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionId: null, lastFocusedSessionId: 's_last' } as any);
    expect(resolveToolSessionId({ explicitSessionId: null, currentSessionId: null })).toBe('s_last');
  });

  it('uses currentSessionId when scope is session', async () => {
    vi.resetModules();
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveToolSessionId } = await import('./resolveToolSessionId');

    useVoiceTargetStore.setState({ scope: 'session', primaryActionSessionId: 's_global', lastFocusedSessionId: 's_last' } as any);
    expect(resolveToolSessionId({ explicitSessionId: null, currentSessionId: 's_current' })).toBe('s_current');
  });
});
