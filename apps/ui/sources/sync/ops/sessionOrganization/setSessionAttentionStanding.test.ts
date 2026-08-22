import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';

const mocks = vi.hoisted(() => ({
    setSessionAttentionStanding: vi.fn(),
}));

vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>();
    return {
        ...actual,
        setSessionAttentionStanding: mocks.setSessionAttentionStanding,
    };
});

const credentials = { token: 'token-a', secret: 'secret-a' };
const SERVER_ID = 'server-standing-op';
const SESSION_ID = 'session-standing-op';
const SESSION_KEY = `${SERVER_ID}:${SESSION_ID}`;

describe('setSessionAttentionStanding op', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        mocks.setSessionAttentionStanding.mockReset();
        previousState = storage.getState();
    });

    afterEach(() => {
        storage.setState(previousState, true);
    });

    it('writes optimistically and then reconciles to the value the server stored', async () => {
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        mocks.setSessionAttentionStanding.mockResolvedValueOnce({
            standing: { sessionId: SESSION_ID, standing: true, updatedAt: 4242 },
        });

        await setSessionAttentionStanding({
            credentials,
            serverId: SERVER_ID,
            sessionId: SESSION_ID,
            standing: true,
        });

        expect(mocks.setSessionAttentionStanding).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: SESSION_ID,
            request: { standing: true },
        }));
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[SESSION_KEY])
            .toEqual({ sessionId: SESSION_ID, standing: true, updatedAt: 4242 });
        expect(Object.keys(storage.getState().sessionOrganizationOptimisticRecords)).toEqual([]);
    });

    it('rolls the optimistic write back when the server rejects it', async () => {
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        storage.getState().applySessionOrganizationSnapshot(SERVER_ID, {
            schemaVersion: 1,
            version: 1,
            pins: [],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
            attentionStandings: [{ sessionId: SESSION_ID, standing: true, updatedAt: 1 }],
        });
        mocks.setSessionAttentionStanding.mockRejectedValueOnce(new Error('offline'));

        await expect(setSessionAttentionStanding({
            credentials,
            serverId: SERVER_ID,
            sessionId: SESSION_ID,
            standing: false,
        })).rejects.toThrow('offline');

        // A failed "remove from Needs attention" must leave the session standing, not fall back to
        // the account default: the previous explicit value is what the user still has.
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[SESSION_KEY])
            .toEqual({ sessionId: SESSION_ID, standing: true, updatedAt: 1 });
        expect(Object.keys(storage.getState().sessionOrganizationOptimisticRecords)).toEqual([]);
    });
});
