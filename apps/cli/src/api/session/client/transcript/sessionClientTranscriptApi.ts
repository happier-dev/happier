import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { isActiveLatestTurnStatus } from '../../sessionTurnStatusSnapshot';
import {
    deriveVoiceAgentTurnLocalId,
    hasRawComposerAttachmentSelectionV1,
    readVoiceAgentTurnPayloadFromMeta,
    validatePluginHookPayloadV1,
    SessionMediaMessageMetaV1Schema,
    type SessionMediaMessageMetaV1,
    type ComposerAttachmentInputV1,
    type ComposerContentHandleV1,
} from '@happier-dev/protocol';
import type {
    PrimaryTurnStatusV1,
    SessionInputRequestV1,
    SessionMessageProvenanceV1,
    SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';
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
    prepareSessionEventMessageViaPort,
    type SessionClientTranscriptSendPort,
} from './sendMessages';
import {
    prepareCommittedAgentMessageViaPort,
    prepareCommittedUserTextMessageViaPort,
} from './commitMessages';
import { applyAcpPostSendReactions } from '../reactions/postSendReactions';
import type { PostSendReactionPort } from '../reactions/providers/postSendReactionPort';
import type { SessionUsageObservationPublisher } from '../reactions/usagePublishing';
import { extractAssistantTextSnapshotFromAcpMessage } from '../../turns/extractAssistantTextSnapshot';
import type { TurnAssistantTextSnapshotStore } from '../../turns/assistantTextSnapshot';
import {
    garbageCollectFailedSessionMediaCommit,
    persistSessionMediaForTranscript,
    type SendAgentSessionMediaCommittedRequest,
} from './sessionMediaBridge';
import { isDefinitiveSessionMessageCommitError } from '../transport/createSessionClientCommitQueueRuntime';
import type { EphemeralSendOutcome } from './ephemeralSendOutcome';
import {
    assertCommittedTranscriptAdmission,
    type CommittedTranscriptAdmission,
    type CommittedTranscriptMessageOptions,
} from '../../transcriptPort';
import {
    admitSessionStructuredInputV1,
    preserveComposerAttachmentSelectionAcrossSessionInputTransformV1,
    type SessionStructuredInputAdmissionPolicyV1,
} from '@/session/services/admitSessionStructuredInputV1';

type PlainOrEncryptedPayload = string | { t: 'plain'; v: unknown };
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';
type SessionEventType = 'ready';

function readSessionMediaMetadata(meta: Readonly<Record<string, unknown>>): Readonly<{
    key: 'happier' | 'happierMedia';
    envelope: SessionMediaMessageMetaV1;
}> | undefined {
    for (const key of ['happierMedia', 'happier'] as const) {
        const parsed = SessionMediaMessageMetaV1Schema.safeParse(meta[key]);
        if (parsed.success) return { key, envelope: parsed.data };
    }
    return undefined;
}

type EnqueueCommittedTranscriptMessageParams = Readonly<{
    message: PlainOrEncryptedPayload;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole;
    sessionEventType?: SessionEventType;
    createdAt: number;
    updatedAt: number;
    provenance: SessionTranscriptObservationProvenanceV1;
    admission?: CommittedTranscriptAdmission;
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

/**
 * Request-local post-admission work from the daemon-owned input transform.
 * It deliberately never becomes part of the Message payload or Session state:
 * the caller retains it only until the exact admission result is known.
 */
export type SessionInputAdmissionSettlement = Readonly<{
    onAccepted: () => Promise<void> | void;
    onDefinitiveAdmissionFailure: () => Promise<void> | void;
    /** Opaque target-daemon claims forwarded only through the Pending accepted fact. */
  stagedMediaHandles?: readonly ComposerContentHandleV1[];
  /** Existing finalizer facts used only to abandon a prepare before PATCH. */
  createdWorkspaceRelativePaths?: readonly string[];
  workingDirectory?: string;
}>;

export type SessionInputTransformBeforeCommitResult =
    | Record<string, unknown>
    | Readonly<{
        transformed: Record<string, unknown>;
        settlement: SessionInputAdmissionSettlement;
    }>;

type NormalizedSessionInputTransformBeforeCommitResult = Readonly<{
    transformed: Record<string, unknown>;
    settlement?: SessionInputAdmissionSettlement;
}>;

function asMetadataRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isSessionInputAdmissionSettlementCallback(
    value: unknown,
): value is () => Promise<void> | void {
    return typeof value === 'function';
}

function normalizeSessionInputTransformBeforeCommitResult(
    value: SessionInputTransformBeforeCommitResult,
): NormalizedSessionInputTransformBeforeCommitResult {
    const candidate = asMetadataRecord(value);
    const transformed = asMetadataRecord(candidate?.transformed);
    const settlement = asMetadataRecord(candidate?.settlement);
    const onAccepted = settlement?.onAccepted;
    const onDefinitiveAdmissionFailure = settlement?.onDefinitiveAdmissionFailure;
    const stagedMediaHandles = Array.isArray(settlement?.stagedMediaHandles)
        ? settlement.stagedMediaHandles as readonly ComposerContentHandleV1[]
        : undefined;
    if (
        transformed
        && isSessionInputAdmissionSettlementCallback(onAccepted)
        && isSessionInputAdmissionSettlementCallback(onDefinitiveAdmissionFailure)
    ) {
        return {
            transformed,
            settlement: {
                onAccepted,
                onDefinitiveAdmissionFailure,
            ...(stagedMediaHandles ? { stagedMediaHandles } : {}),
                ...(Array.isArray(settlement?.createdWorkspaceRelativePaths)
                    ? { createdWorkspaceRelativePaths: settlement.createdWorkspaceRelativePaths as readonly string[] }
                    : {}),
                ...(typeof settlement?.workingDirectory === 'string'
                    ? { workingDirectory: settlement.workingDirectory }
                    : {}),
            },
        };
    }
    return { transformed: value };
}

async function settleSessionInputAdmissionFailure(
    settlement: SessionInputAdmissionSettlement | undefined,
): Promise<void> {
    if (!settlement) return;
    try {
        await settlement.onDefinitiveAdmissionFailure();
    } catch (error) {
        logger.debug('[session-input] Failed to settle uncommitted transformed input', { error });
    }
}

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
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
    maxToolCallCacheEntries?: number | undefined;
    transformSessionInputBeforeCommit?: (
        payload: Record<string, unknown>,
    ) => Promise<SessionInputTransformBeforeCommitResult> | SessionInputTransformBeforeCommitResult;
    admitSessionUserMessage: (params: Readonly<{
        localId: string;
        text: string;
        meta: Record<string, unknown>;
        composerAttachments: readonly ComposerAttachmentInputV1[];
        settlement?: SessionInputAdmissionSettlement;
        inputAdmission?: Readonly<{
            provenance: SessionMessageProvenanceV1;
            request: SessionInputRequestV1;
        }>;
    }>) => Promise<void>;
    getTranscriptQueryContext: () => Readonly<
        | { encryptionMode: 'plain' }
        | {
            encryptionMode: 'e2ee';
            encryptionKey: Uint8Array;
            encryptionVariant: 'legacy' | 'dataKey';
        }
    >;
}>;

export type SessionClientTranscriptApi = Readonly<{
    enqueueUserTextMessageCommitted: (
        text: string,
        opts: CommittedTranscriptMessageOptions,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    enqueueSessionUserMessage: (params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
        structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        inputAdmission?: Readonly<{
            provenance: SessionMessageProvenanceV1;
            request: SessionInputRequestV1;
        }>;
    }>) => Promise<void>;
    preparePendingMessageComposerAdmission: (params: Readonly<{
        localId: string;
        text: string;
        meta: Record<string, unknown>;
    }>) => Promise<Readonly<{
        text: string;
        meta: Record<string, unknown>;
        composerAttachments: readonly ComposerAttachmentInputV1[];
        stagedMediaHandles: readonly ComposerContentHandleV1[];
        sessionMediaMetadata?: Readonly<{
            key: 'happier' | 'happierMedia';
            envelope: import('@happier-dev/protocol').SessionMediaMessageMetaV1;
        }>;
        sessionMediaCleanup?: Readonly<{
            workingDirectory: string;
            createdWorkspaceRelativePaths: readonly string[];
        }>;
    }>>;
    enqueueAgentMessageCommitted: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: CommittedTranscriptMessageOptions,
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
    enqueueSessionEventCommitted: (
        event: SessionEventMessage,
        id?: string,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
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

        if (
            payload.thinking
            || isActiveLatestTurnStatus(payload.latestTurnStatus)
            || !volatileWhenIdle
        ) {
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

    const transformSessionInputPayloadBeforeCommit = async (
        payload: Readonly<{
            localId: string;
            text: string;
            meta: Record<string, unknown>;
            timestampMs: number;
            structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        }>,
    ): Promise<Readonly<{
        text: string;
        meta: Record<string, unknown>;
        composerAttachments: readonly ComposerAttachmentInputV1[];
        settlement?: SessionInputAdmissionSettlement;
    }>> => {
        const admit = (input: Readonly<{
            text: string;
            meta: Record<string, unknown>;
            preparedComposerAttachments?: readonly ComposerAttachmentInputV1[];
        }>) => {
            const admitted = admitSessionStructuredInputV1({
                text: input.text,
                meta: input.meta,
                ...(payload.structuredInputAdmissionPolicy
                    ? { admissionPolicy: payload.structuredInputAdmissionPolicy }
                    : {}),
                ...(input.preparedComposerAttachments
                    ? { preparedComposerAttachments: input.preparedComposerAttachments }
                    : {}),
            });
            return {
                text: admitted.text,
                meta: admitted.meta,
                composerAttachments: admitted.structuredInput?.composerAttachments ?? [],
            };
        };
        const selectedComposerAttachment = hasRawComposerAttachmentSelectionV1(payload.meta);
        if (!deps.transformSessionInputBeforeCommit) {
            return admit({ text: payload.text, meta: payload.meta });
        }
        try {
            const transformResult = normalizeSessionInputTransformBeforeCommitResult(
                await deps.transformSessionInputBeforeCommit({
                    sessionId: deps.sessionId,
                    localId: payload.localId,
                    text: payload.text,
                    meta: payload.meta,
                    timestampMs: payload.timestampMs,
                }),
            );
            const transformed = transformResult.transformed;
            const validation = validatePluginHookPayloadV1({
                hookId: 'session.input.transform',
                payload: transformed,
            });
            if (!validation.success) {
                if (selectedComposerAttachment) {
                    await settleSessionInputAdmissionFailure(transformResult.settlement);
                    return admit({ text: payload.text, meta: payload.meta });
                }
                logger.debug('[plugins] session.input.transform returned an invalid payload; using original input', {
                    error: validation.message,
                });
                return admit({ text: payload.text, meta: payload.meta });
            }
            const parsed = validation.payload as Record<string, unknown>;
            const transformedMeta = parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)
                ? parsed.meta as Record<string, unknown>
                : null;
            const admissionMeta = preserveComposerAttachmentSelectionAcrossSessionInputTransformV1({
                sourceMeta: payload.meta,
                transformedMeta,
            }) ?? payload.meta;
            const preparedComposerAttachments = Array.isArray(parsed.preparedComposerAttachments)
                ? parsed.preparedComposerAttachments as readonly ComposerAttachmentInputV1[]
                : undefined;
            try {
                return {
                    ...admit({
                        text: typeof parsed.text === 'string' ? parsed.text : payload.text,
                        meta: admissionMeta,
                        ...(preparedComposerAttachments ? { preparedComposerAttachments } : {}),
                    }),
                    ...(transformResult.settlement ? { settlement: transformResult.settlement } : {}),
                };
            } catch (error) {
                await settleSessionInputAdmissionFailure(transformResult.settlement);
                throw error;
            }
        } catch (error) {
            if (selectedComposerAttachment) throw error;
            logger.debug('[plugins] session.input.transform failed; using original input');
            return admit({ text: payload.text, meta: payload.meta });
        }
    };

    const enqueueAgentMessageCommitted = async (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: CommittedTranscriptMessageOptions,
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> => {
        const { normalizedBody, payload, localId, sidechainId, messageRole } = await prepareCommittedAgentMessageViaPort(
            getTranscriptSendPort(),
            provider,
            body,
            opts,
        );

        deps.outboundShapeLogger.log(`acp:${provider}:${normalizedBody.type}`, normalizedBody);

        if (shouldTraceAcpMessageType(normalizedBody.type, { includeTaskComplete: true })) {
            recordAcpToolTraceEventIfNeeded({ sessionId: deps.sessionId, provider, body: normalizedBody, localId });
        }

        const streamSegmentMeta = opts.meta?.happierStreamSegmentV1;
        const metaRecord = streamSegmentMeta && typeof streamSegmentMeta === 'object'
            ? streamSegmentMeta as Record<string, unknown>
            : null;
        const createdAt = typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
            ? Math.max(0, Math.trunc(opts.createdAt))
            : metaRecord && typeof metaRecord.startedAtMs === 'number' && Number.isFinite(metaRecord.startedAtMs)
                ? Math.max(0, Math.trunc(metaRecord.startedAtMs))
                : Date.now();
        const updatedAt = typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
            ? Math.max(createdAt, Math.trunc(opts.updatedAt))
            : metaRecord && typeof metaRecord.updatedAtMs === 'number' && Number.isFinite(metaRecord.updatedAtMs)
                ? Math.max(createdAt, Math.trunc(metaRecord.updatedAtMs))
                : createdAt;
        assertCommittedTranscriptAdmission(opts.admission);
        const result = await deps.enqueueCommittedTranscriptMessage({
            message: payload,
            localId,
            sidechainId,
            messageRole,
            createdAt,
            updatedAt,
            provenance: opts.provenance,
            ...(opts.admission === undefined ? {} : { admission: opts.admission }),
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
        const assistant = await prepareCommittedAgentMessageViaPort(
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
        async preparePendingMessageComposerAdmission(params) {
            const transformed = await transformSessionInputPayloadBeforeCommit({
                localId: params.localId,
                text: params.text,
                meta: params.meta,
                timestampMs: Date.now(),
            });
            // Pending persistence is deliberately outside this API. Its canonical PATCH
            // owner decides acceptance; uncalled settlement callbacks retain custody.
            const sessionMediaMetadata = readSessionMediaMetadata(transformed.meta);
            return {
                text: transformed.text,
                meta: transformed.meta,
                composerAttachments: transformed.composerAttachments,
                stagedMediaHandles: transformed.settlement?.stagedMediaHandles ?? [],
                ...(sessionMediaMetadata ? { sessionMediaMetadata } : {}),
                ...(transformed.settlement
                    && transformed.settlement.workingDirectory
                    && transformed.settlement.createdWorkspaceRelativePaths
                    ? {
                        sessionMediaCleanup: {
                            workingDirectory: transformed.settlement.workingDirectory,
                            createdWorkspaceRelativePaths: transformed.settlement.createdWorkspaceRelativePaths,
                        },
                    }
                    : {}),
            };
        },


        async enqueueSessionEventCommitted(event, id) {
            const prepared = prepareSessionEventMessageViaPort(getTranscriptSendPort(), event, id);
            const now = Date.now();
            return await deps.enqueueCommittedTranscriptMessage({
                message: prepared.payload,
                localId: prepared.localId,
                sidechainId: null,
                messageRole: prepared.messageRole,
                sessionEventType: prepared.sessionEventType,
                createdAt: now,
                updatedAt: now,
                provenance: { kind: 'non_dependent', source: 'background' },
            });
        },

        async enqueueUserTextMessageCommitted(text, opts) {
            const prepared = prepareCommittedUserTextMessageViaPort(
                getTranscriptSendPort(),
                text,
                opts,
            );
            const createdAt = typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
                ? Math.max(0, Math.trunc(opts.createdAt))
                : Date.now();
            const updatedAt = typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
                ? Math.max(createdAt, Math.trunc(opts.updatedAt))
                : createdAt;
            assertCommittedTranscriptAdmission(opts.admission);
            return await deps.enqueueCommittedTranscriptMessage({
                message: prepared.payload,
                localId: prepared.localId,
                sidechainId: null,
                messageRole: 'user',
                createdAt,
                updatedAt,
                provenance: opts.provenance,
                ...(opts.admission === undefined ? {} : { admission: opts.admission }),
            });
        },

        async enqueueSessionUserMessage(params) {
            const originalText = String(params.text ?? '');
            const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();

            const meta: Record<string, unknown> = params.meta && typeof params.meta === 'object' ? { ...params.meta } : {};
            if (typeof meta.source !== 'string' || meta.source.trim().length === 0) {
                meta.source = 'ui';
            }
            if (typeof meta.sentFrom !== 'string' || meta.sentFrom.trim().length === 0) {
                meta.sentFrom = 'ui';
            }
            if (originalText.length === 0 && !hasRawComposerAttachmentSelectionV1(meta)) return;
            const createdAt = Date.now();
            const transformed = await transformSessionInputPayloadBeforeCommit({
                localId,
                text: originalText,
                meta,
                timestampMs: createdAt,
                ...(params.structuredInputAdmissionPolicy
                    ? { structuredInputAdmissionPolicy: params.structuredInputAdmissionPolicy }
                    : {}),
            });
            const text = transformed.text;

            await deps.admitSessionUserMessage({
                localId,
                text,
                meta: transformed.meta,
                composerAttachments: transformed.composerAttachments,
                ...(transformed.settlement ? { settlement: transformed.settlement } : {}),
                ...(params.inputAdmission ? { inputAdmission: params.inputAdmission } : {}),
            });
        },

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
                const admission = await enqueueAgentMessageCommitted(
                    provider,
                    { type: 'message', message: messageText },
                    {
                        localId: request.localId,
                        meta: persisted.meta,
                        provenance: { kind: 'non_dependent', source: 'external' },
                    },
                );
                if (!admission.persisted) {
                    throw new Error('Session media transcript descriptor was not admitted to durable custody');
                }
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
                ...transcriptQueryContext,
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
                ...transcriptQueryContext,
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

        keepAlive(thinking, mode) {
            if (process.env.DEBUG) {
                logger.debug(`[API] Sending keep alive message: ${thinking}`);
            }
            latestSessionPresence = { thinking: resolveKeepAliveThinkingWithTerminalGuard(thinking, Date.now()), mode };
            // An open canonical turn keeps publisher presence reliable even when the provider's
            // foreground thinking projection is idle. The payload retains the original thinking
            // value, so presence transport cannot synthesize a working-state projection.
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
