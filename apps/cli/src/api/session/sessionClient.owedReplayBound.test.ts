import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocket: ApiSessionSocketStub | null = null;
let userSocket: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
    createUserScopedSocket: () => {
        if (!userSocket) throw new Error('missing user socket');
        return userSocket as any;
    },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
    createSessionSocketTransport: () => {
        if (!sessionSocket) throw new Error('missing session socket');
        return {
            socket: sessionSocket as any,
            transport: {
                connect: async () => {}, disconnect: async () => {}, destroy: async () => {},
                isConnected: () => sessionSocket?.connected === true,
                onConnected: () => () => {}, onDisconnected: () => () => {}, onError: () => () => {},
            },
        };
    },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
    DEFAULT_MANAGED_CONNECTION_POLICY: {},
    createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
        start: async () => { params.createTransport(); await params.onConnected?.(); },
        stop: async () => {},
        getState: () => ({ phase: 'online' }),
    }),
}));

const catchUp = vi.fn(async (_input: unknown) => {});
vi.mock('./sessionMessageCatchUp', () => ({ catchUpSessionMessagesAfterSeq: (input: unknown) => catchUp(input) }));

const blockDelivery = vi.fn(async (_input: unknown) => ({}));
const listDeliveryStatuses = vi.fn<() => Promise<Array<{ localId: string; status: string }>>>();
vi.mock('./pendingQueueV2Transport', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./pendingQueueV2Transport')>()),
    blockPendingQueueV2Delivery: (input: unknown) => blockDelivery(input),
    listPendingQueueV2DeliveryStatusesFromServer: () => listDeliveryStatuses(),
}));

async function createClient() {
    sessionSocket = createApiSessionSocketStub({ connected: true });
    userSocket = createApiSessionSocketStub({ connected: false });
    const { ApiSessionClient } = await import('./sessionClient');
    return new ApiSessionClient('token', createPlainSessionFixture({
        id: 's-owed-replay',
        metadata: { deliveredUserMessageSeqV1: 5, providerAcceptedUserMessageSeqV1: 5 } as any,
    }) as any);
}

describe('ApiSessionClient owed replay bound', () => {
    beforeEach(() => {
        catchUp.mockClear();
        blockDelivery.mockClear();
        listDeliveryStatuses.mockReset();
        listDeliveryStatuses.mockResolvedValue([{ localId: 'swallowed-row', status: 'delivering' }]);
    });

    afterEach(() => vi.restoreAllMocks());

    it('escalates on the fifth unchanged owed cursor instead of replaying a sixth time', async () => {
        const client = await createClient();
        (client as any).lastObservedUserMessageSeq = 10;

        for (let turnEnd = 0; turnEnd < 5; turnEnd += 1) {
            (client as any).lastOwedUserMessageCatchUpAt = 0;
            await (client as any).catchUpOwedUserMessagesAfterTurnEnd();
        }

        expect(catchUp).toHaveBeenCalledTimes(4);
        expect((client as any).readDeliveredUserMessageWatermarkState().effective).toBe(10);
        expect(blockDelivery).toHaveBeenCalledWith(expect.objectContaining({
            localId: 'swallowed-row',
            reason: 'provider_acceptance_timeout',
        }));
    });
});
