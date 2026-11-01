import { afterEach, describe, expect, it, vi } from 'vitest';

describe('detectSessionTurnActivity', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('uses complete projection without transcript scan', async () => {
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
                pendingCount: 0,
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

    it('treats projected pending requests as in flight', async () => {
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
                pendingCount: 0,
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
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 1,
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

    it('falls back to transcript scan when projection is null', async () => {
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

    it('treats completed plain and codex agent replies as settling pending user turns', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => [
            {
                id: 'msg-1',
                localId: null,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'first' } } },
            },
            {
                id: 'msg-2',
                localId: null,
                seq: 2,
                createdAt: 2,
                updatedAt: 2,
                content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'first reply' } } },
            },
            {
                id: 'msg-3',
                localId: null,
                seq: 3,
                createdAt: 3,
                updatedAt: 3,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'second' } } },
            },
            {
                id: 'msg-4',
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
                            data: { type: 'message', message: 'second reply' },
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

        await expect(detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
        })).resolves.toEqual({
            pendingUserTurns: 0,
            activeTaskInFlight: false,
            turnInFlight: false,
        });
    });
});
