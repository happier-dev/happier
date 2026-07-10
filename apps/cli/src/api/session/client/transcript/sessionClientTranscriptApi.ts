import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { isActiveLatestTurnStatus } from '../../sessionTurnStatusSnapshot';
import { deriveVoiceAgentTurnLocalId, readVoiceAgentTurnPayloadFromMeta, validatePluginHookPayloadV1 } from '@happier-dev/protocol';
import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import type {
    AgentState,
    Metadata,
    UserMessage,
} from '../../../types';
import {
    fetchLatestUserPermissionIntentFromEncryptedTranscript,
    fetchRecentTranscriptTextItemsForAcpImportFromServer,
} from '../../transcriptQueries';
import type {
    ACPMessageData,
    ACPProvider,
    SessionEventMessage,
} from '../../sessionMessageTypes';
import { shouldTraceAcpMessageType } from '../../acpMessageEnvelope';
import {
    isToolTraceEnabled,
    recordAcpToolTraceEventIfNeeded,
} from '../../toolTrace';
import {
    sendAgentMessageEphemeralDeltaViaPort,
    sendAgentMessageEphemeralViaPort,
    sendAgentMessageViaPort,
    sendSessionEventViaPort,
    sendUserTextMessageViaPort,
    type SessionClientTranscriptSendPort,
} from './sendMessages';
import {
    prepareCommittedAgentMessageViaPort,
    prepareCommittedUserTextMessageViaPort,
} from './commitMessages';
import { applyAcpPostSendReactions } from '../reactions/postSendReactions';
import type { PostSendReactionPort } from '../reactions/providers/postSendReactionPort';
import type { SessionUsageObservationPublisher } from '../reactions/usagePublishing';
import {
    dispatchProviderTranscriptMessage,
    type ProviderTranscriptDispatchRequest,
} from './providerDispatch';
import { extractAssistantTextSnapshotFromAcpMessage } from '../../turns/extractAssistantTextSnapshot';
import type { TurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshot';
import {
    garbageCollectFailedSessionMediaCommit,
    persistSessionMediaForTranscript,
    type SendAgentSessionMediaCommittedRequest,
} from './sessionMediaBridge';
import type {
    SessionEndMutationV1,
} from '../transport/mutations/sessionClientDurableMutationTypes';
import { isDefinitiveSessionMessageCommitError } from '../transport/createSessionClientCommitQueueRuntime';

type PlainOrEncryptedPayload = string | { t: 'plain'; v: unknown };
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';
type SessionEventType = 'ready';

type CommitSessionMessageParams = Readonly<{
    message: PlainOrEncryptedPayload;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole;
    sessionEventType?: SessionEventType;
    requireCommit: boolean;
    markAsUserMessage?: boolean;
    refreshAgentQueueEchoSuppression?: boolean;
}>;

type EnqueueCommittedTranscriptMessageParams = Readonly<{
    message: PlainOrEncryptedPayload;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole;
    sessionEventType?: SessionEventType;
    createdAt: number;
    updatedAt: number;
}>;

type SessionAliveMode = 'local' | 'remote';
type SessionAlivePayload = Readonly<{
    sid: string;
    time: number;
    thinking: boolean;
    mode: SessionAliveMode;
    latestTurnStatus?: PrimaryTurnStatusV1;
    latestTurnStatusObservedAt?: number;
}>;
type SessionPresenceSnapshot = Readonly<{
    thinking: boolean;
    mode: SessionAliveMode;
}>;

export type SessionClientTranscriptApiDeps = Readonly<{
    token: string;
    sessionId: string;
    turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
    outboundShapeLogger: {
        log: (label: string, payload: unknown) => void;
    };
    getSocket: () => {
        connected: boolean;
        emit: (event: 'session-alive' | 'session-end' | 'transcript-stream-segment' | 'transcript-stream-segment-delta', payload: unknown) => void;
        volatile?: {
            emit?: (event: 'session-alive', payload: unknown) => void;
        };
    };
    getSessionConnectionSupervisor: () => ManagedConnectionSupervisor | null;
    getLatestTurnSnapshot: () => Readonly<{
        status: PrimaryTurnStatusV1;
        observedAt: number;
    }> | null;
    getActiveLocalTurnProgressAt: () => number | null;
    getMetadataSnapshot: () => Metadata | null;
    updateAgentState: (handler: (metadata: AgentState) => AgentState) => Promise<void>;
    updateMetadata: (handler: (metadata: Metadata) => Metadata) => Promise<void>;
    enqueueSessionEndMutation: (mutation: SessionEndMutationV1) => Promise<void>;
    createSessionEndMutation: (observedAt: number) => SessionEndMutationV1;
    enqueueCommittedTranscriptMessage: (params: EnqueueCommittedTranscriptMessageParams) => Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    usageObservationPublisher: SessionUsageObservationPublisher;
    buildOutboundSessionMessagePayload: (content: unknown) => PlainOrEncryptedPayload;
    commitSessionMessageBestEffort: (params: Readonly<{
        message: PlainOrEncryptedPayload;
        localId: string;
        sidechainId: string | null;
        logErrorMessage: string;
        messageRole: SessionMessageRole;
        sessionEventType?: SessionEventType;
        markAsUserMessage?: boolean;
        refreshAgentQueueEchoSuppression?: boolean;
    }>) => Promise<void>;
    enqueueMessageCommit: <T>(fn: () => Promise<T>) => Promise<T>;
    trackProviderTranscriptDispatch?: (update: Promise<unknown>) => void;
    commitSessionMessage: (params: CommitSessionMessageParams) => Promise<void>;
    logSendWhileDisconnected: (context: string, details?: Record<string, unknown>) => void;
    hasAgentQueueEchoSuppressedLocalId: (localId: string) => boolean;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    clearAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    markAgentQueueDeliveredLocalId: (localId: string) => void;
    clearAgentQueueDeliveredLocalId: (localId: string) => void;
    getCommittedUserMessageSeq: (localId: string) => number | null;
    recordUserMessageDeliveredToAgentQueue: (seq: number) => void;
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
    maxToolCallCacheEntries?: number | undefined;
    transformSessionInputBeforeCommit?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
    deliverUserMessageToAgentQueue: (prompt: UserMessage) => boolean;
    getTranscriptQueryContext: () => Readonly<{
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
    }>;
}>;

export type SessionClientTranscriptApi = Readonly<{
    sendProviderMessage: (request: ProviderTranscriptDispatchRequest) => void;
    sendAgentMessage: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) => void;
    sendUserTextMessage: (text: string, opts?: { localId?: string; meta?: Record<string, unknown>; refreshAgentQueueEchoSuppression?: boolean }) => void;
    sendUserTextMessageCommitted: (
        text: string,
        opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<void>;
    enqueueSessionUserMessage: (params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
    }>) => Promise<void>;
    sendAgentMessageCommitted: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<void>;
    enqueueAgentMessageCommitted: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    sendAgentSessionMediaCommitted: (
        provider: ACPProvider,
        request: SendAgentSessionMediaCommittedRequest,
    ) => Promise<void>;
    sendAgentMessageEphemeral: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
    ) => void;
    sendAgentMessageEphemeralDelta: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
    ) => void;
    fetchRecentTranscriptTextItemsForAcpImport: (
        opts?: { take?: number },
    ) => Promise<Array<{ role: 'user' | 'agent'; text: string }>>;
    fetchLatestUserPermissionIntentFromTranscript: (
        opts?: { take?: number },
    ) => Promise<{ intent: import('../../../types').PermissionMode; updatedAt: number } | null>;
    sendSessionEvent: (event: SessionEventMessage, id?: string) => void;
    keepAlive: (thinking: boolean, mode: SessionAliveMode) => void;
    replayLatestPresence: () => void;
    sendSessionDeath: () => void;
}>;

export function createSessionClientTranscriptApi(
    deps: SessionClientTranscriptApiDeps,
): SessionClientTranscriptApi {
    let latestSessionPresence: SessionPresenceSnapshot | null = null;
    let terminalThinkingSinceMs: number | null = null;
    let reportedTerminalThinkingSelfHeal = false;

    const resolveKeepAliveThinkingWithTerminalGuard = (thinking: boolean, nowMs: number): boolean => {
        if (!thinking) {
            terminalThinkingSinceMs = null;
            reportedTerminalThinkingSelfHeal = false;
            return false;
        }
        const turn = deps.getLatestTurnSnapshot();
        const progressAt = deps.getActiveLocalTurnProgressAt();
        const hasFreshLocalProgress = progressAt !== null && nowMs - progressAt < 15_000;
        if (!turn || isActiveLatestTurnStatus(turn.status) || hasFreshLocalProgress) {
            terminalThinkingSinceMs = null;
            return true;
        }
        terminalThinkingSinceMs ??= nowMs;
        if (nowMs - terminalThinkingSinceMs < 15_000) return true;
        if (!reportedTerminalThinkingSelfHeal) {
            reportedTerminalThinkingSelfHeal = true;
            logger.info('[API] Self-healing stuck thinking keepalive against terminal turn status', {
                sessionId: deps.sessionId,
                latestTurnStatus: turn.status,
                latchedForMs: nowMs - terminalThinkingSinceMs,
            });
        }
        return false;
    };

    const createSessionAlivePayload = (presence: SessionPresenceSnapshot): SessionAlivePayload => {
        const payload: SessionAlivePayload = {
            sid: deps.sessionId,
            time: Date.now(),
            thinking: presence.thinking,
            mode: presence.mode,
        };
        const turn = deps.getLatestTurnSnapshot();
        return turn
            ? {
                ...payload,
                latestTurnStatus: turn.status,
                latestTurnStatusObservedAt: turn.observedAt,
            }
            : payload;
    };

    const emitSessionAlive = (
        payload: SessionAlivePayload,
        { volatileWhenIdle }: { volatileWhenIdle: boolean },
    ): boolean => {
        const socket = deps.getSocket();
        if (!socket.connected) return false;

        if (payload.thinking || !volatileWhenIdle) {
            socket.emit('session-alive', payload);
            return true;
        }

        const volatileEmit = socket.volatile?.emit;
        if (typeof volatileEmit === 'function') {
            volatileEmit.call(socket.volatile, 'session-alive', payload);
            return true;
        }

        socket.emit('session-alive', payload);
        return true;
    };

    const getTranscriptSendPort = (): SessionClientTranscriptSendPort => ({
        sessionId: deps.sessionId,
        turnAssistantTextSnapshotStore: deps.turnAssistantTextSnapshotStore,
        socket: {
            connected: deps.getSocket().connected,
            emit: (event, payload) => {
                deps.getSocket().emit(event, payload);
            },
        },
        outboundShapeLogger: deps.outboundShapeLogger,
        debug: (message, data) => logger.debug(message, data),
        debugLargeJson: (message, data) => logger.debugLargeJson(message, data),
        getMetadataSnapshot: () => deps.getMetadataSnapshot(),
        buildOutboundSessionMessagePayload: (content) => deps.buildOutboundSessionMessagePayload(content),
        commitSessionMessageBestEffort: (params) => deps.commitSessionMessageBestEffort(params),
        logSendWhileDisconnected: (context, details) => deps.logSendWhileDisconnected(context, details),
        markAgentQueueEchoSuppressedLocalId: (localId) => deps.markAgentQueueEchoSuppressedLocalId(localId),
        toolCallCanonicalNameByProviderAndId: deps.toolCallCanonicalNameByProviderAndId,
        permissionToolCallRawInputByProviderAndId: deps.permissionToolCallRawInputByProviderAndId,
        toolCallInputByProviderAndId: deps.toolCallInputByProviderAndId,
        maxToolCallCacheEntries: deps.maxToolCallCacheEntries,
    });

    const getPostSendReactionPort = (): PostSendReactionPort => ({
        sessionId: deps.sessionId,
        updateAgentState: (updater) => deps.updateAgentState(updater),
        updateMetadata: (updater) => deps.updateMetadata(updater),
        getMetadataSnapshot: () => deps.getMetadataSnapshot(),
        usageObservationPublisher: deps.usageObservationPublisher,
    });

    const sendUserTextMessage = (
        text: string,
        opts?: { localId?: string; meta?: Record<string, unknown>; refreshAgentQueueEchoSuppression?: boolean },
    ): void => {
        sendUserTextMessageViaPort(getTranscriptSendPort(), text, opts);
    };

    const sendAgentMessageCommitted = async (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> => {
        const { normalizedBody, payload, localId, sidechainId, messageRole } = prepareCommittedAgentMessageViaPort(
            getTranscriptSendPort(),
            provider,
            body,
            opts,
        );

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: deps.sessionId, provider, body: normalizedBody, localId });
        }

        await deps.enqueueMessageCommit(() =>
            deps.commitSessionMessage({ message: payload, localId, sidechainId, messageRole, requireCommit: true }),
        );
        const extracted = extractAssistantTextSnapshotFromAcpMessage(provider, normalizedBody);
        if (extracted) {
            deps.turnAssistantTextSnapshotStore?.observe({
                text: extracted.text,
                provider: extracted.provider,
                sidechainId: extracted.sidechainId,
                localId,
                source: 'committed',
            });
        }
    };

    const commitUserTextMessage = async (
        text: string,
        opts: { localId: string; meta?: Record<string, unknown>; refreshAgentQueueEchoSuppression: boolean },
    ): Promise<void> => {
        const { payload, localId } = prepareCommittedUserTextMessageViaPort(
            getTranscriptSendPort(),
            text,
            opts,
        );
        if (opts.refreshAgentQueueEchoSuppression) {
            deps.markAgentQueueEchoSuppressedLocalId(localId);
        }
        await deps.enqueueMessageCommit(() =>
            deps.commitSessionMessage({
                message: payload,
                localId,
                sidechainId: null,
                messageRole: 'user',
                requireCommit: true,
                markAsUserMessage: true,
                refreshAgentQueueEchoSuppression: opts.refreshAgentQueueEchoSuppression,
            }),
        );
    };

    const commitUserTextMessageBeforeAgentQueueHandoff = async (
        text: string,
        prompt: UserMessage,
        opts: { localId: string; meta: Record<string, unknown>; failureLogMessage: string },
    ): Promise<void> => {
        const { localId, meta } = opts;
        try {
            await commitUserTextMessage(text, {
                localId,
                meta,
                refreshAgentQueueEchoSuppression: false,
            });
        } catch (error) {
            deps.clearAgentQueueEchoSuppressedLocalId(localId);
            deps.clearAgentQueueDeliveredLocalId(localId);
            logger.debug(opts.failureLogMessage, { error });
            return;
        }

        if (deps.hasAgentQueueEchoSuppressedLocalId(localId)) {
            return;
        }

        const deliveredToAgentQueue = deps.deliverUserMessageToAgentQueue(prompt);
        if (deliveredToAgentQueue) {
            deps.markAgentQueueEchoSuppressedLocalId(localId);
            deps.markAgentQueueDeliveredLocalId(localId);
            const committedSeq = deps.getCommittedUserMessageSeq(localId);
            if (committedSeq !== null) {
                deps.recordUserMessageDeliveredToAgentQueue(committedSeq);
            }
        } else {
            deps.clearAgentQueueEchoSuppressedLocalId(localId);
            deps.clearAgentQueueDeliveredLocalId(localId);
        }
    };

    const transformSessionInputPayloadBeforeCommit = async (
        payload: Readonly<{
            localId: string;
            text: string;
            meta: Record<string, unknown>;
            timestampMs: number;
        }>,
    ): Promise<Readonly<{
        text: string;
        meta: Record<string, unknown>;
    }>> => {
        if (!deps.transformSessionInputBeforeCommit) {
            return { text: payload.text, meta: payload.meta };
        }
        try {
            const transformed = await deps.transformSessionInputBeforeCommit({
                sessionId: deps.sessionId,
                localId: payload.localId,
                text: payload.text,
                meta: payload.meta,
                timestampMs: payload.timestampMs,
            });
            const validation = validatePluginHookPayloadV1({
                hookId: 'session.input.transform',
                payload: transformed,
            });
            if (!validation.success) {
                logger.debug('[plugins] session.input.transform returned an invalid payload; using original input', {
                    error: validation.message,
                });
                return { text: payload.text, meta: payload.meta };
            }
            const parsed = validation.payload as Record<string, unknown>;
            const transformedMeta = parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)
                ? parsed.meta as Record<string, unknown>
                : payload.meta;
            return {
                text: typeof parsed.text === 'string' ? parsed.text : payload.text,
                meta: transformedMeta,
            };
        } catch (error) {
            logger.debug('[plugins] session.input.transform failed; using original input', { error });
            return { text: payload.text, meta: payload.meta };
        }
    };

    const enqueueAgentMessageCommitted = async (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> => {
        const { normalizedBody, payload, localId, sidechainId, messageRole } = prepareCommittedAgentMessageViaPort(
            getTranscriptSendPort(),
            provider,
            body,
            opts,
        );

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: deps.sessionId, provider, body: normalizedBody, localId });
        }

        const streamSegmentMeta = opts.meta?.happierStreamSegmentV1;
        const metaRecord = streamSegmentMeta && typeof streamSegmentMeta === 'object'
            ? streamSegmentMeta as Record<string, unknown>
            : null;
        const createdAt =
            metaRecord && typeof metaRecord.startedAtMs === 'number' && Number.isFinite(metaRecord.startedAtMs)
                ? Math.max(0, Math.trunc(metaRecord.startedAtMs))
                : Date.now();
        const updatedAt =
            metaRecord && typeof metaRecord.updatedAtMs === 'number' && Number.isFinite(metaRecord.updatedAtMs)
                ? Math.max(createdAt, Math.trunc(metaRecord.updatedAtMs))
                : createdAt;
        const result = await deps.enqueueCommittedTranscriptMessage({
            message: payload,
            localId,
            sidechainId,
            messageRole,
            createdAt,
            updatedAt,
        });
        if (result.delivered) {
            const extracted = extractAssistantTextSnapshotFromAcpMessage(provider, normalizedBody);
            if (extracted) {
                deps.turnAssistantTextSnapshotStore?.observe({
                    text: extracted.text,
                    provider: extracted.provider,
                    sidechainId: extracted.sidechainId,
                    localId,
                    source: 'committed',
                });
            }
        }
        return result;
    };

    return {
        sendProviderMessage(request) {
            const update = dispatchProviderTranscriptMessage(getTranscriptSendPort(), request, {
                sessionId: deps.sessionId,
                postSendReactionPort: getPostSendReactionPort(),
            }).catch((error) => {
                logger.debug('[SOCKET] Failed to dispatch provider transcript message (non-fatal)', { error });
            });
            deps.trackProviderTranscriptDispatch?.(update);
            void update;
        },

        sendAgentMessage(provider, body, opts) {
            const { normalizedBody, localId } = sendAgentMessageViaPort(getTranscriptSendPort(), provider, body, opts);

            if (shouldTraceAcpMessageType(normalizedBody.type, { includeTaskComplete: true })) {
                recordAcpToolTraceEventIfNeeded({
                    sessionId: deps.sessionId,
                    provider,
                    body: normalizedBody,
                    localId,
                });
            }

            applyAcpPostSendReactions(getPostSendReactionPort(), {
                provider,
                normalizedBody,
                localId,
            });
        },

        sendUserTextMessage,

        async sendUserTextMessageCommitted(text, opts) {
            await commitUserTextMessage(text, {
                ...opts,
                refreshAgentQueueEchoSuppression: true,
            });
        },

        async enqueueSessionUserMessage(params) {
            const originalText = String(params.text ?? '');
            if (originalText.length === 0) return;
            const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();

            const meta: Record<string, unknown> = params.meta && typeof params.meta === 'object' ? { ...params.meta } : {};
            if (typeof meta.source !== 'string' || meta.source.trim().length === 0) {
                meta.source = 'ui';
            }
            if (typeof meta.sentFrom !== 'string' || meta.sentFrom.trim().length === 0) {
                meta.sentFrom = 'ui';
            }
            const createdAt = Date.now();
            const transformed = await transformSessionInputPayloadBeforeCommit({
                localId,
                text: originalText,
                meta,
                timestampMs: createdAt,
            });
            const text = transformed.text;

            const prompt = {
                role: 'user',
                content: { type: 'text', text },
                localId,
                meta: transformed.meta,
                createdAt,
            } satisfies UserMessage;

            if (transformed.meta.source === 'daemon-initial-prompt') {
                await commitUserTextMessageBeforeAgentQueueHandoff(text, prompt, {
                    localId,
                    meta: transformed.meta,
                    failureLogMessage: '[SOCKET] Failed to commit daemon initial prompt before provider handoff',
                });
                return;
            }

            await commitUserTextMessageBeforeAgentQueueHandoff(text, prompt, {
                localId,
                meta: transformed.meta,
                failureLogMessage: '[SOCKET] Failed to commit session user prompt before provider handoff',
            });
        },

        sendAgentMessageCommitted,
        enqueueAgentMessageCommitted,

        async sendAgentSessionMediaCommitted(provider, request) {
            const workingDirectory = deps.getMetadataSnapshot()?.path;
            const persisted = await persistSessionMediaForTranscript({
                sessionId: deps.sessionId,
                workingDirectory,
                request,
                logger,
            });
            const messageText = request.messageText ?? '';

            try {
                await sendAgentMessageCommitted(
                    provider,
                    { type: 'message', message: messageText },
                    {
                        localId: request.localId,
                        meta: persisted.meta,
                    },
                );
            } catch (error) {
                if (
                    isDefinitiveSessionMessageCommitError(error)
                    &&
                    typeof workingDirectory === 'string'
                    && workingDirectory.trim().length > 0
                    && persisted.createdWorkspaceRelativePaths.length > 0
                ) {
                    await garbageCollectFailedSessionMediaCommit({
                        workingDirectory,
                        persisted,
                        logger,
                    });
                }
                throw error;
            }
            if (messageText.trim().length === 0) {
                deps.turnAssistantTextSnapshotStore?.clearSnapshot({ reason: 'media_only_commit' });
            }
        },

        sendAgentMessageEphemeral(provider, body, opts) {
            sendAgentMessageEphemeralViaPort(getTranscriptSendPort(), provider, body, opts);
        },

        sendAgentMessageEphemeralDelta(provider, body, opts) {
            sendAgentMessageEphemeralDeltaViaPort(getTranscriptSendPort(), provider, body, opts);
        },

        async fetchRecentTranscriptTextItemsForAcpImport(opts) {
            const transcriptQueryContext = deps.getTranscriptQueryContext();
            const request = () => fetchRecentTranscriptTextItemsForAcpImportFromServer({
                token: deps.token,
                sessionId: deps.sessionId,
                encryptionKey: transcriptQueryContext.encryptionKey,
                encryptionVariant: transcriptQueryContext.encryptionVariant,
                take: opts?.take,
            });
            const supervisor = deps.getSessionConnectionSupervisor();
            if (!supervisor) {
                return request();
            }
            return runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            });
        },

        async fetchLatestUserPermissionIntentFromTranscript(opts) {
            const transcriptQueryContext = deps.getTranscriptQueryContext();
            const request = () => fetchLatestUserPermissionIntentFromEncryptedTranscript({
                token: deps.token,
                sessionId: deps.sessionId,
                encryptionKey: transcriptQueryContext.encryptionKey,
                encryptionVariant: transcriptQueryContext.encryptionVariant,
                take: opts?.take,
            });
            const supervisor = deps.getSessionConnectionSupervisor();
            if (!supervisor) {
                return request();
            }
            return runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            });
        },

        sendSessionEvent(event, id) {
            sendSessionEventViaPort(getTranscriptSendPort(), event, id);
        },

        keepAlive(thinking, mode) {
            if (process.env.DEBUG) {
                logger.debug(`[API] Sending keep alive message: ${thinking}`);
            }
            latestSessionPresence = { thinking: resolveKeepAliveThinkingWithTerminalGuard(thinking, Date.now()), mode };
            emitSessionAlive(createSessionAlivePayload(latestSessionPresence), { volatileWhenIdle: true });
        },

        replayLatestPresence() {
            if (!latestSessionPresence) return;
            emitSessionAlive(createSessionAlivePayload(latestSessionPresence), { volatileWhenIdle: false });
        },

        sendSessionDeath() {
            const observedAt = Date.now();
            void deps.enqueueSessionEndMutation(deps.createSessionEndMutation(observedAt)).catch((error) => {
                logger.debug('[API] Failed to enqueue session-end mutation (non-fatal)', { error });
            });
        },
    };
}
