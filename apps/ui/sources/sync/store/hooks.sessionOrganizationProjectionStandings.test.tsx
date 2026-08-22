import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { useSessionOrganizationProjection } from './hooks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER_ID = 'server-attention-standing-projection';
const SESSION_KEY = `${SERVER_ID}:session-1`;

/**
 * The organization projection is memoized behind a hand-written identity chain over the store
 * slices it reads. A slice missing from that chain is not slow — it is INVISIBLE: the cached
 * projection is returned forever, so a standing the user just wrote never reaches the list.
 */
describe('useSessionOrganizationProjection attention standings', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousState = storage.getState();
        storage.setState((state) => ({
            ...state,
            isDataReady: true,
            sessionOrganizationSchemaVersionByServerId: { [SERVER_ID]: 1 },
            sessionOrganizationSnapshotVersionByServerId: { [SERVER_ID]: 1 },
            sessionOrganizationAttentionStandingsBySessionKey: {},
        }));
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

    it('rebuilds the cached projection when only the standings slice changed', async () => {
        const hook = await renderHook(() => useSessionOrganizationProjection(SERVER_ID));
        expect(hook.getCurrent()?.attentionStandingsBySessionId).toEqual({});

        await act(async () => {
            storage.setState((state) => ({
                ...state,
                sessionOrganizationAttentionStandingsBySessionKey: {
                    [SESSION_KEY]: { sessionId: 'session-1', standing: true, updatedAt: 7 },
                },
            }));
        });

        expect(hook.getCurrent()?.attentionStandingsBySessionId).toEqual({
            'session-1': { sessionId: 'session-1', standing: true, updatedAt: 7 },
        });
    });

    it('carries an explicit removal through as a stored false rather than an absent key', async () => {
        storage.setState((state) => ({
            ...state,
            sessionOrganizationAttentionStandingsBySessionKey: {
                [SESSION_KEY]: { sessionId: 'session-1', standing: true, updatedAt: 7 },
            },
        }));
        const hook = await renderHook(() => useSessionOrganizationProjection(SERVER_ID));

        await act(async () => {
            storage.setState((state) => ({
                ...state,
                sessionOrganizationAttentionStandingsBySessionKey: {
                    [SESSION_KEY]: { sessionId: 'session-1', standing: false, updatedAt: 8 },
                },
            }));
        });

        expect(hook.getCurrent()?.attentionStandingsBySessionId).toEqual({
            'session-1': { sessionId: 'session-1', standing: false, updatedAt: 8 },
        });
    });
});
