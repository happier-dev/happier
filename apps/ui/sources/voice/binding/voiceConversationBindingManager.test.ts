import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('createVoiceSessionBindingManager', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('stores a binding returned by the resolver', async () => {
    const appendNote = vi.fn();
    const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

    const store = createVoiceSessionBindingStore();
    const manager = createVoiceSessionBindingManager({
      store,
      nowMs: () => 123,
      resolveBinding: vi.fn(async () => ({
        conversationSessionId: 'carrier-s1',
        controlSessionId: 'voice-global',
        transcriptMode: 'synthetic' as const,
        targetSessionId: 's1',
      })),
      appendTargetSwitchNote: appendNote,
    });

    const binding = await manager.ensureBound({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: 's1',
    });

    expect(binding?.conversationSessionId).toBe('carrier-s1');
    expect(store.getState().getByConversationSessionId('carrier-s1')?.adapterId).toBe('realtime_elevenlabs');
    expect(store.getState().getByControlSessionId('voice-global')?.conversationSessionId).toBe('carrier-s1');
    expect(appendNote).not.toHaveBeenCalled();
  });

  it('appends a target-switch note when the target session changes within the same conversation session', async () => {
    const appendNote = vi.fn();
    const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

    const store = createVoiceSessionBindingStore();
    const resolveBinding = vi
      .fn()
      .mockResolvedValue({
        conversationSessionId: 'carrier-s1',
        controlSessionId: 'voice-global',
        transcriptMode: 'synthetic',
        targetSessionId: 's1',
      })
      .mockResolvedValueOnce({
        conversationSessionId: 'carrier-s1',
        controlSessionId: 'voice-global',
        transcriptMode: 'synthetic',
        targetSessionId: 's1',
      })
      .mockResolvedValueOnce({
        conversationSessionId: 'carrier-s1',
        controlSessionId: 'voice-global',
        transcriptMode: 'synthetic',
        targetSessionId: 's2',
      });

    const manager = createVoiceSessionBindingManager({
      store,
      nowMs: () => 123,
      resolveBinding,
      appendTargetSwitchNote: appendNote,
    });

    await manager.ensureBound({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: 's1',
    });
    await manager.ensureBound({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: 's2',
    });

    expect(appendNote).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionId: 's1',
      targetSessionId: 's2',
    });
  });

  it('updates the tracked target session without re-resolving the conversation session', async () => {
    const appendNote = vi.fn();
    const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

    const store = createVoiceSessionBindingStore();
    const resolveBinding = vi.fn(async () => ({
      conversationSessionId: 'carrier-s1',
      controlSessionId: 'voice-global',
      transcriptMode: 'synthetic' as const,
      targetSessionId: 's1',
    }));

    const manager = createVoiceSessionBindingManager({
      store,
      nowMs: () => 456,
      resolveBinding,
      appendTargetSwitchNote: appendNote,
    });

    await manager.ensureBound({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: 's1',
    });

    const next = manager.syncTargetSession({
      controlSessionId: 'voice-global',
      targetSessionId: 's2',
    });

    expect(resolveBinding).toHaveBeenCalledTimes(1);
    expect(next).toEqual(
      expect.objectContaining({
        conversationSessionId: 'carrier-s1',
        targetSessionId: 's2',
        updatedAt: 456,
      }),
    );
    expect(appendNote).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      previousTargetSessionId: 's1',
      targetSessionId: 's2',
    });
  });

  it('reuses an existing binding when re-resolution returns the same binding semantics', async () => {
    const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

    const store = createVoiceSessionBindingStore();
    const resolveBinding = vi
      .fn()
      .mockResolvedValueOnce({
        conversationSessionId: 'carrier-s1',
        controlSessionId: 'voice-global',
        transcriptMode: 'native_session' as const,
        targetSessionId: null,
      })
      .mockResolvedValueOnce({
        conversationSessionId: 'carrier-s1',
        controlSessionId: 'voice-global',
        transcriptMode: 'native_session' as const,
        targetSessionId: null,
      });

    const manager = createVoiceSessionBindingManager({
      store,
      nowMs: () => 789,
      resolveBinding,
    });

    const initial = await manager.ensureBound({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: null,
    });

    await expect(
      manager.ensureBound({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        requestedTargetSessionId: null,
      }),
    ).resolves.toEqual(initial);
    expect(resolveBinding).toHaveBeenCalledTimes(2);
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(initial);
  });

  it('canonicalizes ids before resolving and storing a binding', async () => {
    const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

    const store = createVoiceSessionBindingStore();
    const nowMs = vi.fn()
      .mockReturnValueOnce(123)
      .mockReturnValueOnce(456);
    const resolveBinding = vi.fn(async () => ({
      conversationSessionId: 'carrier-s1',
      controlSessionId: 'voice-global',
      transcriptMode: 'synthetic' as const,
      targetSessionId: 's1',
    }));
    const manager = createVoiceSessionBindingManager({
      store,
      nowMs,
      resolveBinding,
    });

    const initial = await manager.ensureBound({
      adapterId: ' realtime_elevenlabs ',
      controlSessionId: ' voice-global ',
      requestedTargetSessionId: ' s1 ',
    });
    const rebound = await manager.ensureBound({
      adapterId: ' realtime_elevenlabs ',
      controlSessionId: ' voice-global ',
      requestedTargetSessionId: ' s1 ',
    });

    expect(resolveBinding).toHaveBeenNthCalledWith(1, {
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: 's1',
    });
    expect(resolveBinding).toHaveBeenNthCalledWith(2, {
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: 's1',
    });
    expect(rebound).toEqual(initial);
    expect(nowMs).toHaveBeenCalledTimes(1);
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(initial);
  });

  describe('ensureBoundForOpenConversation', () => {
    it('routes to the existing conversation session without rebinding when the target already matches', async () => {
      const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
      const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

      const store = createVoiceSessionBindingStore();
      const resolveBinding = vi.fn(async () => null);
      const manager = createVoiceSessionBindingManager({
        store,
        nowMs: () => 1,
        resolveBinding,
        resolveExistingBindingByConversationSessionId: () => ({
          adapterId: 'realtime_elevenlabs',
          controlSessionId: 'voice-global',
          conversationSessionId: 'carrier-s1',
          transcriptMode: 'synthetic',
          targetSessionId: 's1',
          updatedAt: 1,
        }),
      });

      const result = await manager.ensureBoundForOpenConversation({
        openConversationSessionId: 'carrier-s1',
        fallbackControlSessionId: 'voice-global',
        activeAdapterId: 'realtime_elevenlabs',
        providerId: 'realtime_elevenlabs',
        requestedTargetSessionId: 's1',
      });

      expect(resolveBinding).not.toHaveBeenCalled();
      expect(result).toEqual({ conversationSessionId: 'carrier-s1' });
    });

    it('rebinds through ensureBound when the requested target drifts from the existing binding', async () => {
      const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
      const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

      const store = createVoiceSessionBindingStore();
      const resolveBinding = vi.fn(async () => ({
        conversationSessionId: 'carrier-s2',
        controlSessionId: 'voice-global',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's2',
      }));
      const manager = createVoiceSessionBindingManager({
        store,
        nowMs: () => 2,
        resolveBinding,
        resolveExistingBindingByConversationSessionId: () => ({
          adapterId: 'local_conversation',
          controlSessionId: 'voice-global',
          conversationSessionId: 'carrier-s1',
          transcriptMode: 'native_session',
          targetSessionId: 's1',
          updatedAt: 1,
        }),
      });

      const result = await manager.ensureBoundForOpenConversation({
        openConversationSessionId: 'carrier-s1',
        fallbackControlSessionId: 'voice-global',
        activeAdapterId: 'local_conversation',
        providerId: 'local_conversation',
        requestedTargetSessionId: 's2',
      });

      expect(resolveBinding).toHaveBeenCalledWith({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        requestedTargetSessionId: 's2',
      });
      expect(result).toEqual({ conversationSessionId: 'carrier-s2' });
    });

    it('rebinds when no existing binding is found, using the active adapter then provider id', async () => {
      const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
      const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

      const store = createVoiceSessionBindingStore();
      const resolveBinding = vi.fn(async () => ({
        conversationSessionId: 'voice-root-s1',
        controlSessionId: 'voice-global',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's1',
      }));
      const manager = createVoiceSessionBindingManager({
        store,
        nowMs: () => 3,
        resolveBinding,
        resolveExistingBindingByConversationSessionId: () => null,
      });

      const result = await manager.ensureBoundForOpenConversation({
        openConversationSessionId: 'carrier-s1',
        fallbackControlSessionId: 'voice-global',
        activeAdapterId: null,
        providerId: 'local_conversation',
        requestedTargetSessionId: 's1',
      });

      expect(resolveBinding).toHaveBeenCalledWith({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        requestedTargetSessionId: 's1',
      });
      expect(result).toEqual({ conversationSessionId: 'voice-root-s1' });
    });

    it('falls back to the original conversation session when rebinding cannot proceed', async () => {
      const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
      const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

      const store = createVoiceSessionBindingStore();
      const resolveBinding = vi.fn(async () => null);
      const manager = createVoiceSessionBindingManager({
        store,
        nowMs: () => 4,
        resolveBinding,
        resolveExistingBindingByConversationSessionId: () => null,
      });

      const result = await manager.ensureBoundForOpenConversation({
        openConversationSessionId: 'carrier-s1',
        fallbackControlSessionId: null,
        activeAdapterId: null,
        providerId: 'realtime_elevenlabs',
        requestedTargetSessionId: null,
      });

      expect(result).toEqual({ conversationSessionId: 'carrier-s1' });
    });
  });

  it('rebinds when re-resolution changes binding semantics for the same control session and target session', async () => {
    const { createVoiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { createVoiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingManager');

    const store = createVoiceSessionBindingStore();
    const resolveBinding = vi
      .fn()
      .mockResolvedValueOnce({
        conversationSessionId: 'carrier-home',
        controlSessionId: 'voice-global',
        transcriptMode: 'native_session' as const,
        targetSessionId: null,
      })
      .mockResolvedValueOnce({
        conversationSessionId: 'carrier-root',
        controlSessionId: 'voice-global',
        transcriptMode: 'synthetic' as const,
        targetSessionId: null,
      });

    const manager = createVoiceSessionBindingManager({
      store,
      nowMs: () => 790,
      resolveBinding,
    });

    await manager.ensureBound({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: null,
    });

    const rebound = await manager.ensureBound({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: null,
    });

    expect(resolveBinding).toHaveBeenCalledTimes(2);
    expect(rebound).toEqual(expect.objectContaining({
      conversationSessionId: 'carrier-root',
      transcriptMode: 'synthetic',
      updatedAt: 790,
    }));
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(rebound);
  });
});
