import { describe, expect, it, vi } from 'vitest';

import { createSessionClientTranscriptApi } from './sessionClientTranscriptApi';

function createTranscriptApi(params?: Readonly<{
    transformSessionInputBeforeCommit?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
    connected?: boolean;
    getLatestTurnSnapshot?: () => Readonly<{ status: 'completed'; observedAt: number }> | null;
    getActiveLocalTurnProgressAt?: () => number | null;
}>) {
    const commitSessionMessage = vi.fn(async () => undefined);
    const deliverUserMessageToAgentQueue = vi.fn(() => true);
    const recordUserMessageDeliveredToAgentQueue = vi.fn();
    const socketEmit = vi.fn();
    const api = createSessionClientTranscriptApi({
        token: 'token',
        sessionId: 'session-1',
        outboundShapeLogger: { log: vi.fn() },
        getSocket: () => ({
            connected: params?.connected ?? false,
            emit: socketEmit,
        }),
        getLatestTurnSnapshot: params?.getLatestTurnSnapshot ?? (() => null),
        getActiveLocalTurnProgressAt: params?.getActiveLocalTurnProgressAt ?? (() => null),
        getSessionConnectionSupervisor: () => null,
        getMetadataSnapshot: () => null,
        updateAgentState: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
        enqueueSessionEndMutation: vi.fn(async () => undefined),
        createSessionEndMutation: () => ({ type: 'session-end', sessionId: 'session-1', createdAt: 1 }) as never,
        enqueueCommittedTranscriptMessage: vi.fn(async () => ({ persisted: true, delivered: true })),
        usageObservationPublisher: {
            publish: vi.fn(),
        },
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
        deliverUserMessageToAgentQueue,
        getTranscriptQueryContext: () => ({
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
        }),
        transformSessionInputBeforeCommit: params?.transformSessionInputBeforeCommit,
    } as Parameters<typeof createSessionClientTranscriptApi>[0]);

    return {
        api,
        commitSessionMessage,
        deliverUserMessageToAgentQueue,
        recordUserMessageDeliveredToAgentQueue,
        socketEmit,
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

    it('self-heals terminal thinking after 15 seconds when the active local turn has no recent progress', () => {
        vi.useFakeTimers();
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
        vi.useRealTimers();
    });

    it('applies session.input.transform before committing and handing user input to the agent queue', async () => {
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
            deliverUserMessageToAgentQueue,
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
        expect(commitSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
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
            localId: 'local-1',
            messageRole: 'user',
            markAsUserMessage: true,
        }));
        expect(deliverUserMessageToAgentQueue).toHaveBeenCalledWith(expect.objectContaining({
            content: { type: 'text', text: 'original [transformed]' },
            meta: expect.objectContaining({
                transformedBy: 'fixture.plugin',
            }),
        }));
        expect(recordUserMessageDeliveredToAgentQueue).toHaveBeenCalledWith(42);
    });
});
