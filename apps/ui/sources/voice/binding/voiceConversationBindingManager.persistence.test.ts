import { describe, expect, it, vi } from 'vitest';

import { createVoiceSessionBindingManager } from './voiceConversationBindingManager';
import { createVoiceSessionBindingStore } from './voiceConversationBindingStore';

describe('voice conversation binding persistence publication', () => {
  it('publishes a resolved binding only after persistence succeeds and allows a safe retry', async () => {
    const persistenceFailure = new Error('binding persistence failed');
    const appendNote = vi.fn();
    const persistBinding = vi.fn()
      .mockRejectedValueOnce(persistenceFailure)
      .mockResolvedValueOnce(undefined);
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
      persistBinding,
    });
    const input = {
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: 's1',
    };

    await expect(manager.ensureBound(input)).rejects.toBe(persistenceFailure);
    expect(store.getState().getByConversationSessionId('carrier-s1')).toBeNull();
    expect(store.getState().getByControlSessionId('voice-global')).toBeNull();
    expect(appendNote).not.toHaveBeenCalled();

    await expect(manager.ensureBound(input)).resolves.toEqual(expect.objectContaining({
      conversationSessionId: 'carrier-s1',
      targetSessionId: 's1',
    }));
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(expect.objectContaining({
      conversationSessionId: 'carrier-s1',
      targetSessionId: 's1',
    }));
    expect(persistBinding).toHaveBeenCalledTimes(2);
    expect(appendNote).not.toHaveBeenCalled();
  });

  it('keeps the prior target and emits no switch note when target persistence fails, then retries safely', async () => {
    const persistenceFailure = new Error('target persistence failed');
    const appendNote = vi.fn();
    const persistBinding = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(persistenceFailure)
      .mockResolvedValueOnce(undefined);
    const store = createVoiceSessionBindingStore();
    const manager = createVoiceSessionBindingManager({
      store,
      nowMs: () => 456,
      resolveBinding: vi.fn(async () => ({
        conversationSessionId: 'carrier-s1',
        controlSessionId: 'voice-global',
        transcriptMode: 'synthetic' as const,
        targetSessionId: 's1',
      })),
      appendTargetSwitchNote: appendNote,
      persistBinding,
    });
    await manager.ensureBound({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      requestedTargetSessionId: 's1',
    });
    appendNote.mockClear();

    await expect(Promise.resolve().then(() => manager.syncTargetSession({
      controlSessionId: 'voice-global',
      targetSessionId: 's2',
    }))).rejects.toBe(persistenceFailure);
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(expect.objectContaining({
      targetSessionId: 's1',
    }));
    expect(appendNote).not.toHaveBeenCalled();

    await expect(manager.syncTargetSession({
      controlSessionId: 'voice-global',
      targetSessionId: 's2',
    })).resolves.toEqual(expect.objectContaining({
      targetSessionId: 's2',
    }));
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(expect.objectContaining({
      targetSessionId: 's2',
    }));
    expect(persistBinding).toHaveBeenCalledTimes(3);
    expect(appendNote).toHaveBeenCalledTimes(1);
  });

  it('surfaces rebind persistence failure instead of silently reopening the old conversation', async () => {
    const persistenceFailure = new Error('rebind persistence failed');
    const appendNote = vi.fn();
    const store = createVoiceSessionBindingStore();
    const manager = createVoiceSessionBindingManager({
      store,
      nowMs: () => 2,
      resolveBinding: vi.fn(async () => ({
        conversationSessionId: 'carrier-s2',
        controlSessionId: 'voice-global',
        transcriptMode: 'native_session' as const,
        targetSessionId: 's2',
      })),
      resolveExistingBindingByConversationSessionId: () => ({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-s1',
        transcriptMode: 'native_session',
        targetSessionId: 's1',
        updatedAt: 1,
      }),
      appendTargetSwitchNote: appendNote,
      persistBinding: vi.fn(async () => {
        throw persistenceFailure;
      }),
    });

    await expect(manager.ensureBoundForOpenConversation({
      openConversationSessionId: 'carrier-s1',
      fallbackControlSessionId: 'voice-global',
      activeAdapterId: 'local_conversation',
      providerId: 'local_conversation',
      requestedTargetSessionId: 's2',
    })).rejects.toBe(persistenceFailure);
    expect(store.getState().getByConversationSessionId('carrier-s2')).toBeNull();
    expect(appendNote).not.toHaveBeenCalled();
  });
});
