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
        reviewCommentsDraftsByWorkspaceCacheKey: {},
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
    set(domain as any);
    return { get, domain };
}

describe('sessions domain: review comment drafts', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('upserts and deletes review comment drafts per session', () => {
        const { get, domain } = createHarness();

        domain.upsertSessionReviewCommentDraft('s1', {
            id: 'c1',
            filePath: 'src/a.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
            body: 'nit',
            createdAt: 1,
        });

        expect(get().reviewCommentsDraftsBySessionId.s1).toHaveLength(1);

        domain.deleteSessionReviewCommentDraft('s1', 'c1');
        expect(get().reviewCommentsDraftsBySessionId.s1 ?? []).toHaveLength(0);
    });

    it('updates whether a review comment draft is included in the next prompt', () => {
        const { get, domain } = createHarness();

        domain.upsertSessionReviewCommentDraft('s1', {
            id: 'c1',
            filePath: 'src/a.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
            body: 'nit',
            createdAt: 1,
        });

        domain.setSessionReviewCommentDraftIncluded('s1', 'c1', false);

        expect(get().reviewCommentsDraftsBySessionId.s1[0]?.includeInPrompt).toBe(false);

        domain.setSessionReviewCommentDraftIncluded('s1', 'c1', true);

        expect(get().reviewCommentsDraftsBySessionId.s1[0]?.includeInPrompt).toBe(true);
    });

    it('upserts and deletes review comment drafts per workspace cache key', () => {
        const { get, domain } = createHarness();

        expect(domain.upsertWorkspaceReviewCommentDraft).toBeTypeOf('function');
        domain.upsertWorkspaceReviewCommentDraft('server-1:machine-1:/repo', {
            id: 'c1',
            filePath: 'src/a.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
            body: 'nit',
            createdAt: 1,
        });

        expect(get().reviewCommentsDraftsByWorkspaceCacheKey['server-1:machine-1:/repo']).toHaveLength(1);

        domain.deleteWorkspaceReviewCommentDraft('server-1:machine-1:/repo', 'c1');
        expect(get().reviewCommentsDraftsByWorkspaceCacheKey['server-1:machine-1:/repo'] ?? []).toHaveLength(0);
    });

    it('updates whether a workspace review comment draft is included in the next prompt', () => {
        const { get, domain } = createHarness();

        expect(domain.upsertWorkspaceReviewCommentDraft).toBeTypeOf('function');
        domain.upsertWorkspaceReviewCommentDraft('server-1:machine-1:/repo', {
            id: 'c1',
            filePath: 'src/a.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
            body: 'nit',
            createdAt: 1,
        });

        domain.setWorkspaceReviewCommentDraftIncluded('server-1:machine-1:/repo', 'c1', false);

        expect(get().reviewCommentsDraftsByWorkspaceCacheKey['server-1:machine-1:/repo'][0]?.includeInPrompt).toBe(false);

        domain.setWorkspaceReviewCommentDraftIncluded('server-1:machine-1:/repo', 'c1', true);

        expect(get().reviewCommentsDraftsByWorkspaceCacheKey['server-1:machine-1:/repo'][0]?.includeInPrompt).toBe(true);
    });
});
