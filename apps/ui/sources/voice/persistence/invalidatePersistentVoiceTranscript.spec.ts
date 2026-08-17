import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => {
  const voice = {
    providers: {
      local_conversation: {
        schemaVersion: 1,
        config: { agent: {
          transcript: {
            persistenceMode: 'persistent',
            epoch: 2,
          },
        } },
      },
    },
  };
  const state: any = {
    settings: {
      voiceSettingsV1: voice,
      voice,
    },
    applySettingsLocal: vi.fn((patch: any) => {
      state.settings = { ...state.settings, ...patch };
    }),
  };
  return { state };
});

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    storage: {
      getState: () => state,
    },
  });
});

describe('invalidatePersistentVoiceTranscript', () => {
  beforeEach(() => {
    vi.resetModules();
    const voice = {
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { agent: { transcript: { persistenceMode: 'persistent', epoch: 2 } } },
        },
      },
    };
    state.settings = {
      voiceSettingsV1: voice,
      voice,
    };
    state.applySettingsLocal.mockReset();
    state.applySettingsLocal.mockImplementation((patch: any) => {
      state.settings = { ...state.settings, ...patch };
    });
  });

  it('increments the transcript epoch through both canonical and runtime Voice projections', async () => {
    const { invalidatePersistentVoiceTranscript } = await import('./invalidatePersistentVoiceTranscript');

    expect(invalidatePersistentVoiceTranscript()).toBe(3);
    expect(state.applySettingsLocal).toHaveBeenCalled();
    expect(state.settings.voice.providers.local_conversation.config.agent.transcript.epoch).toBe(3);
    expect(state.settings.voiceSettingsV1.providers.local_conversation.config.agent.transcript.epoch).toBe(3);
  });
});
