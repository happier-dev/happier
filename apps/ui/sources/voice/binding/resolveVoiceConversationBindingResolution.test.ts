import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureVoiceConversationSessionForVoiceHome = vi.fn();
const ensureVoiceConversationSessionForSessionRoot = vi.fn();
const recoverUnavailableGlobalVoiceAutoMachine = vi.fn();
const setVoiceAgentRecoveryReplaySource = vi.fn();

vi.mock('@/voice/persistence/voiceConversationSession', () => ({
  ensureVoiceConversationSessionForVoiceHome: (...args: any[]) => ensureVoiceConversationSessionForVoiceHome(...args),
  ensureVoiceConversationSessionForSessionRoot: (...args: any[]) => ensureVoiceConversationSessionForSessionRoot(...args),
}));

vi.mock('@/voice/agent/recoverUnavailableGlobalVoiceAutoMachine', () => ({
  recoverUnavailableGlobalVoiceAutoMachine: (...args: any[]) => recoverUnavailableGlobalVoiceAutoMachine(...args),
}));

vi.mock('@/voice/agent/voiceAgentRecoveryReplayState', () => ({
  setVoiceAgentRecoveryReplaySource: (...args: any[]) => setVoiceAgentRecoveryReplaySource(...args),
  clearVoiceAgentRecoveryReplaySource: vi.fn(),
  readVoiceAgentRecoveryReplaySource: vi.fn(),
}));

import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import { createBuiltinVoiceAdapters } from '@/voice/adapters/registerBuiltinVoiceAdapters';

describe('ensureVoiceConversationBindingResolution', () => {
  beforeEach(() => {
    ensureVoiceConversationSessionForVoiceHome.mockReset();
    ensureVoiceConversationSessionForSessionRoot.mockReset();
    recoverUnavailableGlobalVoiceAutoMachine.mockReset();
    setVoiceAgentRecoveryReplaySource.mockReset();
    // The resolver reads transcript-mode via the provider registry capability
    // rather than branching on provider ids, so register the builtin adapters.
    resetVoiceAdapterRegistryForTests();
    registerVoiceAdapters(createBuiltinVoiceAdapters());
  });

  it('binds realtime voice to the target session root when a target session exists', async () => {
    ensureVoiceConversationSessionForSessionRoot.mockResolvedValue('voice-root-s1');

    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: 'realtime_elevenlabs',
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1',
      settings: {},
    });

    expect(resolution).toEqual({
      conversationSessionId: 'voice-root-s1',
      controlSessionId: '__voice_agent__',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
    });
    expect(ensureVoiceConversationSessionForSessionRoot).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(ensureVoiceConversationSessionForVoiceHome).not.toHaveBeenCalled();
  });

  it('trims provider ids before resolving local conversation bindings', async () => {
    ensureVoiceConversationSessionForVoiceHome.mockResolvedValue('voice-home');

    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: ' local_conversation ',
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: null,
      settings: {
        voice: {
          adapters: {
            local_conversation: {
              conversationMode: 'agent',
              agent: { backend: 'daemon' },
            },
          },
        },
      },
    });

    expect(resolution).toEqual({
      conversationSessionId: 'voice-home',
      controlSessionId: '__voice_agent__',
      transcriptMode: 'native_session',
      targetSessionId: null,
    });
    expect(ensureVoiceConversationSessionForVoiceHome).toHaveBeenCalledTimes(1);
    expect(ensureVoiceConversationSessionForSessionRoot).not.toHaveBeenCalled();
  });

  it('uses voice home and native transcript mode for local daemon agent sessions when no target session exists', async () => {
    ensureVoiceConversationSessionForVoiceHome.mockResolvedValue('voice-home');

    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: null,
      settings: {
        voice: {
          adapters: {
            local_conversation: {
              conversationMode: 'agent',
              agent: { backend: 'daemon' },
            },
          },
        },
      },
    });

    expect(resolution).toEqual({
      conversationSessionId: 'voice-home',
      controlSessionId: '__voice_agent__',
      transcriptMode: 'native_session',
      targetSessionId: null,
    });
    expect(ensureVoiceConversationSessionForVoiceHome).toHaveBeenCalledTimes(1);
    expect(ensureVoiceConversationSessionForSessionRoot).not.toHaveBeenCalled();
  });

  it('binds local daemon agent sessions to the target session root when a target session exists', async () => {
    ensureVoiceConversationSessionForSessionRoot.mockResolvedValue('voice-root-s1');

    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1',
      settings: {
        voice: {
          adapters: {
            local_conversation: {
              conversationMode: 'agent',
              agent: { backend: 'daemon' },
            },
          },
        },
      },
    });

    expect(resolution).toEqual({
      conversationSessionId: 'voice-root-s1',
      controlSessionId: '__voice_agent__',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
    });
    expect(ensureVoiceConversationSessionForSessionRoot).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(ensureVoiceConversationSessionForVoiceHome).not.toHaveBeenCalled();
  });

  it('uses voice home for local daemon agent sessions when stayInVoiceHome is enabled even if a target session exists', async () => {
    ensureVoiceConversationSessionForVoiceHome.mockResolvedValue('voice-home');

    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's1',
      settings: {
        voice: {
          adapters: {
            local_conversation: {
              conversationMode: 'agent',
              agent: { backend: 'daemon', stayInVoiceHome: true },
            },
          },
        },
      },
    });

    expect(resolution).toEqual({
      conversationSessionId: 'voice-home',
      controlSessionId: '__voice_agent__',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
    });
    expect(ensureVoiceConversationSessionForVoiceHome).toHaveBeenCalledTimes(1);
    expect(ensureVoiceConversationSessionForSessionRoot).not.toHaveBeenCalled();
  });

  it('recovers a global local daemon voice-home binding by switching machines and preserving replay context', async () => {
    ensureVoiceConversationSessionForVoiceHome
      .mockRejectedValueOnce(Object.assign(new Error('voice_conversation_spawn_target_missing'), {
        code: 'VOICE_CONVERSATION_TARGET_MISSING',
      }))
      .mockResolvedValueOnce('voice-home-new-machine');
    recoverUnavailableGlobalVoiceAutoMachine.mockResolvedValue({
      kind: 'switch',
      nextMachineId: 'm_new',
      replayConversation: true,
      replaySourceConversationSessionId: 'sys_voice_old',
    });

    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: null,
      settings: {
        voice: {
          adapters: {
            local_conversation: {
              conversationMode: 'agent',
              agent: { backend: 'daemon', machineTargetMode: 'auto' },
            },
          },
        },
      },
    });

    expect(recoverUnavailableGlobalVoiceAutoMachine).toHaveBeenCalledTimes(1);
    expect(setVoiceAgentRecoveryReplaySource).toHaveBeenCalledWith('__voice_agent__', 'sys_voice_old');
    expect(ensureVoiceConversationSessionForVoiceHome).toHaveBeenCalledTimes(2);
    expect(resolution).toEqual({
      conversationSessionId: 'voice-home-new-machine',
      controlSessionId: '__voice_agent__',
      transcriptMode: 'native_session',
      targetSessionId: null,
    });
  });

  it('binds local openai-compatible agent sessions to the target session root when a target session exists', async () => {
    ensureVoiceConversationSessionForSessionRoot.mockResolvedValue('voice-root-s2');

    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      requestedTargetSessionId: 's2',
      settings: {
        voice: {
          adapters: {
            local_conversation: {
              conversationMode: 'agent',
              agent: { backend: 'openai_compat' },
            },
          },
        },
      },
    });

    expect(resolution?.transcriptMode).toBe('synthetic');
    expect(resolution?.conversationSessionId).toBe('voice-root-s2');
    expect(ensureVoiceConversationSessionForSessionRoot).toHaveBeenCalledWith({ sessionId: 's2' });
    expect(ensureVoiceConversationSessionForVoiceHome).not.toHaveBeenCalled();
  });

  it('resolves a registry-driven provider via its transcript-mode capability without editing the resolver', async () => {
    ensureVoiceConversationSessionForSessionRoot.mockResolvedValue('voice-root-custom');
    // A third provider, contributed only through the registry capability.
    registerVoiceAdapters([
      ...createBuiltinVoiceAdapters(),
      {
        id: 'custom_provider',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        setMuted: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        resolveBindingTranscriptMode: () => 'synthetic',
      },
    ]);

    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: 'custom_provider',
      controlSessionId: 's9',
      requestedTargetSessionId: 's9',
      settings: {},
    });

    expect(resolution).toEqual({
      conversationSessionId: 'voice-root-custom',
      controlSessionId: 's9',
      transcriptMode: 'synthetic',
      targetSessionId: 's9',
    });
  });

  it('returns null for providers that do not expose a hidden voice conversation session', async () => {
    const { ensureVoiceConversationBindingResolution } = await import('./resolveVoiceConversationBindingResolution');
    const resolution = await ensureVoiceConversationBindingResolution({
      providerId: 'local_direct',
      controlSessionId: 's1',
      requestedTargetSessionId: 's1',
      settings: {},
    });

    expect(resolution).toBeNull();
    expect(ensureVoiceConversationSessionForSessionRoot).not.toHaveBeenCalled();
    expect(ensureVoiceConversationSessionForVoiceHome).not.toHaveBeenCalled();
  });
});
