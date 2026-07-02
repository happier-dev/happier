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

    it('uses completed projection as idle when no requests are pending', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => [
            {
                id: 'msg-stale-user',
                localId: null,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                content: { t: 'plain', v: { role: 'user' } },
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
});
