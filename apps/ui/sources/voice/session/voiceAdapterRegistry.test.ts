import { afterEach, describe, expect, it } from 'vitest';

import type { VoiceAdapterController } from './types';

afterEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
});

describe('voiceAdapterRegistry', () => {
  it('canonicalizes adapter ids and resolves padded lookups', async () => {
    const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('./voiceAdapterRegistry');

    const adapter = {
      id: ' adapter_b ',
      start: async () => {},
      stop: async () => {},
      toggle: async () => {},
      interrupt: async () => {},
      setMuted: async () => {},
      sendContextUpdate: () => {},
      getSnapshot: () => ({
        adapterId: ' adapter_b ',
        sessionId: null,
        status: 'disconnected' as const,
        mode: 'idle' as const,
        canStop: false,
      }),
    } satisfies VoiceAdapterController;

    registerVoiceAdapters([adapter]);

    const registry = getVoiceAdapterRegistry();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.id).toBe('adapter_b');
    expect(registry.get('adapter_b')).toBe(registry.list()[0] ?? null);
    expect(registry.get(' adapter_b ')).toBe(registry.list()[0] ?? null);
  });

  it('drops blank adapter ids during registration', async () => {
    const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('./voiceAdapterRegistry');

    const ignoredAdapter = {
      id: '   ',
      start: async () => {},
      stop: async () => {},
      toggle: async () => {},
      interrupt: async () => {},
      setMuted: async () => {},
      sendContextUpdate: () => {},
      getSnapshot: () => ({
        adapterId: null,
        sessionId: null,
        status: 'disconnected' as const,
        mode: 'idle' as const,
        canStop: false,
      }),
    } satisfies VoiceAdapterController;

    registerVoiceAdapters([ignoredAdapter]);

    const registry = getVoiceAdapterRegistry();
    expect(registry.list()).toHaveLength(0);
    expect(registry.get('')).toBeNull();
  });
});
