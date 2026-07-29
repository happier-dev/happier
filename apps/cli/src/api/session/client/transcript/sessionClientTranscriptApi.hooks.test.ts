import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { createSessionClientTranscriptApi } from './sessionClientTranscriptApi';

function createTranscriptApi(params?: Readonly<{
    transformSessionInputBeforeCommit?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    connected?: boolean;
    withVolatileSocket?: boolean;
    getLatestTurnSnapshot?: () => Readonly<{ status: 'completed'; observedAt: number }> | null;
    getActiveLocalTurnProgressAt?: () => number | null;
}>) {
    const commitSessionMessage = vi.fn(async () => undefined);
    const enqueuePendingUserMessage = vi.fn(async () => undefined);
    const recordUserMessageDeliveredToAgentQueue = vi.fn();
    const socketEmit = vi.fn();
    const socketVolatileEmit = vi.fn();
    const usageObservationPublisher = {
        publish: vi.fn(async () => undefined),
    };
    const api = createSessionClientTranscriptApi({
        token: 'token',
        sessionId: 'session-1',
        outboundShapeLogger: { log: vi.fn() },
        getSocket: () => ({
            connected: params?.connected ?? false,
            emit: socketEmit,
            ...(params?.withVolatileSocket
                ? { volatile: { emit: socketVolatileEmit } }
                : {}),
        }),
        getLatestTurnSnapshot: params?.getLatestTurnSnapshot ?? (() => null),
        getActiveLocalTurnProgressAt: params?.getActiveLocalTurnProgressAt ?? (() => null),
        getSessionConnectionSupervisor: () => null,
        getMetadataSnapshot: () => null,
        updateAgentState: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
        enqueueCommittedTranscriptMessage: vi.fn(async () => ({ persisted: true, delivered: true })),
        enqueueCommittedVoiceAgentTranscriptTurn: vi.fn(async () => ({ persisted: true, delivered: true })),
        usageObservationPublisher,
        buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
        commitSessionMessageBestEffort: vi.fn(async () => undefined),
        enqueueMessageCommit: async (fn) => await fn(),
        commitSessionMessage,
        logSendWhileDisconnected: vi.fn(),
        hasAgentQueueEchoSuppressedLocalId: () => false,
        markAgentQueueEchoSuppressedLocalId: vi.fn(),
        clearAgentQueueEchoSuppressedLocalId: vi.fn(),
        markAgentQueueDeliveredLocalId: vi.fn(),
        clearAgentQueueDeliveredLocalId: vi.fn(),
        getCommittedUserMessageSeq: () => 42,
        recordUserMessageDeliveredToAgentQueue,
        toolCallCanonicalNameByProviderAndId: new Map(),
        permissionToolCallRawInputByProviderAndId: new Map(),
        toolCallInputByProviderAndId: new Map(),
        enqueuePendingUserMessage,
        getTranscriptQueryContext: () => ({
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
        }),
        transformSessionInputBeforeCommit: params?.transformSessionInputBeforeCommit,
    } as Parameters<typeof createSessionClientTranscriptApi>[0]);

    return {
        api,
        commitSessionMessage,
        enqueuePendingUserMessage,
        recordUserMessageDeliveredToAgentQueue,
        socketEmit,
        socketVolatileEmit,
        usageObservationPublisher,
    };
}

describe('createSessionClientTranscriptApi hook dispatch', () => {
    it('replays the latest turn status and observation time on session presence', () => {
        const { api, socketEmit } = createTranscriptApi({
            connected: true,
            getLatestTurnSnapshot: () => ({ status: 'completed', observedAt: 1234 }),
        });

        api.keepAlive(false, 'remote');

        expect(socketEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1234,
        }));
    });

    it('publishes the first idle presence durably, uses volatile heartbeats afterward, and durably replays on reconnect', () => {
        const { api, socketEmit, socketVolatileEmit } = createTranscriptApi({
            connected: true,
            withVolatileSocket: true,
        });

        api.keepAlive(false, 'remote');

        expect(socketEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'session-1',
            thinking: false,
            mode: 'remote',
        }));
        expect(socketVolatileEmit).not.toHaveBeenCalled();

        socketEmit.mockClear();
        api.keepAlive(false, 'remote');

        expect(socketEmit).not.toHaveBeenCalled();
        expect(socketVolatileEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'session-1',
            thinking: false,
            mode: 'remote',
        }));

        socketVolatileEmit.mockClear();
        api.replayLatestPresence();

        expect(socketEmit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
            sid: 'session-1',
            thinking: false,
            mode: 'remote',
        }));
        expect(socketVolatileEmit).not.toHaveBeenCalled();
    });

    it('self-heals terminal thinking after 15 seconds when the active local turn has no recent progress', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(0);
            const { api, socketEmit } = createTranscriptApi({
                connected: true,
                getLatestTurnSnapshot: () => ({ status: 'completed', observedAt: 1 }),
                getActiveLocalTurnProgressAt: () => 0,
            });

            api.keepAlive(true, 'remote');
            vi.setSystemTime(15_001);
            api.keepAlive(true, 'remote');

            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: false }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('extends the terminal thinking guard from the latest local turn progress', () => {
        vi.useFakeTimers();
        try {
            let progressAt = 0;
            vi.setSystemTime(0);
            const { api, socketEmit } = createTranscriptApi({
                connected: true,
                getLatestTurnSnapshot: () => ({ status: 'completed', observedAt: 1 }),
                getActiveLocalTurnProgressAt: () => progressAt,
            });

            api.keepAlive(true, 'remote');
            progressAt = 10_000;
            vi.setSystemTime(10_000);
            api.keepAlive(true, 'remote');
            vi.setSystemTime(24_999);
            api.keepAlive(true, 'remote');
            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: true }));

            vi.setSystemTime(25_000);
            api.keepAlive(true, 'remote');
            expect(socketEmit).toHaveBeenLastCalledWith('session-alive', expect.objectContaining({ thinking: false }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('applies session.input.transform before enqueueing Pending with zero transcript or provider effect', async () => {
        const transformSessionInputBeforeCommit = vi.fn(async (payload: Record<string, unknown>) => ({
            ...payload,
            text: `${payload.text} [transformed]`,
            meta: {
                ...(payload.meta as Record<string, unknown>),
                transformedBy: 'fixture.plugin',
            },
        }));
        const {
            api,
            commitSessionMessage,
            enqueuePendingUserMessage,
            recordUserMessageDeliveredToAgentQueue,
        } = createTranscriptApi({ transformSessionInputBeforeCommit });

        await api.enqueueSessionUserMessage({
            text: 'original',
            localId: 'local-1',
            meta: { source: 'ui', sentFrom: 'ui' },
        });

        expect(transformSessionInputBeforeCommit).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            localId: 'local-1',
            text: 'original',
            meta: { source: 'ui', sentFrom: 'ui' },
        }));
        expect(commitSessionMessage).not.toHaveBeenCalled();
        expect(enqueuePendingUserMessage).toHaveBeenCalledWith({
            localId: 'local-1',
            message: {
                t: 'plain',
                v: expect.objectContaining({
                    role: 'user',
                    content: { type: 'text', text: 'original [transformed]' },
                    meta: expect.objectContaining({
                        source: 'ui',
                        sentFrom: 'ui',
                        transformedBy: 'fixture.plugin',
                    }),
                }),
            },
            requestedAction: { v: 1, kind: 'enqueue' },
        });
        expect(recordUserMessageDeliveredToAgentQueue).not.toHaveBeenCalled();
    });

    it('does not pass hostile session input transform failures to retained logging', async () => {
        const privateTranscript = 'private voice transcript that must not enter logs';
        const hostileFailure = new Proxy(
            {
                toJSON: () => ({ privateTranscript }),
                toString: () => privateTranscript,
            },
            {
                get(target, property, receiver) {
                    if (property === Symbol.toPrimitive) return () => privateTranscript;
                    return Reflect.get(target, property, receiver);
                },
            },
        );
        const logDebug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const { api, enqueuePendingUserMessage } = createTranscriptApi({
            transformSessionInputBeforeCommit: async () => {
                throw hostileFailure;
            },
        });

        try {
            await api.enqueueSessionUserMessage({
                text: privateTranscript,
                localId: 'local-private-transform-failure',
                meta: { source: 'voice', sentFrom: 'voice' },
            });

            expect(enqueuePendingUserMessage).toHaveBeenCalled();
            expect(logDebug).toHaveBeenCalledWith(
                '[plugins] session.input.transform failed; using original input',
            );
        } finally {
            logDebug.mockRestore();
        }
    });

    it('publishes token_count usage after committing a runtime-projected agent message', async () => {
        const { api, usageObservationPublisher } = createTranscriptApi();

        await api.enqueueAgentMessageCommitted('codex', {
            type: 'token_count',
            id: 'codex:thread-1:turn-1',
            source: 'codex-app-server-token-usage',
            scope: 'session_cumulative',
            modelId: 'gpt-5.6-sol',
            tokens: { input: 8, output: 2, total: 10 },
            context_used_tokens: 6,
            context_window_tokens: 100,
        } as never, {
            localId: 'codex:thread-1:turn-1',
            provenance: { kind: 'non_dependent', source: 'external' },
        });

        expect(usageObservationPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            observation: expect.objectContaining({
                provider: 'codex',
                source: 'codex-app-server-token-usage',
                scope: 'session_cumulative',
                modelId: 'gpt-5.6-sol',
                contextUsedTokens: 6,
                contextWindowTokens: 100,
            }),
            externalKey: 'codex:thread-1:turn-1',
        }));
    });

    it('publishes token_count usage after a directly committed agent message', async () => {
        const { api, usageObservationPublisher } = createTranscriptApi();

        await api.sendAgentMessageCommitted('codex', {
            type: 'token_count',
            id: 'codex:thread-2:turn-2',
            source: 'codex-app-server-token-usage',
            scope: 'session_cumulative',
            modelId: 'gpt-5.6-sol',
            tokens: { input: 8, output: 2, total: 10 },
        } as never, { localId: 'codex:thread-2:turn-2' });

        expect(usageObservationPublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            observation: expect.objectContaining({
                provider: 'codex',
                source: 'codex-app-server-token-usage',
                scope: 'session_cumulative',
            }),
            externalKey: 'codex:thread-2:turn-2',
        }));
    });
});
