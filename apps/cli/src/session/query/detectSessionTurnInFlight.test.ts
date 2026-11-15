import { afterEach, describe, expect, it, vi } from 'vitest';

describe('detectSessionTurnActivity', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });

    it.each([
        { name: 'in-progress turn', projection: { latestTurnStatus: 'in_progress', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 }, pending: 0, active: true, busy: true },
        { name: 'unmaterialized durable input', projection: { latestTurnStatus: null, pendingCount: 1 }, pending: 1, active: false, busy: true },
        { name: 'completed turn', projection: { latestTurnStatus: 'completed', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 }, pending: 0, active: false, busy: false },
        { name: 'pending permission request', projection: { latestTurnStatus: 'completed', pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 }, pending: 0, active: false, busy: true },
        { name: 'independent provider runtime activity', projection: { latestTurnStatus: 'completed', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, runtimeActivityState: 'active', runtimeActivityActiveCount: 1, runtimeActivityObservedAt: 1_000, runtimeActivityRevision: 2 }, pending: 0, active: false, busy: false },
    ])('reduces the live Session projection for $name', async ({ projection, pending, active, busy }) => {
        const { detectSessionTurnActivityFromProjection } = await import('./detectSessionTurnInFlight');
        expect(detectSessionTurnActivityFromProjection(projection)).toEqual({
            pendingUserTurns: pending, activeTaskInFlight: active, turnInFlight: busy,
        });
    });

    it('reports unavailable transcript evidence', async () => {
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => {
            throw new Error('transcript unavailable');
        });
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const axios = (await import('axios')).default;
        // Serve fixtures at HTTP; page validation and the activity reducer remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: {
            hasMore: false,
            activity: { pendingCount: 0, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, latestTurnStatus: null },
            messages: await (new URL(url).searchParams.has('afterSeq')
                ? fetchEncryptedTranscriptPageAfterSeq() : fetchEncryptedTranscriptPageLatest()),
        } }));

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
        })).rejects.toBeInstanceOf(SessionTurnActivityUnavailableError);
        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledOnce();
    });

    it('reduces transcript activity when no current turn is projected', async () => {
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
        const axios = (await import('axios')).default;
        // Serve fixtures at HTTP; page validation and the activity reducer remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: {
            hasMore: false,
            activity: { pendingCount: 0, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, latestTurnStatus: null },
            messages: await (new URL(url).searchParams.has('afterSeq')
                ? fetchEncryptedTranscriptPageAfterSeq() : fetchEncryptedTranscriptPageLatest()),
        } }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        const activity = await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
        });

        expect(activity).toMatchObject({
            pendingUserTurns: 0,
            activeTaskInFlight: true,
            turnInFlight: true,
        });
        expect(fetchEncryptedTranscriptPageLatest).toHaveBeenCalledOnce();
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
        const axios = (await import('axios')).default;
        // Serve fixtures at HTTP; page validation and the activity reducer remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: {
            hasMore: false,
            activity: { pendingCount: 0, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, latestTurnStatus: null },
            messages: await (new URL(url).searchParams.has('afterSeq')
                ? fetchEncryptedTranscriptPageAfterSeq() : fetchEncryptedTranscriptPageLatest()),
        } }));

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

        expect(activity).toMatchObject({
            pendingUserTurns: 1,
            activeTaskInFlight: false,
            turnInFlight: true,
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
        const axios = (await import('axios')).default;
        // Serve fixtures at HTTP; page validation and the activity reducer remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: {
            hasMore: false,
            activity: { pendingCount: 0, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, latestTurnStatus: null },
            messages: await (new URL(url).searchParams.has('afterSeq')
                ? fetchEncryptedTranscriptPageAfterSeq() : fetchEncryptedTranscriptPageLatest()),
        } }));

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

        expect(activity).toMatchObject({
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
        const axios = (await import('axios')).default;
        // Serve fixtures at HTTP; page validation and the activity reducer remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: {
            hasMore: false,
            activity: { pendingCount: 0, pendingBlockedCount: 0, pendingBlockedNoEffectCount: 0,
                pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, latestTurnStatus: null },
            messages: await (new URL(url).searchParams.has('afterSeq')
                ? fetchEncryptedTranscriptPageAfterSeq() : fetchEncryptedTranscriptPageLatest()),
        } }));

        const { detectSessionTurnActivity } = await import('./detectSessionTurnInFlight');

        const activity = await detectSessionTurnActivity({
            token: 'token',
            sessionId: 'sess-1',
            encryptionMode: 'plain',
            encryptionKey: new Uint8Array(32).fill(1),
            encryptionVariant: 'dataKey',
        });

        expect(activity).toMatchObject({
            pendingUserTurns: 0,
            activeTaskInFlight: false,
            turnInFlight: false,
        });
    });
    it('defers all-blocked projections to coherent custody evidence and keeps mixed input busy', async () => {
        const { detectSessionTurnActivityFromProjection } = await import('./detectSessionTurnInFlight');
        const base = { latestTurnStatus: 'completed', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 };
        expect(detectSessionTurnActivityFromProjection({
            ...base, pendingCount: 1, pendingBlockedCount: 1, pendingBlockedNoEffectCount: 1,
        })).toBeNull();
        expect(detectSessionTurnActivityFromProjection({
            ...base, pendingCount: 2, pendingBlockedCount: 1, pendingBlockedNoEffectCount: 1,
        })).toEqual({ pendingUserTurns: 2, activeTaskInFlight: false, turnInFlight: true });
        expect(detectSessionTurnActivityFromProjection({
            ...base, pendingCount: 1, pendingBlockedCount: 1, pendingBlockedNoEffectCount: 0,
        })).toBeNull();
    });

    it.each([
        {},
        { pendingBlockedCount: 1 },
        { pendingBlockedCount: 1, pendingBlockedNoEffectCount: -1 },
        { pendingBlockedCount: 1, pendingBlockedNoEffectCount: 0.5 },
        { pendingBlockedCount: 0, pendingBlockedNoEffectCount: 1 },
        { pendingBlockedCount: 2, pendingBlockedNoEffectCount: 1 },
    ])('keeps legacy or inconsistent pending facts conservative: %j', async (pendingFacts) => {
        const { readSessionProjectedPendingInputCount } = await import('./detectSessionTurnInFlight');
        expect(readSessionProjectedPendingInputCount({ pendingCount: 1, ...pendingFacts })).toBe(1);
    });

});
