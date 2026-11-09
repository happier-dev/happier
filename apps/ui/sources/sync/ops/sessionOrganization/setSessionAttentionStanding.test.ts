import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { SetSessionAttentionStandingResponseSchema } from '@happier-dev/protocol/sessions/organization/standings';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';

// HTTP is the boundary: response parsing, optimistic writes and reconciliation stay real.
const transport = vi.fn<RuntimeFetch>();
function response(value: unknown): Response {
    return new Response(JSON.stringify(SetSessionAttentionStandingResponseSchema.parse(value)), {
        headers: { 'Content-Type': 'application/json' },
    });
}
const serverUrl = 'https://standing-op.test';
const requestAtEndpoint = (path: string, init?: RequestInit) => transport(new URL(path, serverUrl).href, init);

const credentials = { token: 'token-a', secret: 'secret-a' };
const SERVER_ID = 'server-standing-op';
const SESSION_ID = 'session-standing-op';
const SESSION_KEY = buildSessionOrganizationSessionKey(SERVER_ID, SESSION_ID);

describe('setSessionAttentionStanding op', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        transport.mockReset();
        previousState = storage.getState();
    });

    afterEach(() => {
        storage.setState(previousState, true);
    });

    it('writes optimistically and then reconciles to the value the server stored', async () => {
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        transport.mockResolvedValueOnce(response({
            standing: { sessionId: SESSION_ID, standing: true, updatedAt: 4242 },
        }));

        await setSessionAttentionStanding({
            requestAtEndpoint,
            credentials,
            serverUrl,
            serverId: SERVER_ID,
            sessionId: SESSION_ID,
            standing: true,
        });

        expect(transport.mock.calls.map(([url, init]) => ({
            path: new URL(String(url)).pathname,
            method: init?.method,
            request: JSON.parse(String(init?.body)),
        }))).toEqual([{
            path: `/v2/session-organization/attention-standings/${SESSION_ID}`,
            method: 'PUT',
            request: { standing: true },
        }]);
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
        transport.mockRejectedValueOnce(new Error('offline'));

        await expect(setSessionAttentionStanding({
            requestAtEndpoint,
            credentials,
            serverUrl,
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

    it('keeps the newer reminder when an older response settles last', async () => {
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        const first = createDeferred<Response>();
        const second = createDeferred<Response>();
        transport
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);

        const older = setSessionAttentionStanding({ credentials, serverUrl, requestAtEndpoint, serverId: SERVER_ID, sessionId: SESSION_ID, remindAt: 2_000 });
        const newer = setSessionAttentionStanding({ credentials, serverUrl, requestAtEndpoint, serverId: SERVER_ID, sessionId: SESSION_ID, remindAt: 5_000 });

        second.resolve(response({ standing: { sessionId: SESSION_ID, standing: false, remindAt: 5_000, updatedAt: 9 } }));
        await newer;
        first.resolve(response({ standing: { sessionId: SESSION_ID, standing: false, remindAt: 2_000, updatedAt: 2 } }));
        await older;

        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[SESSION_KEY])
            .toMatchObject({ remindAt: 5_000 });
    });

    it('keeps another session\'s committed standing when a sibling mutation rolls back', async () => {
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        const otherSessionId = 'session-standing-op-other';
        const otherKey = buildSessionOrganizationSessionKey(SERVER_ID, otherSessionId);
        const failing = createDeferred<Response>();
        transport
            .mockReturnValueOnce(failing.promise)
            .mockResolvedValueOnce(response({ standing: { sessionId: otherSessionId, standing: true, updatedAt: 7 } }));

        const rejected = setSessionAttentionStanding({ credentials, serverUrl, requestAtEndpoint, serverId: SERVER_ID, sessionId: SESSION_ID, standing: true });
        await setSessionAttentionStanding({ credentials, serverUrl, requestAtEndpoint, serverId: SERVER_ID, sessionId: otherSessionId, standing: true });
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[otherKey])
            .toEqual({ sessionId: otherSessionId, standing: true, updatedAt: 7 });

        failing.reject(new Error('offline'));
        await expect(rejected).rejects.toThrow('offline');

        // The failed mutation undoes its own key only; the sibling Session's committed standing
        // is not part of what it wrote.
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[otherKey])
            .toEqual({ sessionId: otherSessionId, standing: true, updatedAt: 7 });
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[SESSION_KEY]).toBeUndefined();
    });

    it('keeps a newer confirmed reminder when the older mutation for the same Session fails', async () => {
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        const older = createDeferred<Response>();
        transport
            .mockReturnValueOnce(older.promise)
            .mockResolvedValueOnce(response({ standing: { sessionId: SESSION_ID, standing: false, remindAt: 5_000, updatedAt: 9 } }));

        const rejected = setSessionAttentionStanding({ credentials, serverUrl, requestAtEndpoint, serverId: SERVER_ID, sessionId: SESSION_ID, remindAt: 2_000 });
        await setSessionAttentionStanding({ credentials, serverUrl, requestAtEndpoint, serverId: SERVER_ID, sessionId: SESSION_ID, remindAt: 5_000 });
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[SESSION_KEY])
            .toMatchObject({ remindAt: 5_000 });

        older.reject(new Error('offline'));
        await expect(rejected).rejects.toThrow('offline');

        // The failed write no longer owns this key: the newer confirmed reminder does, so the
        // rollback must not revert to the value that was current before the failed write.
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[SESSION_KEY])
            .toMatchObject({ remindAt: 5_000 });
    });

    it('changes only the reminder field when scheduling and clearing', async () => {
        const { setSessionAttentionStanding } = await import('./setSessionAttentionStanding');
        transport
            .mockResolvedValueOnce(response({ standing: { sessionId: SESSION_ID, standing: true, remindAt: 2_000, updatedAt: 2 } }))
            .mockResolvedValueOnce(response({ standing: { sessionId: SESSION_ID, standing: true, updatedAt: 3 } }));

        await setSessionAttentionStanding({ credentials, serverUrl, requestAtEndpoint, serverId: SERVER_ID, sessionId: SESSION_ID, remindAt: 2_000 });
        await setSessionAttentionStanding({ credentials, serverUrl, requestAtEndpoint, serverId: SERVER_ID, sessionId: SESSION_ID, remindAt: null });

        expect(transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))))
            .toEqual([{ remindAt: 2_000 }, { remindAt: null }]);
        expect(storage.getState().sessionOrganizationAttentionStandingsBySessionKey[SESSION_KEY])
            .toEqual({ sessionId: SESSION_ID, standing: true, updatedAt: 3 });
    });
});
