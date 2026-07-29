import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    nudgeAlreadyRunningExistingSessionPendingQueue,
    probeAlreadyRunningExistingSessionServiceability,
    startPendingQueueBackgroundNudgeLoop,
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

const credentials = {
    token: 'token-daemon',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
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

    afterEach(() => {
        vi.useRealTimers();
    });

    it('discovers once and invokes only the fixed V1 wake method', async () => {
        vi.mocked(callSessionRpc)
            .mockResolvedValueOnce({ ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' })
            .mockResolvedValueOnce({ ok: true, result: 'wake_published' });

        await expect(nudgeAlreadyRunningExistingSessionPendingQueue({
            sessionId: 'sess-live',
            credentials,
        })).resolves.toEqual({ type: 'wake_published' });

        expect(callSessionRpc).toHaveBeenNthCalledWith(1, {
            token: 'token-daemon',
            sessionId: 'sess-live',
            mode: 'plain',
            method: `sess-live:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
            request: {},
            ctx: {
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
            },
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
            sessionId: 'sess-live', credentials,
        })).resolves.toEqual({ state: 'servable' });
        expect(callSessionRpc).toHaveBeenCalledTimes(1);
        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: `sess-live:${SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1}`,
        }));
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

    it('does not retry the background wake', async () => {
        vi.mocked(callSessionRpc).mockRejectedValueOnce(new Error('unavailable'));
        const loop = startPendingQueueBackgroundNudgeLoop({
            sessionId: 'sess-live',
            credentials,
            logLabel: 'test',
            maxAttempts: 2,
            retryDelayMs: 1_000,
        });

        await loop.done;
        expect(callSessionRpc).toHaveBeenCalledTimes(1);
    });
});
