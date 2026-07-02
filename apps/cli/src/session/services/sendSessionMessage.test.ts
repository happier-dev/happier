import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sendSessionMessage', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('keeps wait-for-idle transcript bounded after materialized runtime RPC send', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [userMessageRow]);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: '{"requests":{"stale":{"createdAt":1}}}',
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async () => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted: vi.fn(async () => undefined),
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
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'in_progress',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 1_000,
            localId: 'continuation-local-id',
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            sessionId: 'sess-1',
            localId: 'continuation-local-id',
            waited: true,
        }));

        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                localId: 'continuation-local-id',
            }),
        }));
        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 1,
                activeTaskInFlight: false,
                turnInFlight: true,
            },
            preferProjectionUpdates: false,
        }));
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
    });

    it('invokes onCommittedViaSocket when the message is committed through the pending queue path', async () => {
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const onCommittedViaSocket = vi.fn(async () => undefined);

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async () => ({ ok: true })),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'sess-1',
                    active: false,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
            onCommittedViaSocket,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });

        expect(sendSessionMessageViaSocketCommitted).toHaveBeenCalledTimes(1);
        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
        });
        expect(onCommittedViaSocket).toHaveBeenCalledWith({
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
        });
    });

    it('invokes onCommittedViaSocket when runtime RPC falls back to socket-committed delivery', async () => {
        const sendSessionMessageViaSocketCommitted = vi.fn(async () => undefined);
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const onCommittedViaSocket = vi.fn(async () => undefined);

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async () => {
                throw new Error('Socket connect timeout');
            }),
        }));
        vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
            sendSessionMessageViaSocketCommitted,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            materializeNextPendingQueueV2MessageViaHttp,
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
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
            onCommittedViaSocket,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });

        expect(sendSessionMessageViaSocketCommitted).toHaveBeenCalledTimes(1);
        expect(materializeNextPendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
        });
        expect(onCommittedViaSocket).toHaveBeenCalledWith({
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
        });
    });
});
