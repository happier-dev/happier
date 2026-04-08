import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => {
  const state: any = {
    settings: {
      voice: {
        adapters: {
          local_conversation: {
            agent: {
              transcript: {
                persistenceMode: ' persistent ',
                epoch: 2,
              },
            },
          },
        },
      },
    },
    applySettingsLocal: vi.fn((patch: any) => {
      const nextTranscript = patch?.voice?.adapters?.local_conversation?.agent?.transcript;
      if (nextTranscript && typeof nextTranscript === 'object') {
        state.settings.voice.adapters.local_conversation.agent.transcript = {
          ...(state.settings.voice.adapters.local_conversation.agent.transcript ?? {}),
          ...nextTranscript,
        };
      }
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
    state.settings.voice.adapters.local_conversation.agent.transcript = {
      persistenceMode: ' persistent ',
      epoch: 2,
    };
    state.applySettingsLocal.mockReset();
  });

  it('increments the transcript epoch when the persistence mode is padded', async () => {
    const { invalidatePersistentVoiceTranscript } = await import('./invalidatePersistentVoiceTranscript');

    expect(invalidatePersistentVoiceTranscript()).toBe(3);
    expect(state.applySettingsLocal).toHaveBeenCalled();
    expect(state.settings.voice.adapters.local_conversation.agent.transcript.epoch).toBe(3);
  });
});
