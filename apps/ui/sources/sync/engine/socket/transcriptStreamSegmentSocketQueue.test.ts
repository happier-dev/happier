import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { createSessionMessageApplyCoalescer } from '@/sync/engine/sessions/sessionMessageApplyCoalescer';
import type { NormalizedMessage } from '@/sync/typesRaw';

import { resetTranscriptStreamSegmentAssemblyForTests } from '@/sync/engine/sessions/transcriptStreamSegmentAssembly';
import {
    createTranscriptStreamSegmentSocketQueueController,
    type TranscriptStreamSegmentSocketQueueEntry,
} from './transcriptStreamSegmentSocketQueue';

function buildSession(sessionId: string, encryptionMode: 'e2ee' | 'plain' = 'plain'): Session {
    return {
        id: sessionId,
        seq: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        active: true,
        activeAt: 1_000,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        encryptionMode,
    };
}

function buildRawTranscriptStreamSegmentRecord(text: string, localId: string) {
    return {
        role: 'agent',
        content: {
            type: 'acp',
            agentId: 'codex',
            data: { type: 'message', message: text },
        },
        meta: {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: localId,
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_010,
            },
        },
    };
}

function buildEncryptedEntry(params: Readonly<{
    sessionId: string;
    localId: string;
    ciphertext: string;
    sessionEncryption: SessionEncryption;
    getSession: (sessionId: string) => Session | undefined;
}>): TranscriptStreamSegmentSocketQueueEntry {
    return {
        update: {
            type: 'transcript-stream-segment',
            sessionId: params.sessionId,
            message: {
                localId: params.localId,
                content: { t: 'encrypted', c: params.ciphertext },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        },
        shouldContinue: () => true,
        getSessionEncryption: () => params.sessionEncryption,
        getSession: params.getSession,
    };
}

function buildPlainEntry(sessionId: string, localId: string): TranscriptStreamSegmentSocketQueueEntry {
    return {
        update: {
            type: 'transcript-stream-segment',
            sessionId,
            message: {
                localId,
                content: {
                    t: 'plain',
                    v: buildRawTranscriptStreamSegmentRecord(localId, localId),
                },
                createdAt: 1_000,
                updatedAt: 1_010,
            },
        },
        shouldContinue: () => true,
        getSessionEncryption: () => null,
        getSession: () => buildSession(sessionId, 'plain'),
    };
}

describe('createTranscriptStreamSegmentSocketQueueController', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('drops a hidden encrypted segment at flush time without decrypting', async () => {
        const sessionId = 'hidden-encrypted-session';
        const decryptPayloads = vi.fn(async (payloads: Uint8Array[]) => payloads.map((payload) => {
            const localId = payload[0] === 1 ? 'segment-hidden' : 'segment-other';
            return buildRawTranscriptStreamSegmentRecord('hidden encrypted live', localId);
        }));
        const sessionEncryption = new SessionEncryption(
            sessionId,
            {
                encrypt: async () => [],
                decrypt: decryptPayloads,
            },
            new EncryptionCache(),
        );
        const applied: NormalizedMessage[][] = [];
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
            applyBatch: (_appliedSessionId, messages) => {
                applied.push(messages);
            },
        });
        const controller = createTranscriptStreamSegmentSocketQueueController({
            getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
            isSessionVisible: () => false,
            messageCoalescer: coalescer,
        });

        await controller.handle(buildEncryptedEntry({
            sessionId,
            localId: 'segment-hidden',
            ciphertext: 'AQ==',
            sessionEncryption,
            getSession: () => buildSession(sessionId, 'e2ee'),
        }));

        expect(decryptPayloads).not.toHaveBeenCalled();
        expect(applied).toEqual([]);

        await vi.advanceTimersByTimeAsync(50);

        expect(decryptPayloads).not.toHaveBeenCalled();
        expect(applied).toEqual([]);
    });

    it('flushes queued hidden work before applying the next visible segment', async () => {
        const sessionId = 'visible-promotion-session';
        let visible = false;
        const decryptPayloads = vi.fn(async (payloads: Uint8Array[]) => payloads.map((payload) => {
            const isVisiblePayload = payload[0] === 2;
            const localId = isVisiblePayload ? 'segment-visible' : 'segment-hidden';
            return buildRawTranscriptStreamSegmentRecord(
                isVisiblePayload ? 'visible encrypted live' : 'hidden encrypted live',
                localId,
            );
        }));
        const sessionEncryption = new SessionEncryption(
            sessionId,
            {
                encrypt: async () => [],
                decrypt: decryptPayloads,
            },
            new EncryptionCache(),
        );
        const applied: NormalizedMessage[][] = [];
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
            applyBatch: (_appliedSessionId, messages) => {
                applied.push(messages);
            },
        });
        const controller = createTranscriptStreamSegmentSocketQueueController({
            getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
            isSessionVisible: () => visible,
            messageCoalescer: coalescer,
        });

        await controller.handle(buildEncryptedEntry({
            sessionId,
            localId: 'segment-hidden',
            ciphertext: 'AQ==',
            sessionEncryption,
            getSession: () => buildSession(sessionId, 'e2ee'),
        }));

        expect(decryptPayloads).not.toHaveBeenCalled();
        expect(applied).toEqual([]);

        visible = true;
        await controller.handle(buildEncryptedEntry({
            sessionId,
            localId: 'segment-visible',
            ciphertext: 'Ag==',
            sessionEncryption,
            getSession: () => buildSession(sessionId, 'e2ee'),
        }));

        expect(decryptPayloads).toHaveBeenCalledTimes(2);
        expect(applied.map((messages) => messages.map((message) => message.localId))).toEqual([
            ['segment-hidden'],
            ['segment-visible'],
        ]);

        await vi.runAllTimersAsync();

        expect(applied.map((messages) => messages.map((message) => message.localId))).toEqual([
            ['segment-hidden'],
            ['segment-visible'],
        ]);
    });

    it('does not use the coalescer applied hook when queued hidden work is dropped', async () => {
        const sessionId = 'materialized-seq-session';
        let materializedMaxSeq = 0;
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
            applyBatch: () => {},
            onBatchApplied: (_appliedSessionId, messages) => {
                for (const message of messages) {
                    if (typeof message.seq === 'number') {
                        materializedMaxSeq = Math.max(materializedMaxSeq, message.seq);
                    }
                }
            },
        });
        const controller = createTranscriptStreamSegmentSocketQueueController({
            getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
            isSessionVisible: () => false,
            messageCoalescer: coalescer,
            handleTranscriptStreamSegment: async ({ update, applyMessages }) => {
                applyMessages(update.sessionId, [{
                    id: update.message.localId,
                    localId: update.message.localId,
                    seq: 7,
                    createdAt: update.message.createdAt,
                    role: 'agent',
                    content: [{
                        type: 'text',
                        text: 'queued',
                        uuid: update.message.localId,
                        parentUUID: null,
                    }],
                    isSidechain: false,
                }]);
            },
        });

        await controller.handle(buildPlainEntry(sessionId, 'segment-hidden'));
        expect(materializedMaxSeq).toBe(0);

        await vi.advanceTimersByTimeAsync(50);

        expect(materializedMaxSeq).toBe(0);
    });

    it('checks stream segment visibility with the entry source server', async () => {
        const sessionId = 'source-scoped-immediate-session';
        const sourceServerId = 'srv_source_scope';
        const visibilityChecks = vi.fn((_checkedSessionId: string, checkedServerId?: string | null) => (
            checkedServerId === sourceServerId
        ));
        const handleTranscriptStreamSegment = vi.fn();
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: false, windowMs: 0, maxBatchSize: 1_000 }),
            applyBatch: () => {},
        });
        const controller = createTranscriptStreamSegmentSocketQueueController({
            getConfig: () => ({ enabled: false, windowMs: 0, maxBatchSize: 1_000 }),
            isSessionVisible: visibilityChecks,
            messageCoalescer: coalescer,
            handleTranscriptStreamSegment,
        });
        await controller.handle({
            ...buildPlainEntry(sessionId, 'segment-source-scoped-immediate'),
            sourceServerId,
        });

        expect(visibilityChecks).toHaveBeenCalledWith(sessionId, sourceServerId);
        expect(handleTranscriptStreamSegment).toHaveBeenCalledTimes(1);
    });

    it('skips hidden immediate entries before preparing global apply handlers', async () => {
        const sessionId = 'hidden-immediate-session';
        const prepareApplyEntry = vi.fn();
        const handleTranscriptStreamSegment = vi.fn();
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: false, windowMs: 0, maxBatchSize: 1_000 }),
            applyBatch: () => {},
        });
        const controller = createTranscriptStreamSegmentSocketQueueController({
            getConfig: () => ({ enabled: false, windowMs: 0, maxBatchSize: 1_000 }),
            isSessionVisible: () => false,
            messageCoalescer: coalescer,
            prepareApplyEntry,
            handleTranscriptStreamSegment,
        });

        await controller.handle(buildPlainEntry(sessionId, 'segment-hidden-immediate'));

        expect(prepareApplyEntry).not.toHaveBeenCalled();
        expect(handleTranscriptStreamSegment).not.toHaveBeenCalled();
    });

    it('keeps multi-session hidden stream segments off the hot path while one session is viewed', async () => {
        const visibleSessionId = 'visible-stream-session';
        const hiddenSessionIds = Array.from({ length: 10 }, (_, index) => `hidden-stream-session-${index + 1}`);
        const visibleSessions = new Set<string>([visibleSessionId]);
        const applyMessages = vi.fn();
        const handleTranscriptStreamSegment = vi.fn(async ({ update, applyMessages: apply }) => {
            apply(update.sessionId, [{
                id: update.message.localId,
                localId: update.message.localId,
                seq: 0,
                createdAt: update.message.createdAt,
                role: 'agent',
                content: [{
                    type: 'text',
                    text: `stream ${update.message.localId}`,
                    uuid: update.message.localId,
                    parentUUID: null,
                }],
                isSidechain: false,
            }]);
        });
        const coalescer = createSessionMessageApplyCoalescer({
            getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
            applyBatch: applyMessages,
        });
        const controller = createTranscriptStreamSegmentSocketQueueController({
            getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
            isSessionVisible: (sessionId) => visibleSessions.has(sessionId),
            messageCoalescer: coalescer,
            handleTranscriptStreamSegment,
        });

        for (const sessionId of hiddenSessionIds) {
            for (let index = 0; index < 5; index += 1) {
                await controller.handle(buildPlainEntry(sessionId, `hidden-segment-${sessionId}`));
            }
        }
        await controller.handle(buildPlainEntry(visibleSessionId, 'visible-segment'));

        await vi.runAllTimersAsync();

        expect(handleTranscriptStreamSegment).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[0]).toBe(visibleSessionId);
        expect(applyMessages.mock.calls[0]?.[1]).toEqual([
            expect.objectContaining({ localId: 'visible-segment' }),
        ]);
    });

    describe('delta composition', () => {
        beforeEach(() => {
            resetTranscriptStreamSegmentAssemblyForTests();
        });

        afterEach(() => {
            resetTranscriptStreamSegmentAssemblyForTests();
        });

        function buildPlainSnapshotEntry(sessionId: string, text: string, opts: { localId?: string; tick: number }): TranscriptStreamSegmentSocketQueueEntry {
            const localId = opts.localId ?? 'segment-1';
            return {
                update: {
                    type: 'transcript-stream-segment',
                    sessionId,
                    message: {
                        localId,
                        messageRole: 'agent',
                        tick: opts.tick,
                        content: {
                            t: 'plain',
                            v: buildRawTranscriptStreamSegmentRecord(text, localId),
                        },
                        createdAt: 1_000,
                        updatedAt: 1_010,
                    },
                } as never,
                shouldContinue: () => true,
                getSessionEncryption: () => null,
                getSession: () => buildSession(sessionId, 'plain'),
            };
        }

        function buildPlainDeltaEntry(sessionId: string, deltaText: string, opts: { localId?: string; tick: number; baseLength: number }): TranscriptStreamSegmentSocketQueueEntry {
            const localId = opts.localId ?? 'segment-1';
            return {
                update: {
                    type: 'transcript-stream-segment-delta',
                    sessionId,
                    message: {
                        localId,
                        messageRole: 'agent',
                        tick: opts.tick,
                        baseLength: opts.baseLength,
                        content: {
                            t: 'plain',
                            v: buildRawTranscriptStreamSegmentRecord(deltaText, localId),
                        },
                        createdAt: 1_000,
                        updatedAt: 1_040,
                    },
                } as never,
                shouldContinue: () => true,
                getSessionEncryption: () => null,
                getSession: () => buildSession(sessionId, 'plain'),
            };
        }

        function extractAppliedTexts(applied: NormalizedMessage[][]): string[] {
            return applied.map((messages) => {
                const blocks = (messages[0]?.content ?? []) as Array<{ type: string; text?: string }>;
                return blocks.find((entry) => entry.type === 'text')?.text ?? '';
            });
        }

        it('drops deltas for hidden sessions immediately without deferring or collapsing them', async () => {
            const sessionId = 'hidden-delta-session';
            const droppedHidden = vi.fn();
            const applied: NormalizedMessage[][] = [];
            const coalescer = createSessionMessageApplyCoalescer({
                getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
                applyBatch: (_appliedSessionId, messages) => {
                    applied.push(messages);
                },
            });
            const controller = createTranscriptStreamSegmentSocketQueueController({
                getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
                isSessionVisible: () => false,
                messageCoalescer: coalescer,
                onDeferredRawDroppedHidden: droppedHidden,
            });

            await controller.handle(buildPlainDeltaEntry(sessionId, ' wor', { tick: 2, baseLength: 5 }));
            await controller.handle(buildPlainDeltaEntry(sessionId, 'ld', { tick: 3, baseLength: 9 }));

            expect(droppedHidden).toHaveBeenCalledTimes(2);
            expect(droppedHidden).toHaveBeenCalledWith({ messages: 1 });

            await vi.runAllTimersAsync();
            await controller.flush(sessionId);

            expect(applied).toEqual([]);
        });

        it('flushes deferred snapshots before applying a visible delta so reconstruction stays ordered', async () => {
            const sessionId = 'visible-delta-session';
            let visible = false;
            const applied: NormalizedMessage[][] = [];
            const coalescer = createSessionMessageApplyCoalescer({
                getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
                applyBatch: (_appliedSessionId, messages) => {
                    applied.push(messages);
                },
            });
            const controller = createTranscriptStreamSegmentSocketQueueController({
                getConfig: () => ({ enabled: true, windowMs: 50, maxBatchSize: 1_000 }),
                isSessionVisible: () => visible,
                messageCoalescer: coalescer,
            });

            await controller.handle(buildPlainSnapshotEntry(sessionId, 'Hello', { tick: 1 }));
            expect(applied).toEqual([]);

            visible = true;
            await controller.handle(buildPlainDeltaEntry(sessionId, ' world', { tick: 2, baseLength: 5 }));

            expect(extractAppliedTexts(applied)).toEqual(['Hello', 'Hello world']);
        });
    });
});
