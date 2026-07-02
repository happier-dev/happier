import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { deriveVoiceAgentTurnLocalId, readVoiceAgentTurnPayloadFromMeta } from '@happier-dev/protocol';
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

export type SessionClientTranscriptApiDeps = Readonly<{
    token: string;
    sessionId: string;
    turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
    outboundShapeLogger: {
        log: (label: string, payload: unknown) => void;
    };
    getSocket: () => {
        connected: boolean;
        emit: (event: 'session-alive' | 'session-end' | 'transcript-stream-segment', payload: unknown) => void;
        volatile?: {
            emit?: (event: 'session-alive', payload: unknown) => void;
        };
    };
    getSessionConnectionSupervisor: () => ManagedConnectionSupervisor | null;
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
    }>) => void;
    enqueueMessageCommit: <T>(fn: () => Promise<T>) => Promise<T>;
    commitSessionMessage: (params: CommitSessionMessageParams) => Promise<void>;
    logSendWhileDisconnected: (context: string, details?: Record<string, unknown>) => void;
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
    deliverUserMessageToAgentQueue: (prompt: UserMessage) => void;
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
    sendUserTextMessage: (text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) => void;
    sendUserTextMessageCommitted: (
        text: string,
        opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<void>;
    enqueueSessionUserMessage: (params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
    }>) => void;
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
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
    ) => void;
    fetchRecentTranscriptTextItemsForAcpImport: (
        opts?: { take?: number },
    ) => Promise<Array<{ role: 'user' | 'agent'; text: string }>>;
    fetchLatestUserPermissionIntentFromTranscript: (
        opts?: { take?: number },
    ) => Promise<{ intent: import('../../../types').PermissionMode; updatedAt: number } | null>;
    sendSessionEvent: (event: SessionEventMessage, id?: string) => void;
    keepAlive: (thinking: boolean, mode: 'local' | 'remote') => void;
    sendSessionDeath: () => void;
}>;

export function createSessionClientTranscriptApi(
    deps: SessionClientTranscriptApiDeps,
): SessionClientTranscriptApi {
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
        opts?: { localId?: string; meta?: Record<string, unknown> },
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
            void dispatchProviderTranscriptMessage(getTranscriptSendPort(), request, {
                sessionId: deps.sessionId,
                postSendReactionPort: getPostSendReactionPort(),
            }).catch((error) => {
                logger.debug('[SOCKET] Failed to dispatch provider transcript message (non-fatal)', { error });
            });
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
            const { payload, localId } = prepareCommittedUserTextMessageViaPort(
                getTranscriptSendPort(),
                text,
                opts,
            );
            deps.markAgentQueueEchoSuppressedLocalId(localId);
            await deps.enqueueMessageCommit(() =>
                deps.commitSessionMessage({
                    message: payload,
                    localId,
                    sidechainId: null,
                    messageRole: 'user',
                    requireCommit: true,
                    markAsUserMessage: true,
                }),
            );
        },

        enqueueSessionUserMessage(params) {
            const text = String(params.text ?? '');
            if (text.length === 0) return;
            const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();

            const meta: Record<string, unknown> = params.meta && typeof params.meta === 'object' ? { ...params.meta } : {};
            if (typeof meta.source !== 'string' || meta.source.trim().length === 0) {
                meta.source = 'ui';
            }
            if (typeof meta.sentFrom !== 'string' || meta.sentFrom.trim().length === 0) {
                meta.sentFrom = 'ui';
            }

            const prompt = {
                role: 'user',
                content: { type: 'text', text },
                localId,
                meta,
                createdAt: Date.now(),
            } satisfies UserMessage;

            deps.deliverUserMessageToAgentQueue(prompt);
            deps.markAgentQueueEchoSuppressedLocalId(localId);
            sendUserTextMessage(text, { localId, meta });
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
            const socket = deps.getSocket();
            const payload = {
                sid: deps.sessionId,
                time: Date.now(),
                thinking,
                mode,
            };

            if (thinking) {
                if (!socket.connected) {
                    return;
                }
                socket.emit('session-alive', payload);
                return;
            }

            if (!socket.connected) {
                return;
            }

            const volatileEmit = socket.volatile?.emit;
            if (typeof volatileEmit === 'function') {
                volatileEmit.call(socket.volatile, 'session-alive', payload);
                return;
            }

            socket.emit('session-alive', payload);
        },

        sendSessionDeath() {
            const observedAt = Date.now();
            void deps.enqueueSessionEndMutation(deps.createSessionEndMutation(observedAt)).catch((error) => {
                logger.debug('[API] Failed to enqueue session-end mutation (non-fatal)', { error });
            });
        },
    };
}
