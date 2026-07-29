import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    archiveSessionOnceInactive: vi.fn(),
    archiveSessionByIdBestEffort: vi.fn(),
    fetchSessionByIdCompat: vi.fn(),
    callMachineRpc: vi.fn(),
}));

vi.mock('@/session/services/archiveSessionOnceInactive', () => ({
    archiveSessionOnceInactive: (...args: unknown[]) => (
        mocks.archiveSessionOnceInactive(...args)
    ),
}));
vi.mock('@/session/services/setSessionArchivedState', () => ({
    archiveSessionByIdBestEffort: (...args: unknown[]) => (
        mocks.archiveSessionByIdBestEffort(...args)
    ),
}));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionByIdCompat: (...args: unknown[]) => (
        mocks.fetchSessionByIdCompat(...args)
    ),
}));
vi.mock('@/session/transport/rpc/machineRpc', () => ({
    callMachineRpc: (...args: unknown[]) => mocks.callMachineRpc(...args),
}));

import {
    archiveSessionBestEffort,
    cleanupForkChildBestEffort,
} from './forkChildSessionRecovery';

describe('fork child failure recovery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.archiveSessionOnceInactive.mockResolvedValue({ archivedAt: 123 });
        mocks.fetchSessionByIdCompat.mockResolvedValue({
            id: 'child',
            machineId: 'machine-child',
        });
        mocks.callMachineRpc.mockResolvedValue({ status: 'stopped' });
    });

    it('routes failed-child stop through the server-owned explicit stop lifecycle before archiving', async () => {
        const order: string[] = [];
        const stopSession = vi.fn(async () => {
            order.push('local-stop');
            return { status: 'stopped' as const };
        });
        mocks.callMachineRpc.mockImplementation(async () => {
            order.push('server-stop');
            return { status: 'stopped' as const };
        });
        mocks.archiveSessionOnceInactive.mockImplementation(async () => {
            order.push('archive');
            return { archivedAt: 123 };
        });

        await cleanupForkChildBestEffort({
            credentials: {
                token: 'token',
                encryption: {
                    type: 'legacy',
                    secret: new Uint8Array([1, 2, 3]),
                },
            },
            fallbackStopSession: stopSession,
            sessionId: 'child',
        });
        await archiveSessionBestEffort('token', 'child');

        expect(order).toEqual(['server-stop', 'archive']);
        expect(mocks.callMachineRpc).toHaveBeenCalledWith({
            credentials: {
                token: 'token',
                encryption: {
                    type: 'legacy',
                    secret: new Uint8Array([1, 2, 3]),
                },
            },
            machineId: 'machine-child',
            method: 'stop-session',
            request: { sessionId: 'child' },
            authorization: {
                kind: 'session.write',
                sessionId: 'child',
            },
        });
        expect(stopSession).not.toHaveBeenCalled();
        expect(mocks.archiveSessionOnceInactive).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'child',
        });
        expect(mocks.archiveSessionByIdBestEffort).not.toHaveBeenCalled();
    });

    it('does not swallow a terminal archive failure', async () => {
        mocks.archiveSessionOnceInactive.mockRejectedValue(
            Object.assign(new Error('still active'), { code: 'session_active' }),
        );

        await expect(archiveSessionBestEffort('token', 'child')).rejects.toMatchObject({
            code: 'session_active',
        });
    });

    it('still retires the local runner when the server-owned stop is unavailable', async () => {
        mocks.callMachineRpc.mockRejectedValue(new Error('server unavailable'));
        const fallbackStopSession = vi.fn(async () => ({ status: 'stopped' as const }));

        await cleanupForkChildBestEffort({
            credentials: {
                token: 'token',
                encryption: {
                    type: 'legacy',
                    secret: new Uint8Array([1, 2, 3]),
                },
            },
            fallbackStopSession,
            sessionId: 'child',
        });

        expect(fallbackStopSession).toHaveBeenCalledWith('child');
        expect(fallbackStopSession).toHaveBeenCalledOnce();
    });
});
