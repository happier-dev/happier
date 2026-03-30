import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

const syncTargetSession = vi.fn();
const state: any = {
  sessions: {
    s1: { id: 's1', metadata: { summary: { text: 'Primary session' } } },
    s2: { id: 's2', metadata: { summary: { text: 'Tracked session' } } },
    s3: { id: 's3', metadata: { summary: { text: 'Session Setup' } } },
    s4: { id: 's4', metadata: { name: 'leeroy' }, updatedAt: 10 },
  },
  sessionListViewData: [
    {
      type: 'session',
      session: {
        id: 's4',
        updatedAt: 10,
        metadata: { summaryText: 'Session QA Voice Matrix' },
      },
    },
  ],
};

vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: {
    syncTargetSession: (params: any) => syncTargetSession(params),
  },
}));

installVoiceToolActionImplCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => state,
            } as typeof import('@/sync/domains/state/storage').storage,
        });
    },
});

describe('voice session target actions', () => {
  beforeEach(() => {
    vi.resetModules();
    syncTargetSession.mockReset();
  });

  it('syncs the hidden voice conversation target when the primary action session changes', async () => {
    const { setPrimaryActionSessionId } = await import('./sessionTargets');

    const result = await setPrimaryActionSessionId({ sessionId: 's2' });

    expect(syncTargetSession).toHaveBeenCalledWith({
      controlSessionId: '__voice_agent__',
      targetSessionId: 's2',
    });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's2',
      session: {
        id: 's2',
        title: 'Tracked session',
      },
    });
  });

  it('returns tracked session labels using the normalized stored ordering', async () => {
    const { setTrackedSessionIds } = await import('./sessionTargets');

    const result = await setTrackedSessionIds({ sessionIds: ['s2', ' s1 ', 's2'] });

    expect(result).toMatchObject({
      ok: true,
      sessionIds: ['s1', 's2'],
      sessions: [
        { id: 's1', title: 'Primary session' },
        { id: 's2', title: 'Tracked session' },
      ],
    });
  });

  it('resolves the primary action session by human title without storing sentence punctuation', async () => {
    const { setPrimaryActionSessionId } = await import('./sessionTargets');

    const result = await setPrimaryActionSessionId({ sessionId: null, sessionTitle: 'Session Setup.' });

    expect(syncTargetSession).toHaveBeenCalledWith({
      controlSessionId: '__voice_agent__',
      targetSessionId: 's3',
    });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's3',
      session: {
        id: 's3',
        title: 'Session Setup',
      },
    });
  });

  it('prefers the visible session title over a stale raw session title for the same session id', async () => {
    const { setPrimaryActionSessionId } = await import('./sessionTargets');

    const result = await setPrimaryActionSessionId({ sessionId: null, sessionTitle: 'Session QA Voice Matrix' });

    expect(syncTargetSession).toHaveBeenCalledWith({
      controlSessionId: '__voice_agent__',
      targetSessionId: 's4',
    });
    expect(result).toMatchObject({
      ok: true,
      sessionId: 's4',
      session: {
        id: 's4',
        title: 'Session QA Voice Matrix',
      },
    });
  });
});
