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

import { clearPersistence } from '@/sync/domains/state/persistence';

import { createSessionsDomain } from './sessions';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionListIndexByServerId: {},
        sessionListRowStateByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
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

    it('updates whether a session review comment draft is included in the next prompt', () => {
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
    });

    it('updates whether a workspace review comment draft is included in the next prompt', () => {
        const { get, domain } = createHarness();

        domain.upsertWorkspaceReviewCommentDraft('workspace-key', {
            id: 'c1',
            filePath: 'src/a.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
            body: 'nit',
            createdAt: 1,
        });

        domain.setWorkspaceReviewCommentDraftIncluded('workspace-key', 'c1', false);

        expect(get().reviewCommentsDraftsByWorkspaceCacheKey['workspace-key'][0]?.includeInPrompt).toBe(false);
    });
});
