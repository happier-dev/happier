import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { randomUUID } from 'node:crypto';
import { projectUsageSessionMessageTimingV1, type UsageTimingBoundsV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';

import { logger } from '@/ui/logger';
import type { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { isActiveLatestTurnStatus } from '../../sessionTurnStatusSnapshot';
import { deriveVoiceAgentTurnLocalId, readVoiceAgentTurnPayloadFromMeta } from '@happier-dev/protocol/messages/structured/voiceAgentTurnLocalId';
import { hasRawComposerAttachmentSelectionV1, hasRawSessionAttachmentSelectionV1, RawIngressStructuredInputV1Schema, HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1, readSessionAttachmentEnvelopeRecordsV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { SessionAttachmentDescriptorV1Schema, buildUploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { validatePluginHookPayloadV1 } from '@happier-dev/protocol/plugins/hooks';
import { SessionMediaMessageMetaV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMediaV1';
import type { SessionMediaMessageMetaV1, ComposerAttachmentInputV1, ComposerContentHandleV1 } from '@happier-dev/protocol';
import type {
    PrimaryTurnStatusV1,
    PendingRequestedActionV1,
    ParticipantRecipientV1,
    SessionInputAdmissionResultV1,
    SessionInputRequest,
    SessionMessageProvenance,
    SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { SessionTranscriptSurfaceItemReferencesV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
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
import { SESSION_STREAM_APPEND_BINDING_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
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
    commitSessionMediaForTranscript,
    type SendAgentSessionMediaCommittedRequest,
} from './sessionMediaBridge';
import type { EphemeralSendOutcome } from './ephemeralSendOutcome';
import {
    assertCommittedTranscriptAdmission,
    type CommittedTranscriptAdmission,
    type CommittedTranscriptMessageOptions,
    type CommittedTranscriptUserMessageOptions,
    type CommittedTranscriptOriginal,
} from '../../transcriptPort';
import {
    admitSessionStructuredInputV1,
    preserveComposerAttachmentSelectionAcrossSessionInputTransformV1,
    validateComposerAttachmentRejoinCorrespondenceV1,
    SessionStructuredInputAdmissionError,
    type SessionStructuredInputAdmissionPolicyV1,
} from '@/session/services/admitSessionStructuredInputV1';
import type { PersistedSessionUserMessageAdmission } from './sessionUserMessageAdmissionRejoin';
import { projectRawIngressSessionAttachmentsV1, projectSessionAttachmentInputV1, SessionAttachmentIssuedRecordMissingError } from '@/session/attachments/projectRawIngressSessionAttachmentsV1';
import { resolveTrustedSessionAttachmentLocalImagePaths } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { ComposerStagedMediaReleaseIntentV1Schema, type ComposerStagedMediaReleaseIntentV1 } from '@happier-dev/protocol/sessions/userMessageRpc';

type PlainOrEncryptedPayload = string | { t: 'plain'; v: unknown };
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';
type SessionEventType = 'ready';

export class SessionUserMessageAdmissionDispositionError extends Error {
    readonly disposition: Extract<SessionInputAdmissionResultV1, Readonly<{
        status: 'rejected' | 'outcomeUnknown';
    }>>;

    constructor(disposition: SessionUserMessageAdmissionDispositionError['disposition']) {
        super(`Session user input admission ${disposition.status}: ${disposition.code}`);
        this.name = 'SessionUserMessageAdmissionDispositionError';
        this.disposition = disposition;
    }
}

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
    usageTimingV1?: UsageTimingBoundsV1 | null;
    message: PlainOrEncryptedPayload;
    toolOutputPart?: StrictSessionStoredMessageContentEnvelope;
    localId: string;
    sidechainId: string | null;
    messageRole: SessionMessageRole;
    sessionEventType?: SessionEventType;
    createdAt: number;
    updatedAt: number;
    provenance: SessionTranscriptObservationProvenanceV1;
    surfaceItemReference?: SessionTranscriptSurfaceItemReferencesV1;
    approvalRequestArtifactId?: string;
    admission?: CommittedTranscriptAdmission;
    observeCommitSignal?: AbortSignal;
    awaitDelivery?: boolean;
    append?: Readonly<{ content: PlainOrEncryptedPayload; baseLength: number; baseUpdatedAt: number }>;
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
  stagedMediaReleaseIntents?: readonly ComposerStagedMediaReleaseIntentV1[];
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
    const stagedMediaReleaseIntents = Array.isArray(settlement?.stagedMediaReleaseIntents)
        ? settlement.stagedMediaReleaseIntents.map((intent) => ComposerStagedMediaReleaseIntentV1Schema.parse(intent))
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
                ...(stagedMediaReleaseIntents ? { stagedMediaReleaseIntents } : {}),
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
    env?: NodeJS.ProcessEnv;
    token: string;
    serverUrl?: string;
    serverId?: string;
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
    onPresence?: (presence: SessionPresenceSnapshot) => void;
    getMetadataSnapshot: () => Metadata | null;
    updateAgentState: (handler: (metadata: AgentState) => AgentState) => Promise<void>;
    getAgentStateRequestStore?: () => AgentStateRequestStore | null;
    updateMetadata: (handler: (metadata: Metadata) => Metadata) => Promise<void>;
    enqueueCommittedTranscriptMessage: (params: EnqueueCommittedTranscriptMessageParams) => Promise<Readonly<{
        persisted: boolean;
        delivered: boolean;
        localId?: string;
        committedSequence?: number;
        whenCommitted?: Promise<CommittedTranscriptOriginal | null>;
    }>>;
    enqueueCommittedVoiceAgentTranscriptTurn: (
        params: EnqueueCommittedVoiceAgentTranscriptTurnParams,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    usageObservationPublisher: SessionUsageObservationPublisher;
    buildOutboundSessionMessagePayload: (content: unknown) => PlainOrEncryptedPayload;
    buildDurableOutboundSessionMessagePayload?: SessionClientTranscriptSendPort['buildDurableOutboundSessionMessagePayload'];
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
    maxToolCallCacheEntries?: number | undefined;
    resolveSessionAttachment?: Parameters<typeof projectRawIngressSessionAttachmentsV1>[0]['resolveSessionAttachment'];
    transformSessionInputBeforeCommit?: (
        payload: Record<string, unknown>,
    ) => Promise<SessionInputTransformBeforeCommitResult> | SessionInputTransformBeforeCommitResult;
    admitSessionUserMessage: (params: Readonly<{
        callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        localId: string;
        text: string;
        meta: Record<string, unknown>;
        composerAttachments: readonly ComposerAttachmentInputV1[];
        requestedAction?: PendingRequestedActionV1;
        recipient?: ParticipantRecipientV1;
        settlement?: SessionInputAdmissionSettlement;
        inputAdmission?: Readonly<{
            provenance: SessionMessageProvenance;
            request: SessionInputRequest;
        }>;
    }>) => Promise<SessionInputAdmissionResultV1>;
    findPersistedSessionUserMessageAdmission: (params: Readonly<{
        localId: string;
    }>) => Promise<PersistedSessionUserMessageAdmission | null>;
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
        opts: CommittedTranscriptUserMessageOptions,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    enqueueSessionUserMessage: (params: Readonly<{
        callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
        requestedAction?: PendingRequestedActionV1;
        recipient?: ParticipantRecipientV1;
        structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        inputAdmission?: Readonly<{
            provenance: SessionMessageProvenance;
            request: SessionInputRequest;
        }>;
    }>) => Promise<void>;
    enqueueSessionUserMessageWithDisposition: (params: Readonly<{
        callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        text: string;
        localId: string;
        meta?: Record<string, unknown>;
        requestedAction?: PendingRequestedActionV1;
        recipient?: ParticipantRecipientV1;
        structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        inputAdmission?: Readonly<{
            provenance: SessionMessageProvenance;
            request: SessionInputRequest;
        }>;
    }>) => Promise<SessionInputAdmissionResultV1>;
    preparePendingMessageComposerAdmission: (params: Readonly<{
        localId: string;
        text: string;
        meta: Record<string, unknown>;
    }>) => Promise<Readonly<{
        text: string;
        meta: Record<string, unknown>;
        composerAttachments: readonly ComposerAttachmentInputV1[];
        stagedMediaHandles: readonly ComposerContentHandleV1[];
        stagedMediaReleaseIntents?: readonly ComposerStagedMediaReleaseIntentV1[];
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
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean; committedSequence?: number;
        whenCommitted?: Promise<CommittedTranscriptOriginal | null> }>>;
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
        opts: Parameters<typeof sendAgentMessageEphemeralViaPort>[3],
    ) => EphemeralSendOutcome;
    sendAgentMessageEphemeralDelta: (
        provider: ACPProvider,
        body: ACPMessageData,
        opts: Parameters<typeof sendAgentMessageEphemeralDeltaViaPort>[3],
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
        meta?: Record<string, unknown>,
        observeCommitSignal?: AbortSignal,
        options?: Readonly<{ awaitDelivery?: boolean }>,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean; localId?: string; committedSequence?: number;
        whenCommitted?: Promise<CommittedTranscriptOriginal | null> }>>;
    keepAlive: (thinking: boolean, mode: SessionAliveMode) => void;
    replayLatestPresence: () => void;
}>;

export function createSessionClientTranscriptApi(
    deps: SessionClientTranscriptApiDeps,
): SessionClientTranscriptApi {
    const env = deps.env ?? sessionProcessEnvironment();
    const serverUrl = deps.serverUrl ?? resolveServerHttpBaseUrl();
    let latestSessionPresence: SessionPresenceSnapshot | null = null;
    let hasPublishedSessionPresence = false;
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
        serverId: deps.serverId,
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
        buildDurableOutboundSessionMessagePayload: deps.buildDurableOutboundSessionMessagePayload,
        toolCallCanonicalNameByProviderAndId: deps.toolCallCanonicalNameByProviderAndId,
        permissionToolCallRawInputByProviderAndId: deps.permissionToolCallRawInputByProviderAndId,
        toolCallInputByProviderAndId: deps.toolCallInputByProviderAndId,
        maxToolCallCacheEntries: deps.maxToolCallCacheEntries,
    });

    const getPostSendReactionPort = (): PostSendReactionPort => ({
        sessionId: deps.sessionId,
        getAgentStateRequestStore: deps.getAgentStateRequestStore,
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
        const projected = projectRawIngressSessionAttachmentsV1({
            sessionId: deps.sessionId,
            text: payload.text,
            meta: payload.meta,
            resolveSessionAttachment: deps.resolveSessionAttachment ?? (() => null),
        });
        const admissionPolicy = {
            allowedLocalImagePaths: new Set([
                ...(payload.structuredInputAdmissionPolicy?.allowedLocalImagePaths ?? []),
                ...(projected.allowedLocalImagePaths ?? []),
            ]),
        };
        const sessionPath = deps.getMetadataSnapshot()?.path;
        if (typeof sessionPath === 'string' && sessionPath.length > 0) {
            // Pending input already carries the prepared descriptor, not its volatile upload handle.
            // Reuse the ordinary attachment verifier before retaining native image access.
            for (const imagePath of await resolveTrustedSessionAttachmentLocalImagePaths({
                cwd: sessionPath,
                metadata: projected.meta,
            })) {
                admissionPolicy.allowedLocalImagePaths.add(imagePath);
            }
        }
        payload = { ...payload, text: projected.text, meta: projected.meta };
        const admit = (input: Readonly<{
            text: string;
            meta: Record<string, unknown>;
            preparedComposerAttachments?: readonly ComposerAttachmentInputV1[];
        }>) => {
            const admitted = admitSessionStructuredInputV1({
                text: input.text,
                meta: input.meta,
                admissionPolicy,
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
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean; committedSequence?: number;
        whenCommitted?: Promise<CommittedTranscriptOriginal | null> }>> => {
        const { normalizedBody, payload, toolOutputPart, localId, sidechainId, messageRole, surfaceItemReference, approvalRequestArtifactId, openedContent, source } = await prepareCommittedAgentMessageViaPort(
            getTranscriptSendPort(),
            provider,
            body,
            opts,
        );

        deps.outboundShapeLogger.log(`acp:${provider}:${normalizedBody.type}`, normalizedBody);

        if (source && shouldTraceAcpMessageType(normalizedBody.type, { includeTaskComplete: true })) {
            recordAcpToolTraceEventIfNeeded({ sessionId: deps.sessionId, source, body: normalizedBody, localId });
        }

        const streamSegmentMeta = opts.meta?.happierStreamSegmentV1;
        const metaRecord = streamSegmentMeta && typeof streamSegmentMeta === 'object'
            ? streamSegmentMeta as Record<string, unknown> : null;
        const createdAt = typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
            ? Math.max(0, Math.trunc(opts.createdAt))
            : metaRecord && typeof metaRecord.startedAtMs === 'number' && Number.isFinite(metaRecord.startedAtMs)
                ? Math.max(0, Math.trunc(metaRecord.startedAtMs)) : Date.now();
        const updatedAt = typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
            ? Math.max(createdAt, Math.trunc(opts.updatedAt))
            : metaRecord && typeof metaRecord.updatedAtMs === 'number' && Number.isFinite(metaRecord.updatedAtMs)
                ? Math.max(createdAt, Math.trunc(metaRecord.updatedAtMs))
                : createdAt;
        assertCommittedTranscriptAdmission(opts.admission);
        // The append crosses the same envelope/encryption choke point as the full body, with its
        // binding (message, base, result) sealed inside so Home cannot splice it elsewhere.
        const append = opts.append
            ? {
                content: (await prepareCommittedAgentMessageViaPort(getTranscriptSendPort(), provider, opts.append.body, {
                    localId,
                    meta: {
                        ...opts.meta,
                        [SESSION_STREAM_APPEND_BINDING_META_KEY]: {
                            v: 1, localId, baseLength: opts.append.baseLength, length: opts.append.length,
                        },
                    },
                })).payload,
                baseLength: opts.append.baseLength,
                baseUpdatedAt: opts.append.baseUpdatedAt,
            }
            : undefined;
        const result = await deps.enqueueCommittedTranscriptMessage({
            message: payload,
            ...(toolOutputPart ? { toolOutputPart } : {}),
            usageTimingV1: projectUsageSessionMessageTimingV1({ sessionId: deps.sessionId,
                message: { id: localId, localId, content: openedContent, createdAt } }),
            localId,
            sidechainId,
            messageRole,
            createdAt,
            updatedAt,
            provenance: opts.provenance,
            ...(surfaceItemReference === undefined ? {} : { surfaceItemReference }),
            ...(approvalRequestArtifactId === undefined ? {} : { approvalRequestArtifactId }),
            ...(opts.admission === undefined ? {} : { admission: opts.admission }),
            ...(opts.observeCommitSignal === undefined ? {} : { observeCommitSignal: opts.observeCommitSignal }),
            ...(append ? { append } : {}),
        });
        if (result.delivered) {
            const extracted = extractAssistantTextSnapshotFromAcpMessage(provider, normalizedBody);
            if (extracted) {
                deps.turnAssistantTextSnapshotStore?.observe({
                    text: extracted.text,
                    provider: extracted.provider,
                    sidechainId: extracted.sidechainId,
                    localId,
                    seq: result.committedSequence,
                    source: 'committed',
                });
            }
        }
        applyAcpPostSendReactions(getPostSendReactionPort(), {
            provider,
            normalizedBody,
            localId,
            createdAt,
            provenance: opts.provenance,
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
                usageTimingV1: user.usageTimingV1,
                localId: user.localId,
                sidechainId: null,
                messageRole: 'user',
                createdAt: userCreatedAt,
                updatedAt: userCreatedAt,
                provenance: { kind: 'non_dependent', source: 'sidechain' },
            },
            assistant: {
                message: assistant.payload,
                usageTimingV1: projectUsageSessionMessageTimingV1({ sessionId: deps.sessionId,
                    message: { id: assistant.localId, localId: assistant.localId, content: assistant.openedContent, createdAt: assistantCreatedAt } }),
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
            createdAt: assistantCreatedAt,
            provenance: { kind: 'non_dependent', source: 'sidechain' },
        });
        return result;
    };

    const enqueueSessionUserMessageWithDisposition = async (params: Readonly<{
        callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        text: string;
        localId: string;
        meta?: Record<string, unknown>;
        requestedAction?: PendingRequestedActionV1;
        recipient?: ParticipantRecipientV1;
        structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        inputAdmission?: Readonly<{
            provenance: SessionMessageProvenance;
            request: SessionInputRequest;
        }>;
    }>): Promise<SessionInputAdmissionResultV1> => {
        const originalText = String(params.text ?? '');
        const localId = params.localId;

        const meta: Record<string, unknown> = params.meta && typeof params.meta === 'object' ? { ...params.meta } : {};
        if (typeof meta.source !== 'string' || meta.source.trim().length === 0) meta.source = 'ui';
        if (typeof meta.sentFrom !== 'string' || meta.sentFrom.trim().length === 0) meta.sentFrom = 'ui';
        const selectedComposerAttachment = hasRawComposerAttachmentSelectionV1(meta);
        if (originalText.length === 0 && !selectedComposerAttachment && !hasRawSessionAttachmentSelectionV1(meta)) {
            return { status: 'rejected', code: 'session_input_invalid' };
        }
        if (selectedComposerAttachment) {
            const persisted = await deps.findPersistedSessionUserMessageAdmission({ localId });
            if (persisted !== null) {
                validateComposerAttachmentRejoinCorrespondenceV1({
                    meta,
                    preparedComposerAttachments: persisted.composerAttachments,
                });
                return await deps.admitSessionUserMessage({
                    ...(params.callerInputAuthorization ? { callerInputAuthorization: params.callerInputAuthorization } : {}),
                    localId,
                    text: persisted.text,
                    meta: persisted.meta,
                    composerAttachments: persisted.composerAttachments,
                    ...(params.requestedAction ? { requestedAction: params.requestedAction } : {}),
                    ...(params.recipient ? { recipient: params.recipient } : {}),
                    ...(params.inputAdmission ? { inputAdmission: params.inputAdmission } : {}),
                });
            }
        }
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
        return await deps.admitSessionUserMessage({
            ...(params.callerInputAuthorization ? { callerInputAuthorization: params.callerInputAuthorization } : {}),
            localId,
            text: transformed.text,
            meta: transformed.meta,
            composerAttachments: transformed.composerAttachments,
            ...(params.requestedAction ? { requestedAction: params.requestedAction } : {}),
            ...(params.recipient ? { recipient: params.recipient } : {}),
            ...(transformed.settlement ? { settlement: transformed.settlement } : {}),
            ...(params.inputAdmission ? { inputAdmission: params.inputAdmission } : {}),
        });
    };

    const enqueueUserTextMessageCommitted: SessionClientTranscriptApi['enqueueUserTextMessageCommitted'] = async (text, opts) => {
        const prepared = prepareCommittedUserTextMessageViaPort(getTranscriptSendPort(), text, opts);
        const createdAt = typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
            ? Math.max(0, Math.trunc(opts.createdAt)) : Date.now();
        const updatedAt = typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
            ? Math.max(createdAt, Math.trunc(opts.updatedAt)) : createdAt;
        assertCommittedTranscriptAdmission(opts.admission);
        return await deps.enqueueCommittedTranscriptMessage({
            message: prepared.payload, localId: prepared.localId, sidechainId: opts.sidechainId ?? null,
            usageTimingV1: prepared.usageTimingV1,
            messageRole: 'user', createdAt, updatedAt, provenance: opts.provenance,
            ...(opts.admission === undefined ? {} : { admission: opts.admission }),
        });
    };

    return {
        async preparePendingMessageComposerAdmission(params) {
            const raw = RawIngressStructuredInputV1Schema.safeParse(params.meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
            const legacySelection = raw.success ? raw.data.sessionAttachments ?? [] : [];
            const resolvesIssuedSessionUploads = legacySelection.length > 0 && raw.success
                && Object.keys(raw.data).every(key => key === 'v' || key === 'sessionAttachments');
            let transformed: Awaited<ReturnType<typeof transformSessionInputPayloadBeforeCommit>>;
            if (resolvesIssuedSessionUploads) {
                // This new target-owned selection needs issued upload resolution before
                // original Pending custody. Generic hooks still run once at final transcript
                // admission; full Composer/Pending-edit preparation retains its path below.
                if (legacySelection.some(handle => handle.sessionId !== deps.sessionId)) {
                    throw new SessionStructuredInputAdmissionError('session_structured_input_session_attachment_invalid');
                }
                const persisted = await deps.findPersistedSessionUserMessageAdmission({ localId: params.localId });
                let projected: ReturnType<typeof projectRawIngressSessionAttachmentsV1>;
                if (persisted) {
                    const descriptors = readSessionAttachmentEnvelopeRecordsV1(persisted.meta)
                        .map(descriptor => SessionAttachmentDescriptorV1Schema.parse(descriptor));
                    validateComposerAttachmentRejoinCorrespondenceV1({ meta: params.meta,
                        preparedComposerAttachments: [], preparedSessionAttachments: descriptors });
                    projected = projectSessionAttachmentInputV1({ text: params.text, meta: params.meta,
                        uploaded: descriptors.map(descriptor => buildUploadedAttachment({ ...descriptor,
                            ...(descriptor.attachmentHandle ? { attachmentHandle: { ...descriptor.attachmentHandle } } : {}),
                        })),
                    });
                } else {
                    const resolveSessionAttachment = deps.resolveSessionAttachment;
                    if (!resolveSessionAttachment) {
                        throw new SessionStructuredInputAdmissionError('session_structured_input_session_attachment_invalid');
                    }
                    try {
                        projected = projectRawIngressSessionAttachmentsV1({ sessionId: deps.sessionId,
                            text: params.text, meta: params.meta, resolveSessionAttachment });
                    } catch (error) {
                        if (error instanceof SessionAttachmentIssuedRecordMissingError) {
                            // Both original-custody reads established absence before this
                            // real issued-store lookup. No Pending input has been written.
                            throw new SessionStructuredInputAdmissionError('session_attachment_upload_checkpoint_stale');
                        }
                        throw error;
                    }
                }
                const admitted = admitSessionStructuredInputV1({ ...projected,
                    admissionPolicy: { allowedLocalImagePaths: projected.allowedLocalImagePaths } });
                transformed = { text: admitted.text, meta: admitted.meta, composerAttachments: [] };
            } else {
                transformed = await transformSessionInputPayloadBeforeCommit({ localId: params.localId,
                    text: params.text, meta: params.meta, timestampMs: Date.now() });
            }
            // Pending persistence is deliberately outside this API. Its canonical PATCH
            // owner decides acceptance; uncalled settlement callbacks retain custody.
            const sessionMediaMetadata = readSessionMediaMetadata(transformed.meta);
            return {
                text: transformed.text,
                meta: transformed.meta,
                composerAttachments: transformed.composerAttachments,
                stagedMediaHandles: transformed.settlement?.stagedMediaHandles ?? [],
                ...(transformed.settlement?.stagedMediaReleaseIntents
                    ? { stagedMediaReleaseIntents: transformed.settlement.stagedMediaReleaseIntents }
                    : {}),
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


        async enqueueSessionEventCommitted(event, id, meta, observeCommitSignal, options) {
            const prepared = prepareSessionEventMessageViaPort(getTranscriptSendPort(), event, id, meta);
            const now = Date.now();
            return await deps.enqueueCommittedTranscriptMessage({
                message: prepared.payload,
                usageTimingV1: prepared.usageTimingV1,
                localId: prepared.localId,
                sidechainId: null,
                messageRole: prepared.messageRole,
                sessionEventType: prepared.sessionEventType,
                createdAt: now,
                updatedAt: now,
                provenance: { kind: 'non_dependent', source: 'background' },
                ...(observeCommitSignal ? { observeCommitSignal } : {}),
                ...(options?.awaitDelivery === undefined ? {} : { awaitDelivery: options.awaitDelivery }),
            });
        },

        enqueueUserTextMessageCommitted,

        async enqueueSessionUserMessage(params) {
            const originalText = String(params.text ?? '');
            const selectedComposerAttachment = hasRawComposerAttachmentSelectionV1(params.meta);
            if (originalText.length === 0 && !selectedComposerAttachment && !hasRawSessionAttachmentSelectionV1(params.meta)) return;
            const disposition = await enqueueSessionUserMessageWithDisposition({
                ...params,
                localId: typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID(),
            });
            if (disposition.status === 'rejected' || disposition.status === 'outcomeUnknown') {
                throw new SessionUserMessageAdmissionDispositionError(disposition);
            }
        },

        enqueueSessionUserMessageWithDisposition,

        enqueueAgentMessageCommitted,
        enqueueVoiceAgentTranscriptTurnCommitted,

        async sendAgentSessionMediaCommitted(provider, request) {
            await commitSessionMediaForTranscript({
                sessionId: deps.sessionId,
                workingDirectory: deps.getMetadataSnapshot()?.path,
                request,
                logger,
                provider,
                enqueueUser: enqueueUserTextMessageCommitted,
                enqueueAgent: enqueueAgentMessageCommitted,
                clearAssistantSnapshot: () => deps.turnAssistantTextSnapshotStore?.clearSnapshot({ reason: 'media_only_commit' }),
            });
        },

        sendAgentMessageEphemeral(provider, body, opts) {
            return sendAgentMessageEphemeralViaPort(getTranscriptSendPort(), provider, body, opts);
        },

        sendAgentMessageEphemeralDelta(provider, body, opts) {
            return sendAgentMessageEphemeralDeltaViaPort(getTranscriptSendPort(), provider, body, opts);
        },

        async fetchRecentTranscriptTextItemsForAcpImport(opts) {
            const transcriptQueryContext = deps.getTranscriptQueryContext();
            const request = () => runWithServerHttpBaseUrl(serverUrl, async () => fetchRecentTranscriptTextItemsForAcpImportFromServer({
                token: deps.token,
                sessionId: deps.sessionId,
                ...transcriptQueryContext,
                take: opts?.take,
            }));
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
            const request = () => runWithServerHttpBaseUrl(serverUrl, async () => fetchLatestUserPermissionIntentFromEncryptedTranscript({
                token: deps.token,
                sessionId: deps.sessionId,
                ...transcriptQueryContext,
                take: opts?.take,
            }));
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
            if (env.DEBUG) {
                logger.debug(`[API] Sending keep alive message: ${thinking}`);
            }
            latestSessionPresence = { thinking, mode };
            deps.onPresence?.(latestSessionPresence);
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
