import { beforeEach, describe, expect, it, vi } from 'vitest';

import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { StoredCredentials } from '@/persistence';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    nudgeAlreadyRunningExistingSessionPendingQueue,
    probeAlreadyRunningExistingSessionServiceability,
} from './pendingQueueNudge';

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
    callSessionRpc: vi.fn(async () => ({ type: 'no_pending' })),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionByIdCompat: vi.fn(async () => ({
        id: 'sess-live',
        encryptionMode: 'plain',
        metadata: '{}',
        metadataVersion: 1,
    })),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

const credentials: StoredCredentials = {
    token: 'token-daemon',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
};
const tokenOnlyCredentials: StoredCredentials = {
    token: 'token-daemon',
    encryption: null,
};

function createRawSession(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
    return {
        id: 'sess-live',
        active: true,
        path: '/repo',
        machineId: 'machine-local',
        metadata: '{}',
        metadataVersion: 1,
        encryptionMode: 'plain',
        ...overrides,
    } as RawSessionRecord;
}

describe('pendingQueueNudge', () => {
    beforeEach(() => {
        vi.mocked(fetchSessionByIdCompat).mockReset();
        vi.mocked(fetchSessionByIdCompat).mockImplementation(async () => createRawSession());
        vi.mocked(callSessionRpc).mockReset();
        vi.mocked(callSessionRpc).mockImplementation(async () => ({ type: 'no_pending' }));
    });

    it('uses a token-only credential to nudge a plain Session without Account encryption material', async () => {
        vi.mocked(callSessionRpc)
            .mockResolvedValueOnce({ ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' })
            .mockResolvedValueOnce({ ok: true, result: 'wake_published' });

        await expect(nudgeAlreadyRunningExistingSessionPendingQueue({
            sessionId: 'sess-live',
            credentials: tokenOnlyCredentials,
        })).resolves.toEqual({ type: 'wake_published' });

        expect(callSessionRpc).toHaveBeenNthCalledWith(1, {
            token: 'token-daemon',
            sessionId: 'sess-live',
            mode: 'plain',
            method: `sess-live:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
            request: {},
            ctx: null,
        });
        expect(callSessionRpc).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: `sess-live:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1}`,
            request: { protocolVersion: 1 },
        }));
    });

    it('probes serviceability without publishing a wake', async () => {
        vi.mocked(callSessionRpc).mockResolvedValueOnce({
            ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1',
        });

        await expect(probeAlreadyRunningExistingSessionServiceability({
            sessionId: 'sess-live', credentials: tokenOnlyCredentials,
        })).resolves.toEqual({ state: 'servable' });
        expect(callSessionRpc).toHaveBeenCalledTimes(1);
        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: `sess-live:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
        }));
    });

    it('returns typed unavailable for a retained E2EE Session when the credential has no material', async () => {
        vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(createRawSession({
            encryptionMode: 'e2ee',
            metadata: 'retained-ciphertext',
            dataEncryptionKey: 'retained-data-key-envelope',
        }));

        await expect(nudgeAlreadyRunningExistingSessionPendingQueue({
            sessionId: 'sess-live',
            credentials: tokenOnlyCredentials,
        })).resolves.toEqual({
            type: 'unavailable',
            reason: 'encryption_material_unavailable',
        });
        expect(callSessionRpc).not.toHaveBeenCalled();
    });

    it('fails old runners closed without invoking the legacy materializer', async () => {
        vi.mocked(callSessionRpc).mockRejectedValueOnce({
            rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
            message: 'RPC method not available: sess-live:session.pendingQueue.wake.capability.get.v1',
        });

        await expect(nudgeAlreadyRunningExistingSessionPendingQueue({
            sessionId: 'sess-live',
            credentials,
        })).resolves.toEqual({
            type: 'unavailable',
            reason: 'rpc_method_unavailable',
            error: expect.objectContaining({
                rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
            }),
        });
        expect(callSessionRpc).toHaveBeenCalledTimes(1);
        expect(callSessionRpc).not.toHaveBeenCalledWith(expect.objectContaining({ method: expect.stringContaining('materializeNext') }));
    });
});
