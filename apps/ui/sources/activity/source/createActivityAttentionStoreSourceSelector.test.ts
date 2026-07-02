import { describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { createActivityAttentionStoreSourceSelector } from './createActivityAttentionStoreSourceSelector';

function expectNoObjectKeysOrValuesOnRecords(action: () => void, guardedRecords: readonly object[]): void {
    const originalObjectKeys = Object.keys.bind(Object);
    const originalObjectValues = Object.values.bind(Object);
    const keysSpy = vi.spyOn(Object, 'keys').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.keys');
        }
        return originalObjectKeys(value);
    }) as typeof Object.keys);
    const valuesSpy = vi.spyOn(Object, 'values').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.values');
        }
        return originalObjectValues(value);
    }) as typeof Object.values);

    try {
        expect(action).not.toThrow();
    } finally {
        keysSpy.mockRestore();
        valuesSpy.mockRestore();
    }
}

describe('createActivityAttentionStoreSourceSelector', () => {
    it('does not collapse distinct pending request fields that contain signature separators', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const baseSession = createSessionFixture({
            id: 'separator-session',
            pendingPermissionRequestCount: 1,
            agentState: {
                requests: {
                    'request:a': {
                        tool: 'b',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 950,
                    },
                },
            },
        });

        const first = selector({
            ...baseState,
            sessions: {
                [baseSession.id]: baseSession,
            },
        });
        const nextSession = {
            ...baseSession,
            agentState: {
                requests: {
                    request: {
                        tool: 'a:b',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 950,
                    },
                },
            },
        };
        const second = selector({
            ...baseState,
            sessions: {
                [nextSession.id]: nextSession,
            },
        });

        expect(second).not.toBe(first);
        expect(Object.keys(second.sessionsById[nextSession.id]?.agentState?.requests ?? {})).toEqual(['request']);
    });

    it('builds the source signature without Object.keys or Object.values over hot state records', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const session = createSessionFixture({
            id: 'hot-session',
            pendingPermissionRequestCount: 1,
        });
        const state = {
            ...baseState,
            sessions: {
                [session.id]: session,
            },
            sessionListRenderables: {},
        };
        let source: ReturnType<ReturnType<typeof createActivityAttentionStoreSourceSelector>> | undefined;

        expectNoObjectKeysOrValuesOnRecords(() => {
            source = selector(state);
        }, [state.sessions, state.sessionListRenderables]);

        expect(source?.sessionsById[session.id]).toBe(session);
    });
});
