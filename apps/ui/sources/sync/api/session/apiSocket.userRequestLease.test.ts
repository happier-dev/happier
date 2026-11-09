import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    getState: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ storage: storageMock });
});

type Deferred = Readonly<{ promise: Promise<unknown>; resolve(value: unknown): void }>;

function createDeferred(): Deferred {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((settle) => { resolve = settle; });
    return { promise, resolve };
}

/** The Socket.IO connection is the genuine boundary; every ack is held until the test settles it. */
function installPendingAckSocket(apiSocket: object) {
    const pending: Deferred[] = [];
    const emitWithAck = vi.fn(async () => {
        const reply = createDeferred();
        pending.push(reply);
        return await reply.promise;
    });
    Object.assign(apiSocket, {
        socket: { connected: true, emitWithAck, emit: vi.fn() },
        encryption: { getSessionEncryption: () => null },
    });
    return { pending };
}

describe('apiSocket requests and routine background teardown', () => {
    beforeEach(() => {
        storageMock.getState.mockReset();
        storageMock.getState.mockReturnValue({ sessions: { s1: { id: 's1', encryptionMode: 'plain' } } });
    });

    afterEach(async () => {
        const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
        userRequestLeaseOwner.crossHardBoundary(() => {});
    });

    it('tears down once pre-hide requests settle, however many background RPCs a hidden page issues', async () => {
        const { apiSocket } = await import('./apiSocket');
        const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
        const { pending } = installPendingAckSocket(apiSocket);
        let backgroundSettled = 0;
        let backgroundSettledAtTeardown: number | null = null;
        const teardown = vi.fn(() => { backgroundSettledAtTeardown = backgroundSettled; });

        const userSend = apiSocket.emitWithAck('message', { sid: 's1' });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        expect(userRequestLeaseOwner.deferRoutineTeardown(teardown)).toBe(true);

        const issueBackgroundRead = () => {
            const call = apiSocket.sessionRPC('s1', 'scm.status.snapshot', {}).then(() => { backgroundSettled += 1; });
            return call;
        };
        let inFlight = issueBackgroundRead();
        await vi.waitFor(() => expect(pending).toHaveLength(2));

        pending[0]!.resolve({ ok: true });
        await userSend;

        // A streaming page keeps one background read overlapping the next.
        for (let index = 1; index < 20; index += 1) {
            const next = issueBackgroundRead();
            await vi.waitFor(() => expect(pending).toHaveLength(index + 2));
            pending[index]!.resolve({ ok: true, result: { ok: true } });
            await inFlight;
            inFlight = next;
        }
        pending[20]!.resolve({ ok: true, result: { ok: true } });
        await inFlight;

        expect(backgroundSettled).toBe(20);
        // Teardown runs as the pre-hide send settles, before any background read does.
        expect(backgroundSettledAtTeardown).toBe(0);
        expect(teardown).toHaveBeenCalledOnce();
    });

    it('still defers routine teardown until a user request in flight at hide settles', async () => {
        const { apiSocket } = await import('./apiSocket');
        const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
        const { pending } = installPendingAckSocket(apiSocket);
        const teardown = vi.fn();

        const userApproval = apiSocket.sessionRPC('s1', 'permission', { approved: true });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        expect(userRequestLeaseOwner.deferRoutineTeardown(teardown)).toBe(true);
        await Promise.resolve();
        expect(teardown).not.toHaveBeenCalled();

        pending[0]!.resolve({ ok: true, result: { ok: true } });
        await userApproval;
        expect(teardown).toHaveBeenCalledOnce();
    });
});
