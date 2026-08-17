import { afterEach, describe, expect, it, vi } from 'vitest';

describe('waitForSessionIdle', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    function mockTransportContext(rawSession: Record<string, unknown>) {
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
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    ...rawSession,
                },
            })),
        }));
    }

    function credentials() {
        const machineKey = new Uint8Array(32).fill(1);
        return {
            token: 'token',
            encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
        };
    }

    it('seeds socket idle wait from a busy projection without transcript scan', async () => {
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
        mockTransportContext({
            latestTurnStatus: 'in_progress',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
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
                activeTaskInFlight: true,
                turnInFlight: true,
            },
            initialAgentStateSummary: { pendingRequestsCount: 0 },
            initialTurnActivityRequiresTranscriptIdleEvidence: false,
        }));
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('trusts a complete idle projection over transcript task lifecycle rows', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => [
            {
                id: 'm1',
                seq: 1,
                createdAt: 1,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            },
            {
                id: 'm2',
                seq: 2,
                createdAt: 2,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'task_started', id: 'task-1' },
                        },
                    },
                },
            },
        ]);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 123 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: 'completed',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            idle: true,
        }));

        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 0,
                activeTaskInFlight: false,
                turnInFlight: false,
            },
            initialTurnActivityRequiresTranscriptIdleEvidence: false,
        }));
    });

    it('keeps wait-idle scoped to foreground turn activity when runtime activity is active', async () => {
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
        mockTransportContext({
            latestTurnStatus: 'completed',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 1,
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            idle: true,
            observedAt: 123,
        });

        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 0,
                activeTaskInFlight: false,
                turnInFlight: false,
            },
            initialAgentStateSummary: { pendingRequestsCount: 0 },
            initialTurnActivityRequiresTranscriptIdleEvidence: false,
            preferProjectionUpdates: true,
        }));
    });

    it('treats transcript fetch failure for an incomplete projection as unable to prove idle', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => {
            throw new Error('transcript unavailable');
        });
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async (request: Readonly<{
            initialTurnActivity?: Readonly<{ turnInFlight?: boolean }>;
            initialTurnActivityRequiresTranscriptIdleEvidence?: boolean;
        }>) => {
            if (
                request.initialTurnActivity?.turnInFlight === false
                && request.initialTurnActivityRequiresTranscriptIdleEvidence !== true
            ) {
                return { idle: true as const, observedAt: 123 };
            }
            throw new Error('timeout');
        });

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: null,
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });

        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledOnce();
        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: expect.objectContaining({
                turnInFlight: true,
            }),
            initialTurnActivityRequiresTranscriptIdleEvidence: true,
        }));
    });

    it('spends transcript scan time from the caller wait budget before starting socket wait', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async (_params: Readonly<{ timeoutMs?: number }>) => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return [];
        });
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async (_params: Readonly<{ timeoutMs?: number }>) => ({
            idle: true as const,
            observedAt: 123,
        }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            latestTurnStatus: null,
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await expect(waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 100,
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            idle: true,
        }));

        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledWith(expect.objectContaining({
            timeoutMs: expect.any(Number),
        }));
        const transcriptCall = fetchEncryptedTranscriptPageLatest.mock.calls[0]?.[0];
        const transcriptTimeoutMs = transcriptCall?.timeoutMs;
        expect(transcriptTimeoutMs).toBeGreaterThan(0);
        expect(transcriptTimeoutMs).toBeLessThanOrEqual(100);
        const socketCall = waitForIdleViaSocket.mock.calls[0]?.[0];
        const socketTimeoutMs = socketCall?.timeoutMs;
        expect(socketTimeoutMs).toBeGreaterThan(0);
        expect(socketTimeoutMs).toBeLessThan(100);
    });

    it('forwards the snapshot AgentState alongside a projected pending-request count', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 123 }));
        const controlledAgentState = '{"controlledByUser":true,"requests":{}}';

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        mockTransportContext({
            agentState: controlledAgentState,
            latestTurnStatus: 'completed',
        });

        const { waitForSessionIdle } = await import('./waitForSessionIdle');

        await waitForSessionIdle({
            credentials: credentials(),
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        });

        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialAgentStateSummary: { pendingRequestsCount: 0 },
            initialAgentStateCiphertextBase64: controlledAgentState,
        }));
    });
});
