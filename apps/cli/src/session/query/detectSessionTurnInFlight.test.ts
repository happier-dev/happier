import { afterEach, describe, expect, it, vi } from 'vitest';

describe('detectSessionTurnActivity', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('uses in-progress projection without transcript scan', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        const activity = await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            sessionProjection: {
                latestTurnStatus: 'in_progress',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
            },
        });

        expect(activity).toEqual({
            pendingUserTurns: 0,
            activeTaskInFlight: true,
            turnInFlight: true,
        });
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('treats a durable pending input as in flight before it is materialized into the transcript', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        await expect(detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            sessionProjection: {
                latestTurnStatus: null,
                pendingCount: 1,
            },
        })).resolves.toEqual({
            pendingUserTurns: 1,
            activeTaskInFlight: false,
            turnInFlight: true,
        });
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('trusts a complete idle projection over transcript task lifecycle rows', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => [
            {
                id: 'msg-background-task',
                localId: null,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
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
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnInFlight } = await import('./detectSessionTurnInFlight');

        await expect(detectSessionTurnInFlight({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            sessionProjection: {
                latestTurnStatus: 'completed',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
            },
        })).resolves.toBe(false);
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
    });

    it('does not treat an incomplete projection as idle when transcript evidence is unavailable', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => {
            throw new Error('transcript unavailable');
        });
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const {
            detectSessionTurnActivity,
            SessionTurnActivityUnavailableError,
        } = await import('./detectSessionTurnInFlight');

        await expect(detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            sessionProjection: {
                latestTurnStatus: null,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
            },
        })).rejects.toBeInstanceOf(SessionTurnActivityUnavailableError);
        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledOnce();
    });

    it('treats projected pending request counts as in flight', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnInFlight } = await import('./detectSessionTurnInFlight');

        await expect(detectSessionTurnInFlight({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            sessionProjection: {
                latestTurnStatus: 'completed',
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
            },
        })).resolves.toBe(true);
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('ignores provider runtime activity projection for foreground-idle detection', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnActivity, detectSessionTurnInFlight } = await import('./detectSessionTurnInFlight');
        const sessionProjection = {
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 2,
        };

        await expect(detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            sessionProjection,
        })).resolves.toEqual({
            pendingUserTurns: 0,
            activeTaskInFlight: false,
            turnInFlight: false,
        });
        await expect(detectSessionTurnInFlight({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            sessionProjection,
        })).resolves.toBe(false);
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('falls back to transcript scan when projection is incomplete', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => [
            {
                id: 'msg-1',
                localId: null,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                content: { t: 'plain', v: { role: 'user' } },
            },
            {
                id: 'msg-2',
                localId: null,
                seq: 2,
                createdAt: 2,
                updatedAt: 2,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            data: { type: 'task_started' },
                        },
                    },
                },
            },
        ]);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        const activity = await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            sessionProjection: {
                latestTurnStatus: null,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
            },
        });

        expect(activity).toEqual({
            pendingUserTurns: 0,
            activeTaskInFlight: true,
            turnInFlight: true,
        });
        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledOnce();
    });

    it('forwards transcript fetch timeout budgets to transcript scans', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            transcriptFetchTimeoutMs: 345,
        });

        await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            afterSeqExclusive: 9,
            transcriptFetchTimeoutMs: 456,
        });

        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
            limit: 20,
            timeoutMs: 345,
        });
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
            afterSeq: 9,
            limit: 20,
            timeoutMs: 456,
        });
    });

    it('can ignore bare ready events while a user turn has not started', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [
            {
                id: 'msg-1',
                localId: 'local-user-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'current prompt' },
                    },
                },
            },
            {
                id: 'msg-2',
                localId: null,
                seq: 2,
                createdAt: 2,
                updatedAt: 2,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            id: 'ready-before-turn-start',
                            type: 'event',
                            data: { type: 'ready' },
                        },
                    },
                },
            },
        ]);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        const activity = await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            afterSeqExclusive: 0,
            readyCompletesPendingUserTurns: false,
        });

        expect(activity).toEqual({
            pendingUserTurns: 1,
            activeTaskInFlight: false,
            turnInFlight: true,
        });
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
            afterSeq: 0,
            limit: 20,
        });
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
    });

    it('allows a ready event to finish a user turn after agent output was observed', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [
            {
                id: 'msg-1',
                localId: 'local-user-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'current prompt' },
                    },
                },
            },
            {
                id: 'msg-2',
                localId: null,
                seq: 2,
                createdAt: 2,
                updatedAt: 2,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: { type: 'text', text: 'current answer' },
                    },
                },
            },
            {
                id: 'msg-3',
                localId: null,
                seq: 3,
                createdAt: 3,
                updatedAt: 3,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            id: 'ready-after-agent-output',
                            type: 'event',
                            data: { type: 'ready' },
                        },
                    },
                },
            },
        ]);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        const activity = await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
            afterSeqExclusive: 0,
            readyCompletesPendingUserTurns: false,
        });

        expect(activity).toEqual({
            pendingUserTurns: 0,
            activeTaskInFlight: false,
            turnInFlight: false,
        });
    });

    it('completed plain and codex agent replies settle pending user turns', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => [
            {
                id: 'msg-user-plain',
                localId: 'local-user-plain',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'plain prompt' },
                    },
                },
            },
            {
                id: 'msg-agent-plain',
                localId: null,
                seq: 2,
                createdAt: 2,
                updatedAt: 2,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: { type: 'text', text: 'plain answer' },
                    },
                },
            },
            {
                id: 'msg-user-codex',
                localId: 'local-user-codex',
                seq: 3,
                createdAt: 3,
                updatedAt: 3,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'codex prompt' },
                    },
                },
            },
            {
                id: 'msg-agent-codex',
                localId: null,
                seq: 4,
                createdAt: 4,
                updatedAt: 4,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: { type: 'message', message: 'codex answer' },
                        },
                    },
                },
            },
        ]);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageLatest,
            fetchEncryptedTranscriptPageAfterSeq,
        }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        const activity = await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
        });

        expect(activity).toEqual({
            pendingUserTurns: 0,
            activeTaskInFlight: false,
            turnInFlight: false,
        });
    });
});
