import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sendSessionMessage (visible-run task link)', () => {
    afterEach(() => {
        vi.doUnmock('@/api/session/pendingQueueV2Transport');
        vi.doUnmock('./resolveSessionTransportContext');
        vi.doUnmock('@/session/transport/rpc/sessionRpc');
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('carries the run link in the queued task message meta', async () => {
        const enqueue = vi.fn(async (_request: unknown) => undefined);
        vi.doMock('@/api/session/pendingQueueV2Transport', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/api/session/pendingQueueV2Transport')>(),
            enqueuePendingQueueV2MessageViaHttp: enqueue,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async (params: { request: { selector?: { localId?: string } } }) => ({
                ok: true, result: 'dispatch_issued', localId: params.request.selector?.localId,
            })),
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'child-1',
                mode: 'plain',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                rawSession: {
                    id: 'child-1',
                    active: true,
                    metadata: JSON.stringify({ permissionMode: 'read-only' }),
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));
        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);
        const link = { v: 1 as const, parentSessionId: 'lead', runId: 'run_1', turnEpoch: 0 };

        const result = await sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'child-1',
            message: 'Task prompt',
            wait: false,
            timeoutMs: 0,
            requestedAction: { v: 1, kind: 'enqueue' },
            executionRunLinkV1: link,
        });

        expect(result.ok).toBe(true);
        const serialized = JSON.stringify(enqueue.mock.calls);
        expect(serialized).toContain('"happierExecutionRunLinkV1":{"v":1,"parentSessionId":"lead","runId":"run_1","turnEpoch":0}');
    });
});
