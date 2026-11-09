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
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { filterReviewCommentDraftsIncludedInPrompt } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionListIndexByServerId: {},
        sessionListRowsByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        sessionMessageToolVersion: 0,
        settings: {},
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

    it.each(['session', 'workspace'] as const)('clears only unchanged captured included %s drafts after an async send', (scope) => {
        const captured: ReviewCommentDraft = {
            id: 'sent', filePath: 'src/a.ts', source: 'file',
            anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { selectedLines: ['original'], beforeContext: [], afterContext: [] },
            body: 'original comment', createdAt: 1,
        };
        for (const edit of [
            { body: 'newer comment' },
            { anchor: { kind: 'fileLine' as const, startLine: 9 } },
            { snapshot: { selectedLines: ['newer code'], beforeContext: [], afterContext: [] } },
            { includeInPrompt: false },
        ]) {
            clearPersistence();
            const { get, domain } = createHarness();
            const upsert = scope === 'session' ? domain.upsertSessionReviewCommentDraft : domain.upsertWorkspaceReviewCommentDraft;
            const remove = scope === 'session' ? domain.deleteSessionReviewCommentDraft : domain.deleteWorkspaceReviewCommentDraft;
            const read = () => scope === 'session'
                ? get().reviewCommentsDraftsBySessionId.s1
                : get().reviewCommentsDraftsByWorkspaceCacheKey.s1;
            const unchanged = { ...captured, id: 'unchanged' };
            const excluded = { ...captured, id: 'excluded', includeInPrompt: false };
            upsert('s1', captured);
            upsert('s1', unchanged);
            upsert('s1', excluded);
            const sent = filterReviewCommentDraftsIncludedInPrompt(read());
            const newer = { ...captured, ...edit };
            upsert('s1', newer);
            for (const draft of sent) remove('s1', draft.id, structuredClone(draft));
            expect(read()).toEqual([newer, excluded]);
            const retained = read();
            remove('s1', 'sent', captured);
            expect(read()).toBe(retained);
            // A direct user deletion is still unconditional.
            remove('s1', 'sent');
            expect(read()).toEqual([excluded]);
        }
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
