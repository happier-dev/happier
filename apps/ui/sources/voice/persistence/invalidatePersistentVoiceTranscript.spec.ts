import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => {
  const state: any = {
    settings: {
      voice: {
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
      },
    },
    applySettingsLocal: vi.fn((patch: any) => {
      if (patch?.voice) state.settings.voice = patch.voice;
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
    state.settings.voice = {
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: { agent: { transcript: { persistenceMode: 'persistent', epoch: 2 } } },
        },
      },
    };
    state.applySettingsLocal.mockReset();
  });

  it('increments the transcript epoch through the canonical provider envelope', async () => {
    const { invalidatePersistentVoiceTranscript } = await import('./invalidatePersistentVoiceTranscript');

    expect(invalidatePersistentVoiceTranscript()).toBe(3);
    expect(state.applySettingsLocal).toHaveBeenCalled();
    expect(state.settings.voice.providers.local_conversation.config.agent.transcript.epoch).toBe(3);
  });
});
