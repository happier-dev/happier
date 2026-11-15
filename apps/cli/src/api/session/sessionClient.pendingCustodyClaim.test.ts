import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { afterEach, describe, expect, it, vi } from 'vitest';


import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
    type ApiSessionSocketStub,
    createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;


vi.mock('./sockets', () => ({
    createUserScopedSocket: () => {
        if (!userSocketStub) throw new Error('Missing user socket stub');
        return userSocketStub as any;
    },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
    createSessionSocketTransport: () => {
        if (!sessionSocketStub) throw new Error('Missing session socket stub');
        return {
            socket: sessionSocketStub as any,
            transport: {
                connect: async () => {},
                disconnect: async () => {},
                destroy: async () => {},
                isConnected: () => sessionSocketStub?.connected === true,
                onConnected: () => () => {},
                onDisconnected: () => () => {},
                onError: () => () => {},
            },
        };
    },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
    DEFAULT_MANAGED_CONNECTION_POLICY: {},
    createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
        start: async () => {
            params.createTransport();
            await params.onConnected?.();
        },
        stop: async () => {},
    }),
}));


afterEach(() => {
    vi.restoreAllMocks();
    sessionSocketStub = null;
    userSocketStub = null;
});

describe('ApiSessionClient Pending custody before a claim', () => {
    it('reads no delivery-status list before 3 claims while its held custody is settled, and keeps the archived outcome', async () => {
        vi.resetModules();
        sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        const axios = (await import('axios')).default as any;
        const pendingPath = '/v2/sessions/session-1/pending';
        // Home HTTP boundary: the Pending list reports this input discarded with an uncertain archive reason.
        const getSpy = vi.spyOn(axios, 'get').mockImplementation((async (url: string) => new URL(url).pathname === pendingPath
            ? { data: { pending: [{ localId: 'archived-local', status: 'discarded', deliveryStatus: { status: 'discarded', reason: 'dismissed_uncertain' } }] } }
            : { status: 404, data: {} }) as never);
        const pendingListReads = () => getSpy.mock.calls.filter(([url]) => new URL(String(url)).pathname === pendingPath).length;
        const { ApiSessionClient } = await import('./sessionClient');
        const client = createTestApiSessionClient(ApiSessionClient, 'fake-token', createPlainSessionFixture({ id: 'session-1' }));
        (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('archived-local');
        // An ordinary reconcile (e.g. a pending-changed push) reads the list and classifies the archived input.
        await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);
        expect(pendingListReads()).toBe(1);

        for (let turn = 0; turn < 3; turn += 1) {
            await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization({ beforeClaim: true })).resolves.toBe(true);
        }

        expect(pendingListReads()).toBe(1);
        expect(client.hasPendingProviderInput('archived-local')).toBe(true);
        await client.close();
    });

    it('skips the delivery-status list for a push at the version its held statuses are current at, and reads on a version gap', async () => {
        vi.resetModules();
        sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
        const axios = (await import('axios')).default as any;
        const pendingPath = '/v2/sessions/session-1/pending';
        // Home HTTP boundary: the held input is still queued (custody unsettled) at Pending version 7.
        const getSpy = vi.spyOn(axios, 'get').mockImplementation((async (url: string) => new URL(url).pathname === pendingPath
            ? { data: { pending: [{ localId: 'held-local', status: 'queued', deliveryStatus: { status: 'queued' } }], pendingVersion: 7 } }
            : { status: 404, data: {} }) as never);
        const pendingListReads = () => getSpy.mock.calls.filter(([url]) => new URL(String(url)).pathname === pendingPath).length;
        const { ApiSessionClient } = await import('./sessionClient');
        const client = createTestApiSessionClient(ApiSessionClient, 'fake-token', createPlainSessionFixture({ id: 'session-1' }));
        (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('held-local');

        await client.reconcilePendingProviderInputCustodyBeforeMaterialization({ pushedPendingVersion: 7 });
        expect(pendingListReads()).toBe(1);
        await client.reconcilePendingProviderInputCustodyBeforeMaterialization({ pushedPendingVersion: 7 });
        await client.reconcilePendingProviderInputCustodyBeforeMaterialization({ pushedPendingVersion: 6 });
        expect(pendingListReads()).toBe(1);
        await client.reconcilePendingProviderInputCustodyBeforeMaterialization({ pushedPendingVersion: 8 });
        expect(pendingListReads()).toBe(2);
        await client.close();
    });
});
