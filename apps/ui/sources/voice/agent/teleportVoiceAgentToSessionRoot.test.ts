import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

const ensureCarrierSpy = vi.fn(async (_args: any) => 'carrier-1');
vi.mock('@/voice/agent/voiceCarrierSession', () => ({
  ensureVoiceCarrierSessionForSessionRoot: (args: any) => ensureCarrierSpy(args),
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

vi.mock('@/sync/domains/state/storage', () => ({
  storage: { getState: () => state },
}));

describe('teleportVoiceAgentToSessionRoot', () => {
  beforeEach(() => {
    vi.resetModules();
    ensureCarrierSpy.mockReset();
    stopSpy.mockReset();
    state.settings.voice.providerId = 'local_conversation';
    state.settings.voice.adapters.local_conversation.conversationMode = 'agent';
    state.settings.voice.adapters.local_conversation.agent = { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true };
  });

  it('touches the session-root carrier and restarts the global voice agent run', async () => {
    const { teleportVoiceAgentToSessionRoot } = await import('./teleportVoiceAgentToSessionRoot');

    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' })).resolves.toEqual({ ok: true });
    expect(ensureCarrierSpy).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(stopSpy).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
  });

  it('fails closed when teleport is disabled', async () => {
    const { teleportVoiceAgentToSessionRoot } = await import('./teleportVoiceAgentToSessionRoot');
    state.settings.voice.adapters.local_conversation.agent.teleportEnabled = false;

    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' })).resolves.toEqual({ ok: false, code: 'VOICE_TELEPORT_DISABLED' });
    expect(ensureCarrierSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('fails closed when stayInVoiceHome is enabled', async () => {
    const { teleportVoiceAgentToSessionRoot } = await import('./teleportVoiceAgentToSessionRoot');
    state.settings.voice.adapters.local_conversation.agent.stayInVoiceHome = true;

    await expect(teleportVoiceAgentToSessionRoot({ sessionId: 's1' })).resolves.toEqual({ ok: false, code: 'VOICE_TELEPORT_BLOCKED_BY_HOME' });
    expect(ensureCarrierSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });
});
