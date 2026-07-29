import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecryptedMessage, Session } from '@/sync/domains/state/storageTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { handleTranscriptStreamSegmentEphemeralUpdate } from './handleTranscriptStreamSegmentEphemeralUpdate';
import { resetTranscriptStreamSegmentAssemblyForTests } from './transcriptStreamSegmentAssembly';

function buildSession(sessionId: string, encryptionMode: Session['encryptionMode'] = 'plain'): Session {
    return {
        id: sessionId,
        seq: 1,
        encryptionMode,
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

describe('handleTranscriptStreamSegmentEphemeralUpdate', () => {
    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('records stream segment telemetry when applying a plain transcript segment', async () => {
        const applyMessages = vi.fn();
        const getSessionEncryption = vi.fn(() => null);
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await handleTranscriptStreamSegmentEphemeralUpdate({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'local-1',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'streaming' },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            },
            getSessionEncryption,
            getSession: () => buildSession('s1'),
            applyMessages,
            isSessionActivelyViewed: (sessionId) => sessionId === 's1',
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(getSessionEncryption).not.toHaveBeenCalled();

        const events = syncPerformanceTelemetry.snapshot().events;
        const streamEvent = events.find((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment');
        expect(streamEvent?.fields.plain).toBe(1);
        expect(streamEvent?.fields.encrypted).toBe(0);
        expect(streamEvent?.fields.activeViewingSession).toBe(1);
        expect(streamEvent?.fields.backgroundSession).toBe(0);
        const readEvent = events.find((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment.readMessage');
        expect(readEvent?.fields.plain).toBe(1);
        expect(readEvent?.fields.activeViewingSession).toBe(1);
        const applyEvent = events.find((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment.apply');
        expect(applyEvent?.fields.normalized).toBe(1);
        expect(applyEvent?.fields.activeViewingSession).toBe(1);
    });

    it('preserves messageRole when normalizing plain transcript stream segments', async () => {
        const applyMessages = vi.fn();

        await handleTranscriptStreamSegmentEphemeralUpdate({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'stream-event-1',
                    messageRole: 'event',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'assistant',
                                    uuid: 'event-uuid',
                                    message: {
                                        role: 'assistant',
                                        content: [{ type: 'text', text: 'Transport status' }],
                                    },
                                },
                            },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            },
            getSessionEncryption: () => null,
            getSession: () => buildSession('s1'),
            applyMessages,
        });

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('skips hidden transcript stream segments before decrypting content', async () => {
        const decryptMessage = vi.fn(async () => ({
            id: 'stream-1',
            seq: 0,
            localId: 'stream-1',
            createdAt: 1_000,
            content: { role: 'agent', content: { type: 'text', text: 'background token' } },
        }));
        const applyMessages = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const params = {
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'stream-1',
                    content: { t: 'encrypted', c: 'ciphertext' },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            },
            getSessionEncryption: () => ({ decryptMessage }),
            getSession: () => buildSession('s1', 'e2ee'),
            applyMessages,
            isSessionActivelyViewed: () => false,
            skipWhenHidden: true,
        } satisfies Parameters<typeof handleTranscriptStreamSegmentEphemeralUpdate>[0] & { skipWhenHidden: true };

        await handleTranscriptStreamSegmentEphemeralUpdate(params);

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();

        const events = syncPerformanceTelemetry.snapshot().events;
        const streamEvent = events.find((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment');
        expect(streamEvent?.fields.backgroundSession).toBe(1);
        expect(streamEvent?.fields.skippedHidden).toBe(1);
        expect(events.some((event) => event.name === 'sync.sessions.socket.transcriptStreamSegment.readMessage')).toBe(false);
    });

    it('drops in-flight stream segment work when the session is deleted before decrypt resolves', async () => {
        let session: Session | undefined = buildSession('s1', 'e2ee');
        let resolveDecrypt!: (message: DecryptedMessage) => void;
        const decryptedMessage = new Promise<DecryptedMessage>((resolve) => {
            resolveDecrypt = resolve;
        });
        const decryptStarted = vi.fn();
        const applyMessages = vi.fn();

        const pending = handleTranscriptStreamSegmentEphemeralUpdate({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'stream-1',
                    content: { t: 'encrypted', c: 'ciphertext' },
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            },
            getSessionEncryption: () => ({
                decryptMessage: async () => {
                    decryptStarted();
                    return await decryptedMessage;
                },
            }),
            getSession: () => session,
            applyMessages,
        });
        expect(decryptStarted).toHaveBeenCalledTimes(1);

        session = undefined;
        resolveDecrypt({
            id: 'stream-1',
            seq: 0,
            localId: 'stream-1',
            createdAt: 1_000,
            content: { role: 'user', content: { type: 'text', text: 'deleted while streaming' } },
        });
        await pending;

        expect(applyMessages).not.toHaveBeenCalled();
    });
});

function buildPlainSegmentRecord(text: string, opts: { localId?: string; state?: 'streaming' | 'complete' | 'interrupted' } = {}) {
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
                segmentLocalId: opts.localId ?? 'segment-1',
                segmentState: opts.state ?? 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_010,
            },
        },
    };
}

function buildPlainSnapshotUpdate(sessionId: string, text: string, opts: { localId?: string; tick?: number; state?: 'streaming' | 'complete' | 'interrupted' } = {}) {
    return {
        type: 'transcript-stream-segment',
        sessionId,
        message: {
            localId: opts.localId ?? 'segment-1',
            messageRole: 'agent',
            ...(typeof opts.tick === 'number' ? { tick: opts.tick } : {}),
            content: { t: 'plain', v: buildPlainSegmentRecord(text, opts) },
            createdAt: 1_000,
            updatedAt: 1_010,
        },
    } as const;
}

function buildPlainDeltaUpdate(sessionId: string, deltaText: string, opts: { localId?: string; tick: number; baseLength: number }) {
    return {
        type: 'transcript-stream-segment-delta',
        sessionId,
        message: {
            localId: opts.localId ?? 'segment-1',
            messageRole: 'agent',
            tick: opts.tick,
            baseLength: opts.baseLength,
            content: { t: 'plain', v: buildPlainSegmentRecord(deltaText, opts) },
            createdAt: 1_000,
            updatedAt: 1_040,
        },
    } as const;
}

function extractAppliedText(applyMessages: ReturnType<typeof vi.fn>, callIndex: number): string {
    const [, messages] = applyMessages.mock.calls[callIndex] as [string, Array<{ content: Array<{ type: string; text?: string }> }>];
    const block = messages[0]?.content?.find((entry) => entry.type === 'text');
    return block?.text ?? '';
}

describe('handleTranscriptStreamSegmentEphemeralUpdate delta reconstruction', () => {
    beforeEach(() => {
        resetTranscriptStreamSegmentAssemblyForTests();
    });

    afterEach(() => {
        resetTranscriptStreamSegmentAssemblyForTests();
    });

    function buildHandlerParams(sessionId: string, applyMessages: ReturnType<typeof vi.fn>) {
        return {
            getSessionEncryption: () => null,
            getSession: () => buildSession(sessionId),
            applyMessages,
            isSessionActivelyViewed: () => true,
        };
    }

    it('reconstructs accumulated text from a snapshot plus chained deltas through the same apply path', async () => {
        const sessionId = 's-delta-1';
        const applyMessages = vi.fn();
        const params = buildHandlerParams(sessionId, applyMessages);

        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainSnapshotUpdate(sessionId, 'Hello', { tick: 1 }) as never,
        });
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, ' wor', { tick: 2, baseLength: 5 }) as never,
        });
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, 'ld', { tick: 3, baseLength: 9 }) as never,
        });

        expect(applyMessages).toHaveBeenCalledTimes(3);
        expect(extractAppliedText(applyMessages, 0)).toBe('Hello');
        expect(extractAppliedText(applyMessages, 1)).toBe('Hello wor');
        expect(extractAppliedText(applyMessages, 2)).toBe('Hello world');
    });

    it('drops deltas for unknown segments until a snapshot establishes assembly state', async () => {
        const sessionId = 's-delta-unknown';
        const applyMessages = vi.fn();
        const params = buildHandlerParams(sessionId, applyMessages);

        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, 'orphan', { tick: 2, baseLength: 5 }) as never,
        });
        expect(applyMessages).not.toHaveBeenCalled();

        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainSnapshotUpdate(sessionId, 'Hello orphan', { tick: 3 }) as never,
        });
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(extractAppliedText(applyMessages, 0)).toBe('Hello orphan');
    });

    it('drops deltas on tick gaps and stays desynced until the next snapshot resyncs', async () => {
        const sessionId = 's-delta-gap';
        const applyMessages = vi.fn();
        const params = buildHandlerParams(sessionId, applyMessages);

        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainSnapshotUpdate(sessionId, 'Hello', { tick: 1 }) as never,
        });
        // Tick 2 lost in transit; tick 3 must be dropped.
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, 'ld', { tick: 3, baseLength: 9 }) as never,
        });
        // Even a length-consistent later delta stays dropped while desynced.
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, '!', { tick: 4, baseLength: 5 }) as never,
        });
        expect(applyMessages).toHaveBeenCalledTimes(1);

        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainSnapshotUpdate(sessionId, 'Hello world!', { tick: 5 }) as never,
        });
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, '?', { tick: 6, baseLength: 12 }) as never,
        });

        expect(applyMessages).toHaveBeenCalledTimes(3);
        expect(extractAppliedText(applyMessages, 2)).toBe('Hello world!?');
    });

    it('chains deltas by base length alone when an old server stripped the snapshot tick', async () => {
        const sessionId = 's-delta-tickless';
        const applyMessages = vi.fn();
        const params = buildHandlerParams(sessionId, applyMessages);

        // Old servers `.strip()` the snapshot `tick`; assembly falls back to lastTick === null.
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainSnapshotUpdate(sessionId, 'Hello') as never,
        });
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, ' world', { tick: 7, baseLength: 5 }) as never,
        });

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(extractAppliedText(applyMessages, 1)).toBe('Hello world');
    });

    it('drops deltas whose base length does not match the assembled text', async () => {
        const sessionId = 's-delta-baselen';
        const applyMessages = vi.fn();
        const params = buildHandlerParams(sessionId, applyMessages);

        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainSnapshotUpdate(sessionId, 'Hello', { tick: 1 }) as never,
        });
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, ' world', { tick: 2, baseLength: 4 }) as never,
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);
    });

    it('evicts assembly state when a snapshot reports a completed segment', async () => {
        const sessionId = 's-delta-complete';
        const applyMessages = vi.fn();
        const params = buildHandlerParams(sessionId, applyMessages);

        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainSnapshotUpdate(sessionId, 'Hello', { tick: 1, state: 'complete' }) as never,
        });
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: buildPlainDeltaUpdate(sessionId, ' late', { tick: 2, baseLength: 5 }) as never,
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(extractAppliedText(applyMessages, 0)).toBe('Hello');
    });

    it('decrypts only the delta payload when reconstructing encrypted segments', async () => {
        const sessionId = 's-delta-encrypted';
        const applyMessages = vi.fn();
        const decryptMessage = vi.fn(async (message: { content: { c?: string }; id: string; createdAt: number }) => ({
            id: message.id,
            seq: 0,
            localId: message.id,
            messageRole: 'agent' as const,
            createdAt: message.createdAt,
            content: buildPlainSegmentRecord(String(message.content.c ?? '').replace(/^cipher:/, '')),
        }));
        const params = {
            getSessionEncryption: () => ({ decryptMessage: decryptMessage as never }),
            getSession: () => buildSession(sessionId, 'e2ee'),
            applyMessages,
            isSessionActivelyViewed: () => true,
        };

        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: {
                type: 'transcript-stream-segment',
                sessionId,
                message: {
                    localId: 'segment-1',
                    messageRole: 'agent',
                    tick: 1,
                    content: { t: 'encrypted', c: 'cipher:Hello' },
                    createdAt: 1_000,
                    updatedAt: 1_010,
                },
            } as never,
        });
        await handleTranscriptStreamSegmentEphemeralUpdate({
            ...params,
            update: {
                type: 'transcript-stream-segment-delta',
                sessionId,
                message: {
                    localId: 'segment-1',
                    messageRole: 'agent',
                    tick: 2,
                    baseLength: 5,
                    content: { t: 'encrypted', c: 'cipher: world' },
                    createdAt: 1_000,
                    updatedAt: 1_040,
                },
            } as never,
        });

        expect(decryptMessage).toHaveBeenCalledTimes(2);
        expect(decryptMessage.mock.calls[1]?.[0]).toMatchObject({
            content: { t: 'encrypted', c: 'cipher: world' },
        });
        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(extractAppliedText(applyMessages, 1)).toBe('Hello world');
    });
});
