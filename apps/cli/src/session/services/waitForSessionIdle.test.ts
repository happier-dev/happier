import { afterEach, describe, expect, it, vi } from 'vitest';

describe('waitForSessionIdle', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('seeds socket idle wait from projection without transcript scan', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 123 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    agentState: '{"requests":{"stale":{"createdAt":1}}}',
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { waitForSessionIdle } = await import('./waitForSessionIdle');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(waitForSessionIdle({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            idle: true,
            observedAt: 123,
        });

        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 0,
                activeTaskInFlight: false,
                turnInFlight: false,
            },
            initialAgentStateSummary: { pendingRequestsCount: 0 },
            preferProjectionUpdates: true,
        }));
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });
});
