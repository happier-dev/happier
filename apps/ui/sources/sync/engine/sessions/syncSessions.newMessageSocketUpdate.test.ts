import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { socketApplyFrame } from '@/sync/engine/sessions/socketApplyFrame';
import type { DecryptedMessage, Session } from '@/sync/domains/state/storageTypes';
import { handleNewMessageSocketUpdate } from './sessionSocketUpdate';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { createSessionMessageApplyCoalescer } from './sessionMessageApplyCoalescer';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { flushRealtimeFanoutTelemetry, resetRealtimeFanoutTelemetry } from '@/sync/runtime/performance/realtimeFanoutTelemetry';

function buildUpdate(params: {
    sid?: string;
    messageId: string;
    messageSeq: number;
    attentionImpact?: { affectsUnread: boolean; affectsMeaningfulActivity: boolean };
    sourceCreatedAt?: number;
    sourceUpdatedAt?: number;
    transcriptObservationProvenance?: {
        kind: 'non_dependent';
        source: 'background' | 'external' | 'sidechain' | 'history';
    };
    content?: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
}): {
    id: string;
    seq: number;
    createdAt: number;
    body: {
        t: 'new-message';
        sid?: string;
        message: {
            id: string;
            seq: number;
            attentionImpact?: { affectsUnread: boolean; affectsMeaningfulActivity: boolean };
            sourceCreatedAt?: number;
            sourceUpdatedAt?: number;
            transcriptObservationProvenance?: NonNullable<Parameters<typeof buildUpdate>[0]['transcriptObservationProvenance']>;
            content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
            localId: null;
            createdAt: number;
            updatedAt: number;
        };
    };
} {
    return {
        id: 'u1',
        seq: 100,
        createdAt: 1_000,
        body: {
            t: 'new-message',
            sid: params.sid ?? 's1',
            message: {
                id: params.messageId,
                seq: params.messageSeq,
                ...(params.attentionImpact ? { attentionImpact: params.attentionImpact } : {}),
                ...(params.sourceCreatedAt !== undefined ? { sourceCreatedAt: params.sourceCreatedAt } : {}),
                ...(params.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: params.sourceUpdatedAt } : {}),
                ...(params.transcriptObservationProvenance !== undefined
                    ? { transcriptObservationProvenance: params.transcriptObservationProvenance }
                    : {}),
                content: params.content ?? { t: 'encrypted', c: 'x' },
                localId: null,
                createdAt: 1_000,
                updatedAt: 1_000,
            },
        },
    };
}

function buildSession(sessionId: string, seq = 1): Session {
    return {
        id: sessionId,
        seq,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function buildHarness(overrides: Partial<Parameters<typeof handleNewMessageSocketUpdate>[0]> = {}): {
    params: Parameters<typeof handleNewMessageSocketUpdate>[0];
    applyMessages: ReturnType<typeof vi.fn>;
    applySessions: ReturnType<typeof vi.fn>;
    fetchSessions: ReturnType<typeof vi.fn>;
    onMessageGapDetected: ReturnType<typeof vi.fn>;
    markSessionMaterializedMaxSeq: ReturnType<typeof vi.fn>;
} {
    const applyMessages = vi.fn();
    const applySessions = vi.fn();
    const fetchSessions = vi.fn();
    const onMessageGapDetected = vi.fn();
    const markSessionMaterializedMaxSeq = vi.fn();
    const params: Parameters<typeof handleNewMessageSocketUpdate>[0] = {
        updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
        getSessionEncryption: () => ({
            decryptMessage: async () => ({
                id: 'm2',
                localId: null,
                createdAt: 1_000,
                content: { role: 'user', content: { type: 'text', text: 'hi' } },
            }),
        }),
        getSession: () => buildSession('s1'),
        applySessions,
        fetchSessions,
        applyMessages,
        isMutableToolCall: () => false,
        invalidateScmStatus: () => {},
        isSessionMessagesLoaded: () => true,
        getSessionMaterializedMaxSeq: () => 1,
        markSessionMaterializedMaxSeq,
        onMessageGapDetected,
        ...overrides,
    };
    return { params, applyMessages, applySessions, fetchSessions, onMessageGapDetected, markSessionMaterializedMaxSeq };
}

describe('handleNewMessageSocketUpdate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        socketApplyFrame.flushNow();
        vi.useRealTimers();
        resetRealtimeFanoutTelemetry();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('preserves update message seq on normalized messages', async () => {
        const { params, applyMessages } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            }),
            isSessionActivelyViewed: () => false,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        const normalized = applyMessages.mock.calls?.[0]?.[1]?.[0] as NormalizedMessage | undefined;
        expect(normalized?.seq).toBe(2);
    });

    it('preserves authenticated transcript-observation metadata on normalized socket messages', async () => {
        const { params, applyMessages } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                sourceCreatedAt: 100,
                sourceUpdatedAt: 200,
                transcriptObservationProvenance: {
                    kind: 'non_dependent',
                    source: 'history',
                },
            }),
        });

        await handleNewMessageSocketUpdate(params);

        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            id: 'm2',
            seq: 2,
            sourceCreatedAt: 100,
            sourceUpdatedAt: 200,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
    });

    it('does not trigger catch-up when message seq is contiguous', async () => {
        const { params, fetchSessions, applyMessages, onMessageGapDetected, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('drops replayed new-message updates that are already materialized before decrypting', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'hi' } },
        }));
        const { params, fetchSessions, applyMessages, applySessions, onMessageGapDetected, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            }),
            getSessionEncryption: () => ({ decryptMessage }),
            getSessionMaterializedMaxSeq: () => 2,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('applies only an advancing projection for replayed hidden new-message updates', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'hidden' } },
        }));
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();
        const { params, applyMessages, applySessions, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            }),
            getSession: () => ({
                ...buildSession('s1'),
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            }),
            getSessionEncryption: () => ({ decryptMessage }),
            getSessionMaterializedMaxSeq: () => 2,
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
        });

        await handleNewMessageSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(markSessionKnownRemoteSeq).not.toHaveBeenCalled();
        expect(markSessionTranscriptDeferred).not.toHaveBeenCalled();
        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 's1',
                seq: 2,
                updatedAt: 1_000,
                meaningfulActivityAt: 1_000,
            }),
        ]);
    });

    it('routes hidden complete-projection new messages without decrypting or materializing transcript content', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'hidden' } },
        }));
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();
        const { params, applyMessages, applySessions, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            }),
            getSession: () => ({
                ...buildSession('s1'),
                lastViewedSessionSeq: 1,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            }),
            getSessionEncryption: () => ({ decryptMessage }),
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
        });

        await handleNewMessageSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(markSessionKnownRemoteSeq).toHaveBeenCalledWith('s1', 2);
        expect(markSessionTranscriptDeferred).toHaveBeenCalledWith('s1', expect.objectContaining({
            updateType: 'new-message',
            seq: 2,
        }));
        expect(applySessions.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's1',
            updatedAt: 1_000,
            meaningfulActivityAt: 1_000,
            lastViewedSessionSeq: 1,
        }));
    });

    it('routes hidden cache-only complete-projection new messages without forcing a sessions refresh', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'hidden' } },
        }));
        const applyCacheOnlySessionProjectionPatch = vi.fn(() => true);
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();
        const { params, applyMessages, fetchSessions, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            }),
            getSession: () => undefined,
            getSessionProjection: () => ({
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            }),
            applyCacheOnlySessionProjectionPatch,
            getSessionEncryption: () => ({ decryptMessage }),
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
        } as Partial<Parameters<typeof handleNewMessageSocketUpdate>[0]>);

        await handleNewMessageSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(applyCacheOnlySessionProjectionPatch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            messageSeq: 2,
            updateType: 'new-message',
        }));
        expect(markSessionKnownRemoteSeq).toHaveBeenCalledWith('s1', 2);
        expect(markSessionTranscriptDeferred).toHaveBeenCalledWith('s1', expect.objectContaining({
            updateType: 'new-message',
            seq: 2,
        }));
    });

    it('routes hidden partial-projection sessions without decrypting or materializing transcript content', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'legacy' } },
        }));
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();
        const { params, applyMessages, applySessions, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
            }),
            getSession: () => buildSession('s1'),
            getSessionEncryption: () => ({ decryptMessage }),
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
        });

        await handleNewMessageSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(applySessions.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's1',
            seq: 2,
            updatedAt: 1_000,
            meaningfulActivityAt: 1_000,
        }));
        expect(markSessionKnownRemoteSeq).toHaveBeenCalledWith('s1', 2);
        expect(markSessionTranscriptDeferred).toHaveBeenCalledWith('s1', expect.objectContaining({
            updateType: 'new-message',
            seq: 2,
        }));
    });

    it('applies plaintext realtime messages when the session is plain and session encryption is unavailable', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const getSessionEncryption = vi.fn(() => null);
            const { params, fetchSessions, applyMessages, applySessions, markSessionMaterializedMaxSeq } = buildHarness({
                updateData: buildUpdate({
                    sid: 's1',
                    messageId: 'm2',
                    messageSeq: 2,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'hello from plain realtime' } },
                    },
                }),
                getSessionEncryption,
                getSession: () => ({ ...buildSession('s1'), encryptionMode: 'plain' } as Session),
            });

            await handleNewMessageSocketUpdate(params);

            expect(fetchSessions).not.toHaveBeenCalled();
            expect(consoleError).not.toHaveBeenCalled();
            expect(applyMessages).toHaveBeenCalledTimes(1);
            expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
            expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
                id: 'm2',
                seq: 2,
                role: 'user',
            });
            expect(applySessions).toHaveBeenCalledTimes(1);
            expect(getSessionEncryption).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('triggers catch-up when a gap is detected for a loaded transcript', async () => {
        const { params, fetchSessions, applyMessages, onMessageGapDetected, markSessionMaterializedMaxSeq } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 5);
        expect(onMessageGapDetected).toHaveBeenCalledWith('s1', { prevMaterializedMaxSeq: 1, messageSeq: 5 });
    });

    it('does not trigger catch-up when transcript is not loaded (even if a gap exists)', async () => {
        const { params, onMessageGapDetected } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 1,
            isSessionMessagesLoaded: () => false,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('triggers catch-up from zero when an already-loaded empty transcript receives a later row', async () => {
        const { params, onMessageGapDetected } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm5', messageSeq: 5 }),
            getSessionMaterializedMaxSeq: () => 0,
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onMessageGapDetected).toHaveBeenCalledWith('s1', { prevMaterializedMaxSeq: 0, messageSeq: 5 });
    });

    it('falls back to invalidate messages when decryption fails for a loaded transcript', async () => {
        const { params, fetchSessions, onMessageGapDetected } = buildHarness({
            getSessionEncryption: () => ({
                decryptMessage: async () => null,
            }),
            isSessionMessagesLoaded: () => true,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onMessageGapDetected).toHaveBeenCalledWith('s1', { prevMaterializedMaxSeq: 1, messageSeq: 2 });
        expect(fetchSessions).not.toHaveBeenCalled();
    });

    it('fetches sessions when decryption fails and transcript is not loaded', async () => {
        const { params, fetchSessions, onMessageGapDetected } = buildHarness({
            getSessionEncryption: () => ({
                decryptMessage: async () => null,
            }),
            isSessionMessagesLoaded: () => false,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('applies decrypted messages when projection routing is disabled and the session is not yet hydrated', async () => {
        const { params, applyMessages, fetchSessions, markSessionMaterializedMaxSeq, applySessions } = buildHarness({
            getSession: () => undefined,
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[0]).toBe('s1');
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith('s1', 2);
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('routes hidden unhydrated sessions without decrypting when projection routing is enabled', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'm2',
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'hidden unknown' } },
        }));
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();
        const { params, applyMessages, fetchSessions, markSessionMaterializedMaxSeq, applySessions } = buildHarness({
            getSession: () => undefined,
            getSessionProjection: () => undefined,
            getSessionEncryption: () => ({ decryptMessage }),
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            markSessionKnownRemoteSeq,
            markSessionTranscriptDeferred,
        });

        await handleNewMessageSocketUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(fetchSessions).toHaveBeenCalledTimes(1);
        expect(applyMessages).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(markSessionKnownRemoteSeq).toHaveBeenCalledWith('s1', 2);
        expect(markSessionTranscriptDeferred).toHaveBeenCalledWith('s1', expect.objectContaining({
            updateType: 'new-message',
            seq: 2,
        }));
    });

    it('drops in-flight message work when a known session is deleted before decrypt resolves', async () => {
        let session: Session | undefined = buildSession('s1');
        let resolveDecrypt!: (message: DecryptedMessage) => void;
        const decryptedMessage = new Promise<DecryptedMessage>((resolve) => {
            resolveDecrypt = resolve;
        });
        const decryptStarted = vi.fn();
        const enqueueMessages = vi.fn();
        const onNormalizedMessagesApplied = vi.fn();
        const { params, applyMessages, applySessions, fetchSessions, markSessionMaterializedMaxSeq, onMessageGapDetected } = buildHarness({
            getSession: () => session,
            getSessionEncryption: () => ({
                decryptMessage: async () => {
                    decryptStarted();
                    return await decryptedMessage;
                },
            }),
            enqueueMessages,
            onNormalizedMessagesApplied,
        } as Partial<Parameters<typeof handleNewMessageSocketUpdate>[0]>);

        const pending = handleNewMessageSocketUpdate(params);
        expect(decryptStarted).toHaveBeenCalledTimes(1);

        session = undefined;
        resolveDecrypt({
            id: 'm2',
            seq: 2,
            localId: null,
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'deleted while decrypting' } },
        });
        await pending;

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
        expect(enqueueMessages).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(onNormalizedMessagesApplied).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(onMessageGapDetected).not.toHaveBeenCalled();
    });

    it('does not log an error when session encryption is missing for an unknown session (fetches sessions)', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { params, fetchSessions } = buildHarness({
                getSessionEncryption: () => null as any,
                getSession: () => undefined,
            });

            await handleNewMessageSocketUpdate(params);

            expect(fetchSessions).toHaveBeenCalledTimes(1);
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('returns early for invalid update payloads without side effects', async () => {
        const { params, fetchSessions, applyMessages } = buildHarness({
            updateData: buildUpdate({ sid: '', messageId: 'm1', messageSeq: 1 }),
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('emits lifecycle callback for turn_aborted socket messages', async () => {
        const onTaskLifecycleEvent = vi.fn();
        const { params } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'm2',
                messageSeq: 2,
            }),
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm2',
                    localId: null,
                    createdAt: 1_000,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'kimi',
                            data: { type: 'turn_aborted', id: 'task_1' },
                        },
                    },
                }),
            }),
            onTaskLifecycleEvent,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onTaskLifecycleEvent).toHaveBeenCalledWith('s1', {
            type: 'turn_aborted',
            id: 'task_1',
            createdAt: 1_000,
        });
    });

    it('materializes recovered lifecycle history without reopening the live turn or activity projection', async () => {
        const onTaskLifecycleEvent = vi.fn();
        const { params, applySessions } = buildHarness({
            updateData: buildUpdate({
                sid: 's1',
                messageId: 'history-task-started',
                messageSeq: 2,
                attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true },
                sourceCreatedAt: 100,
                sourceUpdatedAt: 200,
                transcriptObservationProvenance: {
                    kind: 'non_dependent',
                    source: 'history',
                },
            }),
            getSession: () => ({
                ...buildSession('s1'),
                updatedAt: 500,
                meaningfulActivityAt: 500,
                latestTurnStatus: 'completed',
            }),
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'history-task-started',
                    localId: null,
                    createdAt: 1_000,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'task_started', id: 'old-task' },
                        },
                    },
                }),
            }),
            onTaskLifecycleEvent,
        });

        await handleNewMessageSocketUpdate(params);

        expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(applySessions.mock.calls[0]?.[0]?.[0]).toMatchObject({
            seq: 2,
            updatedAt: 500,
            meaningfulActivityAt: 500,
            thinking: false,
            latestTurnStatus: 'completed',
        });
    });

    it('keeps a terminal latest turn projection when a stale task_started message replays', async () => {
        const { params, applySessions } = buildHarness({
            getSession: () => ({
                ...buildSession('s1'),
                updatedAt: 2_000,
                thinking: false,
                latestTurnStatus: 'completed',
            }),
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm2',
                    localId: null,
                    createdAt: 1_000,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'task_started', id: 'task_1' },
                        },
                    },
                }),
            }),
        });

        await handleNewMessageSocketUpdate(params);

        expect(applySessions.mock.calls[0]?.[0]?.[0]).toMatchObject({
            id: 's1',
            thinking: false,
            latestTurnStatus: 'completed',
        });
    });

    it('applies a newer task_started message as a fresh in-progress turn after a terminal projection', async () => {
        const { params, applySessions } = buildHarness({
            getSession: () => ({
                ...buildSession('s1'),
                updatedAt: 900,
                thinking: false,
                latestTurnStatus: 'completed',
            }),
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm2',
                    localId: null,
                    createdAt: 1_000,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'task_started', id: 'task_2' },
                        },
                    },
                }),
            }),
        });

        await handleNewMessageSocketUpdate(params);

        expect(applySessions.mock.calls[0]?.[0]?.[0]).toMatchObject({
            id: 's1',
            thinking: true,
            latestTurnStatus: 'in_progress',
        });
    });

    it('applies terminal lifecycle messages as completed primary turn projections', async () => {
        const { params, applySessions } = buildHarness({
            getSession: () => ({
                ...buildSession('s1'),
                thinking: true,
                latestTurnStatus: 'in_progress',
            }),
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm2',
                    localId: null,
                    createdAt: 1_000,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'task_complete', id: 'task_1' },
                        },
                    },
                }),
            }),
        });

        await handleNewMessageSocketUpdate(params);

        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(applySessions.mock.calls[0]?.[0]?.[0]).toMatchObject({
            id: 's1',
            thinking: false,
            latestTurnStatus: 'completed',
        });
    });

    it('notifies onNormalizedMessagesApplied after applying a decrypted message', async () => {
        const onNormalizedMessagesApplied = vi.fn();
        const { params } = buildHarness({
            onNormalizedMessagesApplied,
            getSessionEncryption: () => ({
                decryptMessage: async () => ({
                    id: 'm2',
                    localId: null,
                    createdAt: 1_000,
                    content: { role: 'user', content: { type: 'text', text: 'hi' } },
                }),
            }),
        } as any);

        await handleNewMessageSocketUpdate(params);

        expect(onNormalizedMessagesApplied).toHaveBeenCalledTimes(1);
        expect(onNormalizedMessagesApplied.mock.calls[0]?.[0]).toBe('s1');
        expect(Array.isArray(onNormalizedMessagesApplied.mock.calls[0]?.[1])).toBe(true);
        expect(onNormalizedMessagesApplied.mock.calls[0]?.[1]?.[0]?.id).toBe('m2');
    });

    it('records read normalize and apply telemetry for realtime messages', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const { params, applyMessages } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
        });

        await handleNewMessageSocketUpdate(params);

        expect(applyMessages).toHaveBeenCalledTimes(1);
        const events = syncPerformanceTelemetry.snapshot().events;
        const readEvent = events.find((event) => event.name === 'sync.sessions.socket.message.readMessage');
        expect(readEvent?.fields.encrypted).toBe(1);
        expect(readEvent?.fields.plain).toBe(0);
        expect(readEvent?.fields.activeViewingSession).toBe(0);
        expect(readEvent?.fields.messagesLoaded).toBe(1);
        const normalizeEvent = events.find((event) => event.name === 'sync.sessions.socket.message.normalize');
        expect(normalizeEvent?.fields.encrypted).toBe(1);
        expect(normalizeEvent?.fields.activeViewingSession).toBe(0);
        const applyEvent = events.find((event) => event.name === 'sync.sessions.socket.message.apply');
        expect(applyEvent?.fields.normalized).toBe(1);
        expect(applyEvent?.fields.queued).toBe(0);
    });

    it('enqueues messages when enqueueMessages is provided (instead of applying immediately)', async () => {
        const enqueueMessages = vi.fn();
        const onNormalizedMessagesApplied = vi.fn();
        const { params, applyMessages } = buildHarness({
            enqueueMessages,
            onNormalizedMessagesApplied,
        } as any);

        await handleNewMessageSocketUpdate(params);

        expect(enqueueMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages).not.toHaveBeenCalled();
        expect(onNormalizedMessagesApplied).not.toHaveBeenCalled();
    });

    it('summarizes distinct realtime sessions and routing outcomes for concurrent stream profiling', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        resetRealtimeFanoutTelemetry();

        const sessions = new Map<string, Session>([
            ['s1', {
                ...buildSession('s1'),
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            }],
            ['s2', {
                ...buildSession('s2'),
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            }],
        ]);
        const decryptMessage = vi.fn(async (encrypted: { id?: unknown }) => {
            const id = typeof encrypted.id === 'string' ? encrypted.id : 'message';
            return {
                id,
                localId: null,
                createdAt: 1_000,
                content: { role: 'user', content: { type: 'text', text: id } },
            };
        });
        const markSessionTranscriptDeferred = vi.fn();
        const { params } = buildHarness({
            getSession: (sessionId: string) => sessions.get(sessionId),
            getSessionEncryption: () => ({ decryptMessage }),
            realtimeProjectionMode: 'enabled',
            isSessionActivelyViewed: (sessionId: string) => sessionId === 's2',
            isSessionFullContentConsumerActive: () => false,
            markSessionTranscriptDeferred,
        });

        await handleNewMessageSocketUpdate({
            ...params,
            updateData: buildUpdate({ sid: 's1', messageId: 'm-hidden', messageSeq: 2 }),
        });
        await handleNewMessageSocketUpdate({
            ...params,
            updateData: buildUpdate({ sid: 's2', messageId: 'm-visible', messageSeq: 3 }),
        });
        flushRealtimeFanoutTelemetry();

        expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
        expect(decryptMessage).toHaveBeenCalledTimes(1);
        expect(syncPerformanceTelemetry.snapshot().events).toContainEqual(expect.objectContaining({
            name: 'sync.sessions.realtime.fanout.window',
            fields: expect.objectContaining({
                routeDecisions: 2,
                distinctSessions: 2,
                projectionOnly: 1,
                fullTranscriptApply: 1,
                visibleSessionMessages: 1,
                backgroundSessionMessages: 1,
            }),
        }));
    });

    it('requests a targeted session shell refresh instead of a full session-list refetch for hidden messages without attention metadata', async () => {
        const requestSessionShellRefresh = vi.fn();
        const decryptMessage = vi.fn();
        const { params, fetchSessions, applyMessages, applySessions } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
            getSession: () => ({
                ...buildSession('s1'),
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            }),
            getSessionEncryption: () => ({ decryptMessage }),
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
            requestSessionShellRefresh,
        });

        await handleNewMessageSocketUpdate(params);

        expect(requestSessionShellRefresh).toHaveBeenCalledTimes(1);
        expect(requestSessionShellRefresh).toHaveBeenCalledWith('s1');
        expect(fetchSessions).not.toHaveBeenCalled();
        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('falls back to a full session-list refetch for attention-less hidden messages when no targeted refresh is provided', async () => {
        const { params, fetchSessions } = buildHarness({
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
            getSession: () => ({
                ...buildSession('s1'),
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 900,
            }),
            isSessionActivelyViewed: () => false,
            isSessionFullContentConsumerActive: () => false,
            realtimeProjectionMode: 'enabled',
        });

        await handleNewMessageSocketUpdate(params);

        expect(fetchSessions).toHaveBeenCalledTimes(1);
    });

    it('can coalesce socket message applies by passing a coalescer enqueue function', async () => {
        const applied: Array<{ sessionId: string; ids: string[] }> = [];
        const applyMessages = vi.fn((sessionId: string, messages: NormalizedMessage[]) => {
            applied.push({ sessionId, ids: messages.map((m) => m.id) });
        });
        const onNormalizedMessagesApplied = vi.fn();

        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 16, maxBatchSize: 200 }),
            applyBatch: applyMessages,
            onBatchApplied: onNormalizedMessagesApplied,
        });

        const baseParams = buildHarness({
            applyMessages,
            enqueueMessages: (sessionId: string, messages: NormalizedMessage[]) => coalescer.enqueue(sessionId, messages),
            onNormalizedMessagesApplied,
            getSessionEncryption: () => ({
                decryptMessage: async (encrypted: any) => ({
                    id: encrypted.id,
                    localId: null,
                    createdAt: 1_000,
                    content: { role: 'user', content: { type: 'text', text: 'hi' } },
                }),
            }),
            getSessionMaterializedMaxSeq: () => 1,
        } as any).params;

        await handleNewMessageSocketUpdate({
            ...baseParams,
            updateData: buildUpdate({ sid: 's1', messageId: 'm2', messageSeq: 2 }),
        });
        await handleNewMessageSocketUpdate({
            ...baseParams,
            updateData: buildUpdate({ sid: 's1', messageId: 'm3', messageSeq: 3 }),
        });

        expect(applied).toEqual([]);
        expect(onNormalizedMessagesApplied).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(applied).toEqual([{ sessionId: 's1', ids: ['m2', 'm3'] }]);
        expect(onNormalizedMessagesApplied).toHaveBeenCalledTimes(1);
    });
});
