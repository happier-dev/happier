import { describe, expect, it } from 'vitest';

import { createSessionsDomain } from './sessions';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionGitStatus: {},
        sessionLastViewed: {},
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

describe('sessions domain: permissionMode normalization', () => {
    it('normalizes legacy provider tokens from metadata to canonical intents', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    permissionMode: 'acceptEdits',
                    permissionModeUpdatedAt: 1000,
                },
            } as any,
        ]);

        expect(get().sessions.s1.permissionMode).toBe('safe-yolo');
        expect(get().sessions.s1.permissionModeUpdatedAt).toBe(1000);
    });

    it('canonicalizes provider tokens when updating the session permission mode locally', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);

        domain.updateSessionPermissionMode('s1', 'acceptEdits' as any);

        expect(get().sessions.s1.permissionMode).toBe('safe-yolo');
        expect(typeof get().sessions.s1.permissionModeUpdatedAt).toBe('number');
    });
});
