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
      engineKind: 'realtime',
      start: async () => {},
      stop: async () => {},
      toggle: async () => {},
      interrupt: async () => {},
      bargeIn: async () => {},
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

  it('fails closed when an adapter advertises barge-in without a callable action', async () => {
    const { registerVoiceAdapters, resolveVoiceAdapterSurfaceCapabilities } = await import('./voiceAdapterRegistry');
    const adapter = {
      id: 'missing_barge_action', engineKind: 'realtime',
      start: async () => {}, stop: async () => {}, toggle: async () => {}, interrupt: async () => {},
      setMuted: async () => {}, sendContextUpdate: () => {},
      getSnapshot: () => ({ adapterId: 'missing_barge_action', sessionId: null, status: 'disconnected' as const, mode: 'idle' as const, canStop: false }),
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true, controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false, bargeInEnabled: true,
      }),
    } satisfies VoiceAdapterController;
    registerVoiceAdapters([adapter]);
    expect(resolveVoiceAdapterSurfaceCapabilities('missing_barge_action', {})).toMatchObject({ bargeInEnabled: false });
  });

  it('drops blank adapter ids during registration', async () => {
    const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('./voiceAdapterRegistry');

    const ignoredAdapter = {
      id: '   ',
      engineKind: 'realtime',
      start: async () => {},
      stop: async () => {},
      toggle: async () => {},
      interrupt: async () => {},
      bargeIn: async () => {},
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

  it('projects surface semantics from any registered adapter without provider-specific host logic', async () => {
    const {
      registerVoiceAdapters,
      resolveVoiceAdapterSurfaceCapabilities,
    } = await import('./voiceAdapterRegistry');

    const secondRealtimeProvider = {
      id: 'realtime_second_provider',
      engineKind: 'realtime',
      start: async () => {},
      stop: async () => {},
      toggle: async () => {},
      interrupt: async () => {},
      bargeIn: async () => {},
      setMuted: async () => {},
      sendContextUpdate: () => {},
      getSnapshot: () => ({
        adapterId: 'realtime_second_provider',
        sessionId: null,
        status: 'disconnected' as const,
        mode: 'idle' as const,
        canStop: false,
      }),
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: true,
        cancelResponse: 'immediate' as const,
        interruptionPolicy: 'provider_immediate' as const,
        agentRuntime: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      }),
    } satisfies VoiceAdapterController;

    registerVoiceAdapters([secondRealtimeProvider]);

    expect(resolveVoiceAdapterSurfaceCapabilities('realtime_second_provider', {})).toEqual({
      allowsGlobalStart: true,
      controlSessionScope: 'global',
      requiresVoiceAgentFeature: false,
      bargeInEnabled: true,
      cancelResponse: 'immediate',
      interruptionPolicy: 'provider_immediate',
      agentRuntime: {
        pluginId: 'happier.agent.codex',
        localId: 'codex',
      },
    });
  });

  it('fails response cancellation closed when an adapter omits the capability', async () => {
    const { registerVoiceAdapters, resolveVoiceAdapterSurfaceCapabilities } = await import('./voiceAdapterRegistry');
    const adapter = {
      id: 'legacy_surface_provider', engineKind: 'realtime',
      start: async () => {}, stop: async () => {}, toggle: async () => {}, interrupt: async () => {},
      setMuted: async () => {}, sendContextUpdate: () => {},
      getSnapshot: () => ({ adapterId: 'legacy_surface_provider', sessionId: null, status: 'disconnected' as const, mode: 'idle' as const, canStop: false }),
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
      }),
    } satisfies VoiceAdapterController;
    registerVoiceAdapters([adapter]);

    expect(resolveVoiceAdapterSurfaceCapabilities('legacy_surface_provider', {})).toMatchObject({
      cancelResponse: 'unsupported',
    });
  });

  it('projects a selected adapter context channel without provider-specific host logic', async () => {
    const {
      registerVoiceAdapters,
      resolveVoiceAdapterContextChannel,
    } = await import('./voiceAdapterRegistry');
    const sendTextMessage = async () => {};
    const sendContextualUpdate = () => {};
    const adapter = {
      id: 'second_context_provider',
      engineKind: 'realtime',
      start: async () => {},
      stop: async () => {},
      toggle: async () => {},
      interrupt: async () => {},
      setMuted: async () => {},
      sendContextUpdate: () => {},
      getSnapshot: () => ({ adapterId: null, sessionId: null, status: 'disconnected' as const, mode: 'idle' as const, canStop: false }),
      resolveContextChannel: () => ({ sendContextualUpdate, sendTextMessage }),
    } satisfies VoiceAdapterController;

    registerVoiceAdapters([adapter]);

    expect(resolveVoiceAdapterContextChannel('second_context_provider', {})).toEqual({
      sendContextualUpdate,
      sendTextMessage,
    });
  });

  it('dispatches provider runtime actions through the selected adapter and fails closed when unavailable', async () => {
    const {
      performVoiceAdapterRuntimeAction,
      registerVoiceAdapters,
    } = await import('./voiceAdapterRegistry');
    const performed: string[] = [];
    const adapter = {
      id: 'realtime_actions',
      engineKind: 'realtime',
      start: async () => {}, stop: async () => {}, toggle: async () => {}, interrupt: async () => {},
      setMuted: async () => {}, sendContextUpdate: () => {},
      getSnapshot: () => ({ adapterId: null, sessionId: null, status: 'disconnected' as const, mode: 'idle' as const, canStop: false }),
      async performRuntimeAction(actionId: string) {
        performed.push(actionId);
        return actionId === 'forget_provider_conversation'
          ? { status: 'completed' as const }
          : { status: 'unsupported' as const };
      },
    } satisfies VoiceAdapterController;
    registerVoiceAdapters([adapter]);

    await expect(performVoiceAdapterRuntimeAction('realtime_actions', 'forget_provider_conversation'))
      .resolves.toEqual({ status: 'completed' });
    await expect(performVoiceAdapterRuntimeAction('realtime_actions', 'unknown'))
      .resolves.toEqual({ status: 'unsupported' });
    await expect(performVoiceAdapterRuntimeAction('missing', 'forget_provider_conversation'))
      .resolves.toEqual({ status: 'unsupported' });
    expect(performed).toEqual(['forget_provider_conversation', 'unknown']);
  });

  it('fails surface semantics closed when the provider contribution is disabled or malformed', async () => {
    const {
      registerVoiceAdapters,
      resolveVoiceAdapterSurfaceCapabilities,
    } = await import('./voiceAdapterRegistry');

    registerVoiceAdapters([]);
    expect(resolveVoiceAdapterSurfaceCapabilities('realtime_elevenlabs', {})).toBeNull();

    const malformed = {
      id: 'malformed_provider',
      engineKind: 'realtime',
      start: async () => {},
      stop: async () => {},
      toggle: async () => {},
      interrupt: async () => {},
      setMuted: async () => {},
      sendContextUpdate: () => {},
      getSnapshot: () => ({
        adapterId: 'malformed_provider',
        sessionId: null,
        status: 'disconnected' as const,
        mode: 'idle' as const,
        canStop: false,
      }),
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'invalid',
        requiresVoiceAgentFeature: false,
        bargeInEnabled: true,
      }),
    } as unknown as VoiceAdapterController;
    registerVoiceAdapters([malformed]);
    expect(resolveVoiceAdapterSurfaceCapabilities('malformed_provider', {})).toBeNull();
  });
});
