import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installVoiceAgentCommonModuleMocks } from '@/voice/agent/voiceAgentTestHelpers';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const ensureBoundSpy = vi.fn(async (_args: any) => ({
  adapterId: 'local_conversation',
  controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
  conversationSessionId: 'carrier-1',
  transcriptMode: 'native_session',
  targetSessionId: 's1',
  updatedAt: 1,
}));
vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBound: (args: any) => ensureBoundSpy(args),
  },
}));

const stopSpy = vi.fn(async (_sessionId: string) => {});
vi.mock('@/voice/agent/voiceAgentSessions', () => ({
  voiceAgentSessions: {
    stop: (sessionId: string) => stopSpy(sessionId),
  },
}));

const state: any = {
  settings: {
    voice: {
      providerId: 'local_conversation',
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        },
      },
    },
  },
};

installVoiceAgentCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: { getState: () => state },
    });
  },
});

describe('teleportVoiceAgentToSessionRoot', () => {
  beforeEach(() => {
    vi.resetModules();
    ensureBoundSpy.mockReset();
    stopSpy.mockReset();
    state.settings.voice.providerId = 'local_conversation';
    state.settings.voice.adapters.local_conversation.conversationMode = 'agent';
    state.settings.voice.adapters.local_conversation.agent = { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true };
  });

  it('rebinds the global voice agent to the requested session root before stopping the global run', async () => {
    const { teleportVoiceAgentToSessionRoot } = await import('./teleportVoiceAgentToSessionRoot');

    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' })).resolves.toEqual({ ok: true });
    expect(ensureBoundSpy).toHaveBeenCalledWith({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: 's1',
    });
    expect(stopSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
  });

  it('fails closed when teleport is disabled', async () => {
    const { teleportVoiceAgentToSessionRoot } = await import('./teleportVoiceAgentToSessionRoot');
    state.settings.voice.adapters.local_conversation.agent.teleportEnabled = false;

    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' })).resolves.toEqual({ ok: false, code: 'VOICE_TELEPORT_DISABLED' });
    expect(ensureBoundSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('fails closed when stayInVoiceHome is enabled', async () => {
    const { teleportVoiceAgentToSessionRoot } = await import('./teleportVoiceAgentToSessionRoot');
    state.settings.voice.adapters.local_conversation.agent.stayInVoiceHome = true;

    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' })).resolves.toEqual({ ok: false, code: 'VOICE_TELEPORT_BLOCKED_BY_HOME' });
    expect(ensureBoundSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });
});
