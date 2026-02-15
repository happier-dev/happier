import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }
        set(key: string, value: string) {
            mmkvStore.set(key, value);
        }
        delete(key: string) {
            mmkvStore.delete(key);
        }
        clearAll() {
            mmkvStore.clear();
        }
    }
    return { MMKV };
});

import { createSessionsDomain } from './sessions';
import { clearPersistence } from '@/sync/domains/state/persistence';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        sessionMessages: {},
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    // Mirror store initialization behavior: domain's initial values are merged into state.
    set(domain as any);
    return { get, domain };
}

describe('sessions domain: action drafts', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('creates, updates, and deletes action drafts per session', () => {
        const { get, domain } = createHarness();

        const created = domain.createSessionActionDraft('s1', {
            actionId: 'review.start',
            input: { changeType: 'committed', base: { kind: 'none' } },
        });

        expect(created.sessionId).toBe('s1');
        expect(created.actionId).toBe('review.start');
        expect((get().actionDraftsBySessionId.s1 ?? []).length).toBe(1);

        domain.updateSessionActionDraftInput('s1', created.id, { instructions: 'Review this.' });
        const afterUpdate = (get().actionDraftsBySessionId.s1 ?? [])[0];
        expect(afterUpdate?.input?.instructions).toBe('Review this.');

        domain.setSessionActionDraftStatus('s1', created.id, 'running');
        const afterStatus = (get().actionDraftsBySessionId.s1 ?? [])[0];
        expect(afterStatus?.status).toBe('running');

        domain.deleteSessionActionDraft('s1', created.id);
        expect((get().actionDraftsBySessionId.s1 ?? []).length).toBe(0);
    });

    it('persists action drafts locally and reloads them on a fresh domain instance', () => {
        const { domain } = createHarness();

        const created = domain.createSessionActionDraft('s1', {
            actionId: 'review.start',
            input: { instructions: 'Review this.', engineIds: ['codex'], changeType: 'committed', base: { kind: 'none' } },
        });

        const { get: get2 } = createHarness();
        expect((get2().actionDraftsBySessionId.s1 ?? []).some((d: any) => d.id === created.id)).toBe(true);
    });

    it('removes persisted action drafts when deleting a session', () => {
        const { domain } = createHarness();
        domain.createSessionActionDraft('s1', {
            actionId: 'review.start',
            input: { instructions: 'Review this.', engineIds: ['codex'], changeType: 'committed', base: { kind: 'none' } },
        });

        domain.deleteSession('s1');

        const { get: get2 } = createHarness();
        expect(get2().actionDraftsBySessionId.s1 ?? []).toEqual([]);
    });
});
