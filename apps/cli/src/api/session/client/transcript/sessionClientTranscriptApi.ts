import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { isActiveLatestTurnStatus } from '../../sessionTurnStatusSnapshot';
import { deriveVoiceAgentTurnLocalId, readVoiceAgentTurnPayloadFromMeta, validatePluginHookPayloadV1 } from '@happier-dev/protocol';
import type { PrimaryTurnStatusV1, SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';

import type {
    AgentState,
    Metadata,
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
import { isDefinitiveSessionMessageCommitError } from '../transport/createSessionClientCommitQueueRuntime';
import type { EphemeralSendOutcome } from './ephemeralSendOutcome';

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
    provenance: SessionTranscriptObservationProvenanceV1;
}>;

type EnqueueCommittedVoiceAgentTranscriptTurnParams = Readonly<{
    turnId: string;
    user: EnqueueCommittedTranscriptMessageParams;
    assistant: EnqueueCommittedTranscriptMessageParams;
    observedAt: number;
}>;

export type VoiceAgentTranscriptTurnCommitParams = Readonly<{
    turnId: string;
    user: Readonly<{ text: string; localId: string; meta: Record<string, unknown> }>;
    assistant: Readonly<{ text: string; localId: string; meta: Record<string, unknown> }>;
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
    getEphemeralStreamConnectionEpoch?: () => number;
    getSessionConnectionSupervisor: () => ManagedConnectionSupervisor | null;
    getLatestTurnSnapshot: () => Readonly<{
        status: PrimaryTurnStatusV1;
        observedAt: number;
    }> | null;
    getActiveLocalTurnProgressAt: () => number | null;
    getMetadataSnapshot: () => Metadata | null;
    updateAgentState: (handler: (metadata: AgentState) => AgentState) => Promise<void>;
    updateMetadata: (handler: (metadata: Metadata) => Metadata) => Promise<void>;
    enqueueCommittedTranscriptMessage: (params: EnqueueCommittedTranscriptMessageParams) => Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
    }>>;
    enqueueCommittedVoiceAgentTranscriptTurn: (
        params: EnqueueCommittedVoiceAgentTranscriptTurnParams,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
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
    markAgentQueueEchoSuppressedLocalId: (localId: string) => void;
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
    maxToolCallCacheEntries?: number | undefined;
    transformSessionInputBeforeCommit?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
    enqueuePendingUserMessage: (params: Readonly<{
        localId: string;
        message: PlainOrEncryptedPayload;
        requestedAction: Readonly<{ v: 1; kind: 'enqueue' }>;
    }>) => Promise<void>;
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
        opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    enqueueVoiceAgentTranscriptTurnCommitted: (
        provider: ACPProvider,
        params: VoiceAgentTranscriptTurnCommitParams,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    sendAgentSessionMediaCommitted: (
        provider: ACPProvider,
        request: SendAgentSessionMediaCommittedRequest,
    ) => Promise<void>;
    sendAgentMessageEphemeral: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
    ) => EphemeralSendOutcome;
    sendAgentMessageEphemeralDelta: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
    ) => EphemeralSendOutcome;
    fetchRecentTranscriptTextItemsForAcpImport: (
        opts?: { take?: number },
    ) => Promise<Array<{ role: 'user' | 'agent'; text: string }>>;
    fetchLatestUserPermissionIntentFromTranscript: (
        opts?: { take?: number },
    ) => Promise<{ intent: import('../../../types').PermissionMode; updatedAt: number } | null>;
    sendSessionEvent: (event: SessionEventMessage, id?: string) => void;
    keepAlive: (thinking: boolean, mode: SessionAliveMode) => void;
    replayLatestPresence: () => void;
}>;

export function createSessionClientTranscriptApi(
    deps: SessionClientTranscriptApiDeps,
): SessionClientTranscriptApi {
    let latestSessionPresence: SessionPresenceSnapshot | null = null;
    let hasPublishedSessionPresence = false;
    let terminalThinkingEvidenceAtMs: number | null = null;
    let reportedTerminalThinkingSelfHeal = false;

    const resolveKeepAliveThinkingWithTerminalGuard = (thinking: boolean, nowMs: number): boolean => {
        if (!thinking) {
            terminalThinkingEvidenceAtMs = null;
            reportedTerminalThinkingSelfHeal = false;
            return false;
        }
        const turn = deps.getLatestTurnSnapshot();
        const progressAt = deps.getActiveLocalTurnProgressAt();
        if (!turn || isActiveLatestTurnStatus(turn.status)) {
            terminalThinkingEvidenceAtMs = null;
            reportedTerminalThinkingSelfHeal = false;
            return true;
        }

        const normalizeEvidenceAt = (value: unknown): number | null =>
            typeof value === 'number' && Number.isFinite(value)
                ? Math.min(nowMs, Math.max(0, value))
                : null;
        const latestEvidenceAt = Math.max(
            normalizeEvidenceAt(turn.observedAt) ?? 0,
            normalizeEvidenceAt(progressAt) ?? 0,
        );
        if (terminalThinkingEvidenceAtMs === null) {
            terminalThinkingEvidenceAtMs = latestEvidenceAt > 0 ? latestEvidenceAt : nowMs;
        } else if (latestEvidenceAt > terminalThinkingEvidenceAtMs) {
            terminalThinkingEvidenceAtMs = latestEvidenceAt;
            reportedTerminalThinkingSelfHeal = false;
        }
        if (nowMs - terminalThinkingEvidenceAtMs < 15_000) return true;
        if (!reportedTerminalThinkingSelfHeal) {
            reportedTerminalThinkingSelfHeal = true;
            logger.info('[API] Self-healing stuck thinking keepalive against terminal turn status', {
                sessionId: deps.sessionId,
                latestTurnStatus: turn.status,
                latchedForMs: nowMs - terminalThinkingEvidenceAtMs,
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
        getEphemeralStreamConnectionEpoch: () => deps.getEphemeralStreamConnectionEpoch?.() ?? 0,
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
        applyAcpPostSendReactions(getPostSendReactionPort(), {
            provider,
            normalizedBody,
            localId,
        });
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
        } catch {
            logger.debug('[plugins] session.input.transform failed; using original input');
            return { text: payload.text, meta: payload.meta };
        }
    };

    const enqueueAgentMessageCommitted = async (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
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
            provenance: opts.provenance,
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
        applyAcpPostSendReactions(getPostSendReactionPort(), {
            provider,
            normalizedBody,
            localId,
        });
        return result;
    };

    const enqueueVoiceAgentTranscriptTurnCommitted = async (
        provider: ACPProvider,
        params: VoiceAgentTranscriptTurnCommitParams,
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> => {
        const user = prepareCommittedUserTextMessageViaPort(
            getTranscriptSendPort(),
            params.user.text,
            { localId: params.user.localId, meta: params.user.meta },
        );
        const assistant = prepareCommittedAgentMessageViaPort(
            getTranscriptSendPort(),
            provider,
            { type: 'message', message: params.assistant.text },
            { localId: params.assistant.localId, meta: params.assistant.meta },
        );
        const userTurn = readVoiceAgentTurnPayloadFromMeta(params.user.meta);
        const assistantTurn = readVoiceAgentTurnPayloadFromMeta(params.assistant.meta);
        const userCreatedAt = userTurn?.ts ?? Date.now();
        const assistantCreatedAt = assistantTurn?.ts ?? userCreatedAt;
        const result = await deps.enqueueCommittedVoiceAgentTranscriptTurn({
            turnId: params.turnId,
            user: {
                message: user.payload,
                localId: user.localId,
                sidechainId: null,
                messageRole: 'user',
                createdAt: userCreatedAt,
                updatedAt: userCreatedAt,
                provenance: { kind: 'non_dependent', source: 'sidechain' },
            },
            assistant: {
                message: assistant.payload,
                localId: assistant.localId,
                sidechainId: assistant.sidechainId,
                messageRole: assistant.messageRole,
                createdAt: assistantCreatedAt,
                updatedAt: assistantCreatedAt,
                provenance: { kind: 'non_dependent', source: 'sidechain' },
            },
            observedAt: Math.max(userCreatedAt, assistantCreatedAt),
        });

        if (result.delivered) {
            const extracted = extractAssistantTextSnapshotFromAcpMessage(provider, assistant.normalizedBody);
            if (extracted) {
                deps.turnAssistantTextSnapshotStore?.observe({
                    text: extracted.text,
                    provider: extracted.provider,
                    sidechainId: extracted.sidechainId,
                    localId: assistant.localId,
                    source: 'committed',
                });
            }
        }
        applyAcpPostSendReactions(getPostSendReactionPort(), {
            provider,
            normalizedBody: assistant.normalizedBody,
            localId: assistant.localId,
        });
        return result;
    };

    return {
        sendProviderMessage(request) {
            const update = dispatchProviderTranscriptMessage(getTranscriptSendPort(), request, {
                sessionId: deps.sessionId,
                postSendReactionPort: getPostSendReactionPort(),
            }).catch(() => {
                logger.debug('[SOCKET] Failed to dispatch provider transcript message (non-fatal)');
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

            const { payload } = prepareCommittedUserTextMessageViaPort(
                getTranscriptSendPort(),
                text,
                {
                    localId,
                    meta: transformed.meta,
                },
            );
            await deps.enqueuePendingUserMessage({
                localId,
                message: payload,
                requestedAction: { v: 1, kind: 'enqueue' },
            });
        },

        sendAgentMessageCommitted,
        enqueueAgentMessageCommitted,
        enqueueVoiceAgentTranscriptTurnCommitted,

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
            return sendAgentMessageEphemeralViaPort(getTranscriptSendPort(), provider, body, opts);
        },

        sendAgentMessageEphemeralDelta(provider, body, opts) {
            return sendAgentMessageEphemeralDeltaViaPort(getTranscriptSendPort(), provider, body, opts);
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
            const didPublish = emitSessionAlive(
                createSessionAlivePayload(latestSessionPresence),
                { volatileWhenIdle: hasPublishedSessionPresence },
            );
            if (didPublish) {
                hasPublishedSessionPresence = true;
            }
        },

        replayLatestPresence() {
            if (!latestSessionPresence) return;
            const didPublish = emitSessionAlive(
                createSessionAlivePayload(latestSessionPresence),
                { volatileWhenIdle: false },
            );
            if (didPublish) {
                hasPublishedSessionPresence = true;
            }
        },

    };
}
