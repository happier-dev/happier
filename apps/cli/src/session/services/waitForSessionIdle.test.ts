import { afterEach, describe, expect, it, vi } from 'vitest';

describe('waitForSessionIdle', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

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
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    agentState: '{"requests":{"stale":{"createdAt":1}}}',
                    latestTurnStatus: 'in_progress',
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
                activeTaskInFlight: true,
                turnInFlight: true,
            },
            initialAgentStateSummary: { pendingRequestsCount: 0 },
            preferProjectionUpdates: true,
        }));
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('trusts a complete idle projection over transcript task lifecycle rows', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async (_params: { timeoutMs?: number }) => [
            {
                id: 'msg-background-task',
                localId: 'local-background-task',
                seq: 4,
                createdAt: 4,
                updatedAt: 4,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            agentId: 'claude',
                            data: { type: 'task_started', id: 'background-task-1' },
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
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById: vi.fn(async () => ({
                latestTurnStatus: 'completed',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
            })),
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    agentState: null,
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
            initialTurnActivityRequiresTranscriptIdleEvidence: false,
            preferProjectionUpdates: true,
        }));
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('falls back to socket confirmation when transcript evidence is unavailable for an incomplete projection', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => {
            throw new Error('transcript decrypt unavailable');
        });
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
                ctx: null,
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    agentState: null,
                    latestTurnStatus: null,
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
                pendingUserTurns: 1,
                activeTaskInFlight: false,
                turnInFlight: true,
            },
            initialTurnActivityRequiresTranscriptIdleEvidence: true,
            preferProjectionUpdates: false,
        }));
        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledOnce();
    });

    it('seeds socket idle wait from durable pending input before transcript materialization', async () => {
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
                ctx: null,
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    agentState: null,
                    latestTurnStatus: null,
                    pendingCount: 1,
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
                pendingUserTurns: 1,
                activeTaskInFlight: false,
                turnInFlight: true,
            },
            preferProjectionUpdates: true,
        }));
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
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
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 1_000,
                    runtimeActivityRevision: 2,
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

        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 0,
                activeTaskInFlight: false,
                turnInFlight: false,
            },
            initialTurnActivityRequiresTranscriptIdleEvidence: false,
            initialAgentStateSummary: { pendingRequestsCount: 0 },
            preferProjectionUpdates: true,
        }));
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
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    agentState: controlledAgentState,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { waitForSessionIdle } = await import('./waitForSessionIdle');
        const machineKey = new Uint8Array(32).fill(1);

        await waitForSessionIdle({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            timeoutMs: 1_000,
        });

        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialAgentStateSummary: { pendingRequestsCount: 0 },
            initialAgentStateCiphertextBase64: controlledAgentState,
        }));
    });
});
