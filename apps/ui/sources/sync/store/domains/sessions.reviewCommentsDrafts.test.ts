import { describe, expect, it } from 'vitest';

import { createSessionsDomain } from './sessions';

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
    return { get, domain };
}

describe('sessions domain: review comment drafts', () => {
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
});
