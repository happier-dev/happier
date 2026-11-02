import { reconcileSessionRequestProjection } from '../sessionTupleApplyCurrentness';
import { reconcileSessionLifecycleProjection } from '../sessionLifecycleProjection';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { readSessionAnswersWorkerQuestionsV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { SessionWorkspaceLocationV1 } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { areSessionBotFacesEqual, type SessionBotV1, type SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import {
    hasUnreadActivityForSessionViewer,
    isSessionPersonallyTrackedForViewer,
    normalizeSessionViewerCompatibility,
} from '@/sync/domains/session/readState/sessionViewer';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { AgentState, Metadata } from '@happier-dev/session-core/state';
import { StoredSessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectSessionDisplayV1, SessionSharedMetadataV1Schema,
    type SessionSemanticDisplayV1, type SessionUsageLimitRecoveryDisplayV1 } from '@happier-dev/protocol';
import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { projectSessionWorkDisplayV1, type SessionWorkDisplayV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary';
import { parseSessionAgentActivityHeadlineV1, type SessionAgentActivityHeadlineV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
import { SessionWorkflowActivityHeadlineV1Schema, type SessionWorkflowActivityHeadlineV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import { SessionGuardStateV1StoredSchema } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import type { ExternalAgentObservationSnapshotV1 } from '@happier-dev/protocol/sessions/external/externalAgentObservationV1';
import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { compareSessionMetadataRevisions, readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { isSessionAccessRecipient } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { isSessionListRenderableOwnerProjection } from './sessionListRenderableSessionProjection';
import { computeHasUnreadActivity } from "@happier-dev/session-core/messages";
import type { Message } from "@happier-dev/session-core/messages";
import { deriveExternalSessionAttentionHasUnread } from '@/sync/domains/session/external/readExternalSessionAttention';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromAgentState,
    derivePendingRequestFlagsFromSession,
    readPendingRequestFactsFromSession,
    type TranscriptRequestStatesCache,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    buildTranscriptRenderableAggregate,
    canReuseTranscriptRenderableAggregateRequestStates,
    type TranscriptRenderableAggregate,
} from './transcriptRenderableAggregate';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import {
    createSessionListReadableActivityAccumulator,
    foldSessionListReadableActivityMessage,
    maxReadSeq,
    normalizeReadSeq,
    type MessageReadableActivityFields,
} from './sessionListReadableActivity';
import { resolveSessionProjectGroupingKeyParts } from './sessionListProjectGroupingKeys';
import { readSessionPresentationCompletedRequests } from '../presentation/readSessionPresentationCompletedRequests';
import { readSessionPresentationAgentId } from '../presentation/readSessionPresentationAgentId';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents';
import { buildBackendTargetKeyV2, type BackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import {
    areSessionListRenderableExternalSessionIdentitiesEqual,
    areSessionListRenderableMetadataComparisonsEqual,
    areSessionListWorkspaceLocationsEqual,
    readSessionListRenderableMetadataComparison,
    readSessionListRenderableMetadataComparisonFromRenderable,
    readSessionListRenderableMetadataComparisonFromDisplay,
    type SessionListRenderableExternalSessionIdentity,
} from './sessionListRenderableMetadataComparison';
import { deriveSessionListMeaningfulActivityAt } from './deriveSessionListActivity';
import {
    projectUiSessionRuntimeAwareness,
    resolveSessionRuntimePresenceFields,
} from '../attention/runtimePresentation';
import { readSessionOwnerMetadataView, SESSION_OWNER_METADATA_PROJECTION } from '../readSessionOwnerMetadataView';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { SESSION_LIST_DOCUMENT_ADMISSION, areSessionListDocumentAdmissionsEqual,
    type SessionListDocumentAdmission } from '../sessionDocumentAdmission';
export { SESSION_LIST_DOCUMENT_ADMISSION, areSessionListDocumentAdmissionsEqual,
    type SessionListDocumentAdmission } from '../sessionDocumentAdmission';

export { derivePendingRequestFlagsFromAgentState } from '@/sync/domains/session/pending/listPendingSessionRequests';

export interface SessionListRenderableMetadata {
    sessionUsageLimitRecoveryV1?: SessionUsageLimitRecoveryV1 | SessionUsageLimitRecoveryDisplayV1 | null;
    /** Process lifecycle fact, retained for the shared status presenter. */
    lifecycleState?: string;
    projectId?: string | null;
    workspaceId?: string | null;
    sessionWorkspaceLocationV1?: SessionWorkspaceLocationV1 | null;
    /** Owner-private last observed branch: missing is unavailable, null is detached. */
    branch?: string | null;
    bot?: SessionBotV1;
    botFace?: SessionBotFaceV1;
    name?: string;
    summaryText?: string | null;
    path: string;
    homeDir?: string | null;
    host?: string | null;
    machineId?: string | null;
    flavor?: string | null;
    externalSessionV1?: SessionListRenderableExternalSessionIdentity | null;
    externalAgentObservationV1?: ExternalAgentObservationSnapshotV1 | null;
    readStateV1?: {
        v: 1;
        sessionSeq: number;
        pendingActivityAt: number;
        updatedAt: number;
    } | null;
    hiddenSystemSession?: boolean;
    /** The no-folder marker, carried so the one classifier (`readSessionDirectoryKind`) reads rows too. */
    sessionDirectoryV1?: Readonly<{ v: 1; kind: 'managed' }> | null;
    terminalControlServiceabilityV1?: {
        v: 1;
        state: 'servable' | 'recoverable_unservable' | 'unknown';
        observedAt: number;
        reason?: string;
    } | null;
}

export type SessionListGuardState =
    | Readonly<{ kind: 'stopping'; stopAt: number; rule: 'idle_sessions' | 'memory_guard' }>
    | Readonly<{ kind: 'stopped'; at: number; rule: 'idle_sessions' | 'memory_guard' | 'ceiling'; idleMs?: number; freedBytes?: number }>;

/**
 * The guard's word for a Session from its content-free guard presentation (plan 50 G3): a stop is
 * coming, or the guard stopped it. A configured ceiling says nothing here. One reader for the list row,
 * the composer status and the wake copy.
 */
export function readSessionListGuardState(raw: unknown): SessionListGuardState | null {
    if (raw === undefined || raw === null) return null;
    const parsed = SessionGuardStateV1StoredSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (parsed.data.kind === 'stopping') return { kind: 'stopping', stopAt: parsed.data.stopAt, rule: parsed.data.rule };
    if (parsed.data.kind === 'stopped') {
        return { kind: 'stopped', at: parsed.data.at, rule: parsed.data.rule,
            ...(parsed.data.idleMs === undefined ? {} : { idleMs: parsed.data.idleMs }),
            ...(parsed.data.freedBytes === undefined ? {} : { freedBytes: parsed.data.freedBytes }) };
    }
    return null;
}

export interface SessionListRenderableSession {
    [SESSION_LIST_DOCUMENT_ADMISSION]?: SessionListDocumentAdmission;
    [SESSION_OWNER_METADATA_PROJECTION]?: Session[typeof SESSION_OWNER_METADATA_PROJECTION];
    forkV1?: NonNullable<SessionSemanticDisplayV1['owner']>['forkV1'];
    /** Admitted canonical Agent target; memory only, never a wire or warm-cache field. */
    agentTargetKey?: BackendTargetKeyV2 | null;
    /**
     * Owner-readable compact Agent roster. This is deliberately a parsed
     * projection rather than raw owner metadata so the concurrently cached,
     * Home-qualified list row remains the one safe cold-open source for Agent
     * activity when equal Session ids exist on different Homes.
     */
    agentActivityHeadline?: SessionAgentActivityHeadlineV1 | null;
    workDisplay?: SessionWorkDisplayV1 | null;
    workflowHeadline?: SessionWorkflowActivityHeadlineV1 | null;
    /** The guard's word for this row (plan 50 G3-2): a stop is coming, or the guard stopped it. */
    guardState?: SessionListGuardState | null;
    /** Memory-only owner facts for question captions, not answer admission or warm-cache authority. */
    workerQuestionHandling?: Readonly<{ answersWorkerQuestions: boolean; explicitlyStopped: boolean }> | null;
    encryptionMode?: Session["encryptionMode"];
    encryptedContentAvailability?: Session['encryptedContentAvailability'];
    /** Store-produced recipient-safe title; memory only, never metadata or a wire/cache field. */
    lockedDisplayTitle?: Session['lockedDisplayTitle'];
    id: string;
    /** Qualified memory-only source; never serialized by wire or warm-cache mappers. */
    serverId?: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    meaningfulActivityAt?: number | null;
    active: boolean;
    activeAt: number;
    archivedAt?: number | null;
    pendingVersion?: number;
    pendingCount?: number;
    pendingBlockedCount?: number;
    pendingActivationAuthorization?: PendingActivationAuthorizationV1 | null;
    lastViewedSessionSeq?: number | null;
    unreadSince?: number | null;
    viewer?: SessionViewerProjectionV1;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    rollbackEligibleTurnStarts?: readonly number[] | null;
    latestReadyEventSeq?: number | null;
    latestReadyEventAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    runtimeActivityActiveCount?: number | null;
    runtimeActivityState?: 'active' | 'idle' | 'unknown' | null;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityRevision?: number | null;
    lastTurnCompletedAt?: number | null;
    /** The Session this one reports to (ORC R-03), for the list tree. */
    manager?: Session['manager'];
    origin?: Session['origin'];
    ownerAccountId?: Session['ownerAccountId'];
    workDepth?: Session['workDepth'];
    /** Direct reports, counted by the server (the lead row's sub-session chip). */
    managedSessions?: Session['managedSessions'];
    receivedRuleCount?: Session['receivedRuleCount'];
    metadataLayoutVersion?: number;
    metadataVersion: number;
    agentStateVersion: number;
    metadata: SessionListRenderableMetadata | null;
    thinking: boolean;
    thinkingAt: number;
    /** Device-observed runtime presence; absent when only durable Session facts were acquired. */
    presence?: 'online' | number;
    optimisticThinkingAt?: number | null;
    resumingAt?: number | null;
    thinkingGraceUntil?: number | null;
    owner?: string;
    access?: Session['access'];
    responsibleAccountId?: Session['responsibleAccountId'];
    responsibleAccount?: Session['responsibleAccount'];
    /** Audience fact the transcript authorship owner reads for the exact Home. */
    hasOtherNamedCollaborator?: Session['hasOtherNamedCollaborator'];
    accessLevel?: 'view' | 'edit' | 'admin';
    canApprovePermissions?: boolean;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
    pendingRequestObservedAt?: number | null;
    hasUnreadMessages?: boolean;
    /** Derived client operation presentation; never persisted as runtime authority. */
    archiving?: boolean;
    keepVisibleWhenInactive?: boolean;
    metadataUnavailable?: boolean;
}

export type SessionListRenderablePatchFields = Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;

/** Compact display facts shared by scoped list rows and live-carrier captions. */
export function readSessionWorkerQuestionHandlingProjection(
    metadata: Metadata | null,
): NonNullable<SessionListRenderableSession['workerQuestionHandling']> | null {
    if (!metadata) return null;
    const stop = readSessionExplicitStopV1FromMetadata(metadata);
    return {
        answersWorkerQuestions: readSessionAnswersWorkerQuestionsV1(metadata),
        explicitlyStopped: Boolean(stop && !('status' in stop)),
    };
}

export type SessionListRenderableFieldSnapshot = Readonly<{
    active: boolean;
    createdAt: number;
    updatedAt: number;
    meaningfulActivityAt: number | null;
    activeAt: number;
    archivedAt: number | null;
    pendingVersion: number | null;
    pendingCount: number | null;
    pendingBlockedCount: number | null;
    lastViewedSessionSeq: number | null;
    metadataVersion: number;
    agentStateVersion: number;
    accessLevel: SessionListRenderableSession['accessLevel'] | null;
    canApprovePermissions: boolean | null;
    hasPendingPermissionRequests: boolean | null;
    hasPendingUserActionRequests: boolean | null;
    pendingRequestObservedAt: number | null;
    keepVisibleWhenInactive: boolean;
    metadata: ReturnType<typeof readSessionListRenderableMetadataComparisonFromRenderable>;
}>;

export type SessionListReadableActivitySummary = Readonly<{
    latestCommittedMessageSeq: number | null;
    latestCommittedMessageCreatedAt: number | null;
}>;

type SessionListRenderableStaleFieldSource = Readonly<{
    active?: boolean;
    agentState?: AgentState | null | undefined;
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
    pendingBlockedCount?: number;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
}>;

export function summarizeSessionListReadableActivityFromMessageRecords(
    messageIds: ReadonlyArray<string> | undefined,
    messagesById: Readonly<Record<string, MessageReadableActivityFields | undefined>> | null | undefined,
    aggregate?: Pick<TranscriptRenderableAggregate, 'latestCommittedMessageSeq' | 'latestCommittedMessageCreatedAt'> | null,
): SessionListReadableActivitySummary | undefined {
    if (!Array.isArray(messageIds)) return undefined;
    if (aggregate) {
        // The store updates or invalidates this aggregate with each message change.
        // Copy primitives rather than retaining the mutable aggregate.
        return {
            latestCommittedMessageSeq: aggregate.latestCommittedMessageSeq,
            latestCommittedMessageCreatedAt: aggregate.latestCommittedMessageCreatedAt,
        };
    }

    const accumulator = createSessionListReadableActivityAccumulator();
    for (const messageId of messageIds) {
        const message = messagesById?.[messageId];
        if (!message) continue;
        foldSessionListReadableActivityMessage(accumulator, message);
    }

    return {
        latestCommittedMessageSeq: accumulator.latestCommittedMessageSeq,
        latestCommittedMessageCreatedAt: accumulator.latestCommittedMessageCreatedAt,
    };
}

function normalizeLastViewedSessionSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function normalizeReadyEventAt(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function normalizeRollbackEligibleTurnStarts(value: readonly number[] | null | undefined): readonly number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const normalized = value
        .filter((item) => typeof item === 'number' && Number.isFinite(item))
        .map((item) => Math.max(0, Math.trunc(item)));
    return normalized.length > 0 ? normalized : undefined;
}

function areRollbackEligibleTurnStartsEqual(
    previous: readonly number[] | null | undefined,
    next: readonly number[] | null | undefined,
): boolean {
    const previousStarts = normalizeRollbackEligibleTurnStarts(previous) ?? [];
    const nextStarts = normalizeRollbackEligibleTurnStarts(next) ?? [];
    if (previousStarts.length !== nextStarts.length) return false;
    for (let index = 0; index < previousStarts.length; index += 1) {
        if (previousStarts[index] !== nextStarts[index]) return false;
    }
    return true;
}

export function areResponsibleAccountSummariesEqual(
    previous: Session['responsibleAccount'],
    next: Session['responsibleAccount'],
): boolean {
    if (previous === next) return true;
    if (previous == null || next == null) return previous === next;
    return previous.kind === next.kind
        && previous.accountId === next.accountId
        && previous.firstName === next.firstName
        && previous.lastName === next.lastName
        && previous.username === next.username
        && previous.avatarUrl === next.avatarUrl;
}

function deriveSessionListRenderableExternalSessionUnread(
    metadata: Metadata | null | undefined,
): boolean | null {
    if (!readExternalSessionLink(metadata)) {
        return null;
    }
    return deriveExternalSessionAttentionHasUnread(metadata);
}

export function readSessionListRenderableSourceMetadata(
    session: Pick<
        Session,
        'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'accessLevel' | 'access'
    >,
): Metadata | null {
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    if (metadataLayoutVersion === 0) {
        const metadata = session.metadata;
        if (!metadata) return metadata;
        const agentId = readSessionPresentationAgentId(session);
        return metadata.flavor === agentId ? metadata : { ...metadata, flavor: agentId };
    }
    if (metadataLayoutVersion !== 1) {
        return null;
    }
    if (isSessionAccessRecipient(session.access, session.accessLevel)) {
        const sharedMetadata = StoredSessionSharedMetadataV1Schema.safeParse(session.metadata);
        if (!sharedMetadata.success) return null;
        const presentationAgentId = sharedMetadata.data.agentPresentation?.agentId;
        return {
            ...sharedMetadata.data,
            ...(presentationAgentId ? { flavor: presentationAgentId } : {}),
        } as unknown as Metadata;
    }
    const ownerMetadata = readSessionOwnerMetadataView(session);
    if (!ownerMetadata) return null;
    const sharedMetadata = StoredSessionSharedMetadataV1Schema.safeParse(session.metadata);
    // In layout 1 the compact row's Agent identity comes from the public presentation,
    // even when the owner's runtime configuration names a different Agent.
    return { ...ownerMetadata, flavor: sharedMetadata.success ? sharedMetadata.data.agentPresentation?.agentId : undefined };
}

export function deriveSessionListRenderableHasUnreadMessagesFromSession(
    session: Pick<Session, 'seq' | 'metadata' | 'lastViewedSessionSeq'>
        & Partial<Pick<
            Session,
            'latestTurnStatus' | 'latestReadyEventSeq' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'accessLevel' | 'access'
            | 'viewer'
        >>,
    readableActivity?: SessionListReadableActivitySummary,
): boolean {
    const viewer = normalizeSessionViewerCompatibility(session);
    if (viewer.kind === 'current') return hasUnreadActivityForSessionViewer(viewer.viewer);
    if (viewer.kind === 'untracked') return false;
    const metadata = readSessionListRenderableSourceMetadata({
        metadata: session.metadata,
        metadataLayoutVersion: session.metadataLayoutVersion,
        ownerMetadataView: session.ownerMetadataView,
        access: session.access,
        accessLevel: session.accessLevel,
    });
    const externalSessionHasUnread = deriveSessionListRenderableExternalSessionUnread(metadata);
    if (externalSessionHasUnread !== null) {
        return externalSessionHasUnread;
    }

    return computeHasUnreadActivity({
        sessionSeq: resolveSessionListReadableSeq(session, readableActivity),
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
        lastViewedPendingActivityAt: metadata?.readStateV1?.pendingActivityAt,
    });
}

export function deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch(params: Readonly<{
    viewer?: unknown;
    owner?: string;
    access?: SessionListRenderableSession['access'];
    accessLevel?: SessionListRenderableSession['accessLevel'];
    metadata: Metadata | null | undefined;
    nextSessionSeq: number;
    nextLastViewedSessionSeq?: number | null;
    nextLatestTurnStatus?: PrimaryTurnStatusV1 | null;
    nextLatestReadyEventSeq?: number | null;
    readableActivity?: SessionListReadableActivitySummary;
    previousHasUnreadMessages?: boolean;
    recomputeUnread?: boolean;
}>): boolean {
    const viewer = normalizeSessionViewerCompatibility(params);
    if (viewer.kind === 'current') return hasUnreadActivityForSessionViewer(viewer.viewer);
    if (viewer.kind === 'untracked') return false;
    if (params.metadata !== undefined) {
        const externalSessionHasUnread = deriveSessionListRenderableExternalSessionUnread(params.metadata);
        if (externalSessionHasUnread !== null) {
            return externalSessionHasUnread;
        }
    }

    if (
        params.recomputeUnread === true
        || params.metadata !== undefined
    ) {
        return computeHasUnreadActivity({
            sessionSeq: resolveSessionListReadableSeq({
                seq: params.nextSessionSeq,
                latestTurnStatus: params.nextLatestTurnStatus,
                latestReadyEventSeq: params.nextLatestReadyEventSeq,
            }, params.readableActivity),
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq({
                lastViewedSessionSeq: params.nextLastViewedSessionSeq,
                metadata: params.metadata,
            }),
            lastViewedPendingActivityAt: params.metadata?.readStateV1?.pendingActivityAt,
        });
    }

    return params.previousHasUnreadMessages === true;
}

function shouldPreserveSessionListRenderablePendingFlags(
    current: SessionListRenderableStaleFieldSource,
    previous: SessionListRenderableSession | undefined,
): boolean {
    return (
        current.active === true
        && current.agentState == null
        && typeof current.pendingPermissionRequestCount !== 'number'
        && typeof current.pendingUserActionRequestCount !== 'number'
        && typeof current.hasPendingPermissionRequests !== 'boolean'
        && typeof current.hasPendingUserActionRequests !== 'boolean'
        && typeof previous?.hasPendingPermissionRequests === 'boolean'
        && typeof previous?.hasPendingUserActionRequests === 'boolean'
    );
}

function shouldPreserveSessionListRenderablePendingBlockedCount(
    current: SessionListRenderableStaleFieldSource,
    previous: SessionListRenderableSession | undefined,
): boolean {
    return (
        current.active === true
        && current.agentState == null
        && typeof current.pendingBlockedCount !== 'number'
        && typeof previous?.pendingBlockedCount === 'number'
    );
}

/**
 * The input of the one row projector. `metadataUndecided` is set only by a list refresh that
 * opened no key: its Session carries no decrypted projection, so an owner view is undecided rather
 * than unavailable, and the projection the previous row holds for the same layout is kept.
 */
export type SessionListRenderableSource = Session & Readonly<{
    metadataUndecided?: true;
    [SESSION_LIST_DOCUMENT_ADMISSION]?: SessionListDocumentAdmission;
}>;

export function buildSessionListRenderableFromSession(
    session: SessionListRenderableSource,
    previous?: SessionListRenderableSession,
    messages?: ReadonlyArray<Message>,
    transcriptAggregate?: TranscriptRenderableAggregate | null,
    openedDisplay?: SessionSemanticDisplayV1,
): SessionListRenderableSession {
    // Single derivation path: the transcript folds live in the aggregate.
    // Hot callers (store streaming refresh) pass an incrementally-maintained
    // aggregate; cold callers pass messages and pay one full walk here.
    const completedRequests = readSessionPresentationCompletedRequests(session);
    const aggregate = (() => {
        if (transcriptAggregate && canReuseTranscriptRenderableAggregateRequestStates(transcriptAggregate, completedRequests)) {
            return transcriptAggregate;
        }
        if (messages) {
            return buildTranscriptRenderableAggregate({ messages, completedRequests });
        }
        return null;
    })();
    const statesCache: TranscriptRequestStatesCache = aggregate ? { states: aggregate.requestStates } : {};
    const renderableSourceMetadata = readSessionListRenderableSourceMetadata(session);
    const ownerProjection = isSessionListRenderableOwnerProjection(session);
    const strictShared = readSessionMetadataLayoutVersion(session.metadataLayoutVersion) === 1
        ? SessionSharedMetadataV1Schema.safeParse(session.metadata) : null;
    const ownerWitness = session[SESSION_OWNER_METADATA_PROJECTION];
    const display = openedDisplay ?? (strictShared?.success && (!ownerProjection
        || ownerWitness?.admittedMetadataVersion === session.metadataVersion)
        ? projectSessionDisplayV1({ sharedMetadata: strictShared.data,
            ...(ownerProjection && ownerWitness ? { ownerMetadata: ownerWitness.ownerMetadata } : {}) })
        : undefined);
    const metadataUndecided = session.metadataUndecided === true;
    const layout1OwnerMetadataUnavailable =
        ownerProjection
        && !metadataUndecided
        && renderableSourceMetadata == null && display === undefined;
    const preserveMetadata =
        display === undefined && !layout1OwnerMetadataUnavailable
        // A settled layout-1 lock retains only the store's safe title, not old metadata fields.
        && (readSessionMetadataLayoutVersion(session.metadataLayoutVersion) !== 1 || metadataUndecided)
        && (renderableSourceMetadata == null || (ownerProjection && metadataUndecided))
        && previous?.metadata != null
        && readSessionMetadataLayoutVersion(session.metadataLayoutVersion)
            === readSessionMetadataLayoutVersion(previous.metadataLayoutVersion);
    const preservePendingFlags = shouldPreserveSessionListRenderablePendingFlags(session, previous);
    const hasPendingEvidence = preservePendingFlags
        || (metadataUndecided && typeof previous?.hasPendingPermissionRequests === 'boolean'
            && typeof previous.hasPendingUserActionRequests === 'boolean')
        || (
            typeof session.pendingPermissionRequestCount === 'number'
            && typeof session.pendingUserActionRequestCount === 'number'
        )
        || session.agentState !== null
        || aggregate !== null;
    const suppressPendingAttention = session.active !== true;
    const pending = (() => {
        if (suppressPendingAttention) return derivePendingRequestFlagsFromAgentState(
            readPendingRequestFactsFromSession(session).actionConfirmations,
        );
        if (preservePendingFlags && previous) {
            return {
                hasPendingPermissionRequests: previous.hasPendingPermissionRequests,
                hasPendingUserActionRequests: previous.hasPendingUserActionRequests,
            };
        }
        return derivePendingRequestFlagsFromSession(session, messages, statesCache);
    })();
    const pendingRequestObservedAt = (() => {
        if (suppressPendingAttention) return null;
        if (preservePendingFlags && previous) return previous.pendingRequestObservedAt ?? null;
        return deriveLatestPendingRequestObservedAtFromSession(session, messages, statesCache);
    })();
    const previousMetadata: ReturnType<typeof readSessionListRenderableMetadataComparisonFromRenderable> = previous?.metadata
        ? readSessionListRenderableMetadataComparisonFromRenderable(previous.metadata)
        : null;
    const currentMetadata = display ? readSessionListRenderableMetadataComparisonFromDisplay(display, previousMetadata)
        : readSessionListRenderableMetadataComparison(renderableSourceMetadata, previousMetadata);
    // An undecided Session can still carry proved owner visibility. Preserve readable
    // row details until shared content is demanded, while applying current owner identity/visibility.
    const nextMetadata: ReturnType<typeof readSessionListRenderableMetadataComparisonFromRenderable> = preserveMetadata
        ? ownerProjection && metadataUndecided && currentMetadata && previousMetadata
            ? { ...previousMetadata, name: currentMetadata.name, hiddenSystemSession: currentMetadata.hiddenSystemSession }
            : previousMetadata
        : currentMetadata;
    const titleFallbackMessages = aggregate
        ? (aggregate.firstUserTextMessage ? [aggregate.firstUserTextMessage] : [])
        : messages;
    const lockedDisplayTitle = display === undefined && session.metadataLayoutVersion === 1
        && session.metadata === null
        && isSessionAccessRecipient(session.access, session.accessLevel)
        ? readSessionDisplayTitleField({ lockedDisplayTitle: session.lockedDisplayTitle }).value
        : null;
    const displayTitle = readSessionDisplayTitleField({ metadata: nextMetadata }, {
        messages: titleFallbackMessages,
        // A metadata-only hydration can precede the transcript. Keep the
        // already projected readable title without reviving a retired locked title.
        fallbackTitle: previous?.id === session.id
            && readSessionMetadataLayoutVersion(previous.metadataLayoutVersion)
                === readSessionMetadataLayoutVersion(session.metadataLayoutVersion)
            ? readSessionDisplayTitleField({ metadata: previous.metadata }).value
            : null,
    }).value;
    const projectedMetadata = nextMetadata && displayTitle && displayTitle !== nextMetadata.summaryText
        ? { ...nextMetadata, summaryText: displayTitle }
        : nextMetadata;
    const readableActivity: SessionListReadableActivitySummary | undefined = aggregate
        ? {
            latestCommittedMessageSeq: aggregate.latestCommittedMessageSeq,
            latestCommittedMessageCreatedAt: aggregate.latestCommittedMessageCreatedAt,
        }
        : undefined;
    const latestCommittedMessageCreatedAt = readableActivity?.latestCommittedMessageCreatedAt ?? null;
    const latestReadyEventSeq =
        normalizeLastViewedSessionSeq(session.latestReadyEventSeq)
        ?? previous?.latestReadyEventSeq
        ?? null;
    const latestReadyEventAt =
        normalizeReadyEventAt(session.latestReadyEventAt)
        ?? previous?.latestReadyEventAt
        ?? null;
    const latestTurnStatus = session.latestTurnStatus;
    const latestTurnStatusObservedAt = session.latestTurnStatusObservedAt;
    const runtimePresence = resolveSessionRuntimePresenceFields({
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus,
        latestTurnStatusObservedAt,
    });
    // Use the Agent activity reader rather than a whole-headline schema parse:
    // it is the protocol's forward-compatible entry filter, so one newer entry
    // cannot erase every otherwise readable row from a concurrent Home list.
    const agentActivityHeadline = parseSessionAgentActivityHeadlineV1(
        display ? display.owner?.sessionAgentActivityHeadlineV1 : renderableSourceMetadata?.sessionAgentActivityHeadlineV1,
    );
    const parsedWorkflow = SessionWorkflowActivityHeadlineV1Schema.safeParse(display
        ? display.owner?.sessionWorkflowActivityHeadlineV1 : renderableSourceMetadata?.sessionWorkflowActivityHeadlineV1);
    const workDisplay = display ? display.owner?.workDisplay ?? null : projectSessionWorkDisplayV1(renderableSourceMetadata
        ? session.workDisplay !== undefined ? session.workDisplay : readSessionWorkStateV1FromMetadata(renderableSourceMetadata)
        : null);
    const workflowHeadline = parsedWorkflow.success ? parsedWorkflow.data : null;
    const guardState = readSessionListGuardState(display ? display.shared.sessionGuardStateV1 : renderableSourceMetadata?.sessionGuardStateV1);
    const workerQuestionHandling = readSessionMetadataLayoutVersion(session.metadataLayoutVersion) === 0 || ownerProjection
        ? metadataUndecided || preserveMetadata
            ? previous?.workerQuestionHandling ?? null
            : readSessionWorkerQuestionHandlingProjection(readSessionOwnerMetadataView(session))
        : null;
    const agentTarget = !preserveMetadata && renderableSourceMetadata
        ? resolveAgentExecutionTargetFromSessionMetadata(renderableSourceMetadata,
            typeof renderableSourceMetadata.flavor === 'string' ? renderableSourceMetadata.flavor : null)
        : null;
    // A display does not contain the private recipe that can override public Agent identity.
    const previousTargetCurrent = previous?.metadataVersion === session.metadataVersion
        && areSessionListDocumentAdmissionsEqual(previous?.[SESSION_LIST_DOCUMENT_ADMISSION], session[SESSION_LIST_DOCUMENT_ADMISSION])
        && (session[SESSION_LIST_DOCUMENT_ADMISSION]?.observedMetadataVersion ?? session.metadataVersion) <= session.metadataVersion;
    const agentTargetKey = (session[SESSION_LIST_DOCUMENT_ADMISSION]?.observedMetadataVersion ?? session.metadataVersion) > session.metadataVersion
        ? undefined
        : metadataUndecided || preserveMetadata
            ? previousTargetCurrent ? previous?.agentTargetKey : undefined
            : agentTarget ? buildBackendTargetKeyV2(agentTarget) : null;
    const next: SessionListRenderableSession = {
        ...(session[SESSION_LIST_DOCUMENT_ADMISSION]
            ? { [SESSION_LIST_DOCUMENT_ADMISSION]: session[SESSION_LIST_DOCUMENT_ADMISSION] } : {}),
        forkV1: display ? display.owner?.forkV1 : renderableSourceMetadata?.forkV1,
        agentTargetKey,
        agentActivityHeadline: JSON.stringify(previous?.agentActivityHeadline ?? null) === JSON.stringify(agentActivityHeadline)
            ? previous?.agentActivityHeadline ?? null
            : agentActivityHeadline,
        workDisplay: JSON.stringify(previous?.workDisplay ?? null) === JSON.stringify(workDisplay) ? previous?.workDisplay ?? null : workDisplay,
        workflowHeadline: JSON.stringify(previous?.workflowHeadline ?? null) === JSON.stringify(workflowHeadline) ? previous?.workflowHeadline ?? null : workflowHeadline,
        guardState: JSON.stringify(previous?.guardState ?? null) === JSON.stringify(guardState) ? previous?.guardState ?? null : guardState,
        workerQuestionHandling:
            previous?.workerQuestionHandling?.answersWorkerQuestions === workerQuestionHandling?.answersWorkerQuestions
            && previous?.workerQuestionHandling?.explicitlyStopped === workerQuestionHandling?.explicitlyStopped
                ? previous?.workerQuestionHandling ?? null : workerQuestionHandling,
        id: session.id,
        serverId: session.serverId ?? previous?.serverId,
        seq: session.seq,
        encryptionMode: session.encryptionMode,
        encryptedContentAvailability: session.encryptedContentAvailability,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        meaningfulActivityAt: deriveSessionListMeaningfulActivityAt({
            sessionMeaningfulActivityAt: session.meaningfulActivityAt,
            latestCommittedMessageCreatedAt: latestCommittedMessageCreatedAt !== null && latestReadyEventAt !== null
                ? Math.max(latestCommittedMessageCreatedAt, latestReadyEventAt)
                : latestCommittedMessageCreatedAt ?? latestReadyEventAt,
            latestPendingMessageCreatedAt: null,
            sessionCreatedAt: session.createdAt,
        }),
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        pendingActivationAuthorization: session.pendingActivationAuthorization ?? null,
        lastViewedSessionSeq: normalizeLastViewedSessionSeq(session.lastViewedSessionSeq),
        viewer: session.viewer,
        latestTurnId: readSessionLatestTurnId(session),
        latestTurnStatus,
        latestTurnStatusObservedAt,
        rollbackEligibleTurnStarts: normalizeRollbackEligibleTurnStarts(session.rollbackEligibleTurnStarts),
        latestReadyEventSeq,
        latestReadyEventAt,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        runtimeActivityState: session.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: session.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session.runtimeActivityRevision ?? null,
        lastTurnCompletedAt: session.lastTurnCompletedAt ?? null,
        origin: previous?.origin?.kind === session.origin?.kind && previous?.origin?.runId === session.origin?.runId
            ? previous?.origin ?? session.origin : session.origin,
        workDepth: session.workDepth,
        ownerAccountId: session.ownerAccountId,
        receivedRuleCount: session.receivedRuleCount,
        manager: readSessionManagerSessionIdV1(session) === readSessionManagerSessionIdV1(previous)
            ? previous?.manager ?? session.manager ?? null
            : session.manager ?? null,
        managedSessions: JSON.stringify(previous?.managedSessions ?? null) === JSON.stringify(session.managedSessions ?? null)
            ? previous?.managedSessions ?? null
            : session.managedSessions ?? null,
        metadataLayoutVersion: preserveMetadata && previous
            ? previous.metadataLayoutVersion
            : session.metadataLayoutVersion,
        metadataVersion: preserveMetadata && previous ? previous.metadataVersion : session.metadataVersion,
        agentStateVersion: preservePendingFlags && previous ? previous.agentStateVersion : session.agentStateVersion,
        lockedDisplayTitle,
        [SESSION_OWNER_METADATA_PROJECTION]: session[SESSION_OWNER_METADATA_PROJECTION] ?? null,
        metadata: previous && areSessionListRenderableMetadataComparisonsEqual(previousMetadata, projectedMetadata)
            ? previous.metadata
            : projectedMetadata,
        thinking: runtimePresence.thinking,
        thinkingAt: runtimePresence.thinkingAt,
        // Preserve omission through projection: the scoped store, rather than
        // a cached metadata source, owns the current runtime observation.
        ...(Object.prototype.hasOwnProperty.call(session, 'presence') ? { presence: session.presence } : {}),
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        resumingAt: session.resumingAt ?? null,
        thinkingGraceUntil: session.thinkingGraceUntil ?? null,
        owner: session.owner,
        access: session.access,
        ...(Object.prototype.hasOwnProperty.call(session, 'responsibleAccountId')
            ? { responsibleAccountId: session.responsibleAccountId }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(session, 'responsibleAccount')
            ? { responsibleAccount: session.responsibleAccount }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(session, 'hasOtherNamedCollaborator')
            ? { hasOtherNamedCollaborator: session.hasOtherNamedCollaborator }
            : {}),
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        ...(hasPendingEvidence
            ? {
                hasPendingPermissionRequests: pending.hasPendingPermissionRequests,
                hasPendingUserActionRequests: pending.hasPendingUserActionRequests,
            }
            : {}),
        pendingRequestObservedAt,
        hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromSession({
            ...session,
            latestReadyEventSeq,
        }, readableActivity),
        // An undecided Session can carry a readable owner-only visibility view even
        // before its Session key or shared metadata is demanded.
        metadataUnavailable: ownerProjection
            ? metadataUndecided
                ? display || preserveMetadata || renderableSourceMetadata != null ? false : undefined
                : layout1OwnerMetadataUnavailable
            : undefined,
    };

    const withPendingProjection = preserveSessionListRenderablePendingFlags(previous, next);
    return previous && areSessionListRenderablesEqual(previous, withPendingProjection) ? previous : withPendingProjection;
}

export function resolveSessionListReadableSeq(
    session: Pick<Session, 'seq'> & Partial<Pick<Session, 'latestTurnStatus' | 'latestReadyEventSeq'>>,
    readableActivity: SessionListReadableActivitySummary | undefined,
): number {
    const hasCommittedMessageAttentionProjection = readableActivity !== undefined;
    const sessionSeq = normalizeReadSeq(session.seq) ?? 0;
    let readableSeq: number | null = readableActivity?.latestCommittedMessageSeq ?? null;
    readableSeq = maxReadSeq(readableSeq, normalizeReadSeq(session.latestReadyEventSeq));

    if (!hasCommittedMessageAttentionProjection && isTerminalTurnStatus(session.latestTurnStatus)) {
        readableSeq = maxReadSeq(readableSeq, sessionSeq);
    }

    return readableSeq ?? 0;
}

function isTerminalTurnStatus(value: unknown): value is Exclude<PrimaryTurnStatusV1, 'in_progress'> {
    return value === 'completed' || value === 'cancelled' || value === 'failed';
}

function readSessionLatestTurnId(session: Session): string | null {
    const value = session.latestTurnId;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function preserveSessionListRenderableTransientState(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
    options?: Readonly<{ preserveResumingAt?: boolean }>,
): SessionListRenderableSession {
    const presence = Object.prototype.hasOwnProperty.call(next, 'presence')
        ? next.presence
        : previous?.presence;
    const keepVisibleWhenInactive = previous?.keepVisibleWhenInactive === true
        ? true
        : next.keepVisibleWhenInactive;
    const resumingAt = options?.preserveResumingAt === false
        ? next.resumingAt ?? null
        : previous?.resumingAt ?? next.resumingAt ?? null;
    if (
        next.keepVisibleWhenInactive === keepVisibleWhenInactive
        && (next.resumingAt ?? null) === resumingAt
        && next.presence === presence
    ) {
        return next;
    }

    return {
        ...next,
        presence,
        keepVisibleWhenInactive,
        resumingAt,
    };
}

function preserveSessionListRenderablePendingFlags(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): SessionListRenderableSession {
    if (!previous) return next;
    next = reconcileSessionRequestProjection(previous, next);
    const preserveMissingFlags = shouldPreserveSessionListRenderablePendingFlags(next, previous);
    const omittedEmptyProjection = previous.hasPendingPermissionRequests === false
        && previous.hasPendingUserActionRequests === false
        && next.hasPendingPermissionRequests === undefined
        && next.hasPendingUserActionRequests === undefined;
    if (!preserveMissingFlags && !omittedEmptyProjection) return next;
    const retainedPendingProjection = {
        ...next,
        agentStateVersion: preserveMissingFlags ? previous.agentStateVersion : next.agentStateVersion,
        hasPendingPermissionRequests: previous.hasPendingPermissionRequests,
        hasPendingUserActionRequests: previous.hasPendingUserActionRequests,
        pendingRequestObservedAt: preserveMissingFlags ? previous.pendingRequestObservedAt ?? null : next.pendingRequestObservedAt,
    };
    if (preserveMissingFlags) return retainedPendingProjection;
    // An unopened inactive replay can omit proved-empty flags. Retain them only
    // when the canonical comparison proves the entire row, including tuple and
    // authority, otherwise unchanged. New evidence still owns its projection.
    return areSessionListRenderablesEqual(previous, retainedPendingProjection)
        ? previous
        : next;
}

export function preserveSessionListRenderableStaleFields(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): SessionListRenderableSession {
    // A compact refresh may observe a different key/audience before its documents open.
    // Last-known-good content cannot cross that custody boundary during store reconciliation.
    if (next[SESSION_LIST_DOCUMENT_ADMISSION]
        && !areSessionListDocumentAdmissionsEqual(previous?.[SESSION_LIST_DOCUMENT_ADMISSION], next[SESSION_LIST_DOCUMENT_ADMISSION])) {
        previous = undefined;
    }
    next = preserveSessionListRenderablePendingFlags(previous, reconcileSessionLifecycleProjection(previous, next));
    // A projection pass re-derives every renderable, so an unchanged session still arrives as a
    // fresh object. Handing that object on defeats identity all the way up the session list: the row
    // is rebuilt around it, then the array, then the whole list re-renders. Returning the previous
    // renderable when nothing changed is what keeps those reuse checks working.
    // `areSessionListRenderablesEqual` is the canonical full-field comparison — it already covers
    // seq, timestamps, `metadataLayoutVersion`, `metadataUnavailable` and the normalized metadata
    // comparison — so this adds no second notion of "unchanged".
    if (previous && areSessionListRenderablesEqual(previous, next)) return previous;

    const preserveMetadata =
        next.metadataUnavailable !== true
        && previous?.metadata != null
        && readSessionMetadataLayoutVersion(next.metadataLayoutVersion)
            === readSessionMetadataLayoutVersion(previous.metadataLayoutVersion)
        && (next.metadata == null || compareSessionMetadataRevisions({
            incomingLayoutVersion: next.metadataLayoutVersion,
            incomingMetadataVersion: next.metadataVersion,
            storedLayoutVersion: previous.metadataLayoutVersion,
            storedMetadataVersion: previous.metadataVersion,
        }) < 0);
    const preserveMetadataUnavailable =
        !preserveMetadata
        && next.metadata == null
        && previous?.metadata == null
        && previous?.metadataUnavailable === true;
    const preservePendingBlockedCount = shouldPreserveSessionListRenderablePendingBlockedCount(next, previous);
    const preserveExternalSessionClassification =
        previous?.metadata?.externalSessionV1 != null
        && next.metadata != null
        && next.metadata.externalSessionV1 == null
        && readSessionMetadataLayoutVersion(previous.metadataLayoutVersion)
            === readSessionMetadataLayoutVersion(next.metadataLayoutVersion)
        && previous.metadataVersion === next.metadataVersion;
    const preserveUnread = isSessionPersonallyTrackedForViewer(next)
        && next.viewer === undefined
        && previous?.hasUnreadMessages === true
        && next.hasUnreadMessages !== true;

    if (
        previous == null
        || (
            !preserveMetadata
            && !preserveMetadataUnavailable
            && !preservePendingBlockedCount
            && !preserveExternalSessionClassification
            && !preserveUnread
        )
    ) {
        return next;
    }

    const nextMetadata = preserveMetadata
        ? previous.metadata
        : preserveExternalSessionClassification
            ? {
                ...(next.metadata as SessionListRenderableMetadata),
                externalSessionV1: previous.metadata?.externalSessionV1 ?? null,
            }
            : next.metadata;

    const latestReadyEventSeq = next.latestReadyEventSeq ?? null;
    const latestReadyEventAt = next.latestReadyEventAt ?? null;
    const nextReadableSeq = resolveSessionListReadableSeq({
        seq: next.seq,
        latestTurnStatus: next.latestTurnStatus,
        latestReadyEventSeq,
    }, undefined);
    let hasUnreadMessages = next.hasUnreadMessages;
    if (
        isSessionPersonallyTrackedForViewer(next)
        && next.viewer === undefined
        && previous.hasUnreadMessages === true
        && next.hasUnreadMessages !== true
    ) {
        hasUnreadMessages = nextReadableSeq > 0
            ? computeHasUnreadActivity({
                sessionSeq: nextReadableSeq,
                pendingActivityAt: 0,
                lastViewedSessionSeq: resolveLastViewedSessionSeq({
                    lastViewedSessionSeq: next.lastViewedSessionSeq,
                    metadata: nextMetadata,
                }),
                lastViewedPendingActivityAt: nextMetadata?.readStateV1?.pendingActivityAt,
            })
            : resolveSessionListReadableSeq(next, undefined) <= 0;
    }

    return {
        ...next,
        agentTargetKey: preserveMetadata && previous.metadataVersion >= next.metadataVersion
            && areSessionListDocumentAdmissionsEqual(previous[SESSION_LIST_DOCUMENT_ADMISSION], next[SESSION_LIST_DOCUMENT_ADMISSION])
            && (next[SESSION_LIST_DOCUMENT_ADMISSION]?.observedMetadataVersion ?? next.metadataVersion) <= previous.metadataVersion
            ? previous.agentTargetKey : next.agentTargetKey,
        // This compact roster is derived from the same owner-metadata read as
        // the display projection. A transient unavailable read must not erase
        // a previously authenticated Home-qualified headline and make only a
        // background same-id Session appear empty.
        agentActivityHeadline: preserveMetadata
            ? previous.agentActivityHeadline ?? null
            : next.agentActivityHeadline ?? null,
        workerQuestionHandling: preserveMetadata
            && (readSessionMetadataLayoutVersion(next.metadataLayoutVersion) === 0 || isSessionListRenderableOwnerProjection(next))
                ? previous.workerQuestionHandling ?? null
                : next.workerQuestionHandling ?? null,
        latestReadyEventSeq,
        latestReadyEventAt,
        pendingBlockedCount: preservePendingBlockedCount
            ? previous.pendingBlockedCount
            : next.pendingBlockedCount,
        metadataLayoutVersion: preserveMetadata
            ? previous.metadataLayoutVersion
            : next.metadataLayoutVersion,
        metadataVersion: preserveMetadata ? previous.metadataVersion : next.metadataVersion,
        metadata: nextMetadata,
        metadataUnavailable: preserveMetadata
            ? false
            : preserveMetadataUnavailable
                ? true
                : next.metadataUnavailable,
        hasUnreadMessages,
    };
}

export function areSessionListRenderablesEqual(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;
    if (!areSessionListDocumentAdmissionsEqual(previous[SESSION_LIST_DOCUMENT_ADMISSION], next[SESSION_LIST_DOCUMENT_ADMISSION])) return false;
    if (previous[SESSION_LIST_DOCUMENT_ADMISSION]?.openedMetadataVersion !== next[SESSION_LIST_DOCUMENT_ADMISSION]?.openedMetadataVersion) return false;
    if (previous[SESSION_LIST_DOCUMENT_ADMISSION]?.openedAgentStateVersion !== next[SESSION_LIST_DOCUMENT_ADMISSION]?.openedAgentStateVersion) return false;
    if (previous[SESSION_LIST_DOCUMENT_ADMISSION]?.observedMetadataVersion !== next[SESSION_LIST_DOCUMENT_ADMISSION]?.observedMetadataVersion) return false;
    if (previous[SESSION_LIST_DOCUMENT_ADMISSION]?.observedAgentStateVersion !== next[SESSION_LIST_DOCUMENT_ADMISSION]?.observedAgentStateVersion) return false;
    if ((previous[SESSION_OWNER_METADATA_PROJECTION] ?? null) !== (next[SESSION_OWNER_METADATA_PROJECTION] ?? null)) return false;
    if (previous.viewer !== next.viewer && JSON.stringify(previous.viewer ?? null) !== JSON.stringify(next.viewer ?? null)) return false;
    if (previous.encryptionMode !== next.encryptionMode) return false;
    if (previous.encryptedContentAvailability !== next.encryptedContentAvailability) return false;
    if ((previous.lockedDisplayTitle ?? null) !== (next.lockedDisplayTitle ?? null)) return false;
    if (previous.agentTargetKey !== next.agentTargetKey) return false;
    if (JSON.stringify(previous.forkV1 ?? null) !== JSON.stringify(next.forkV1 ?? null)) return false;
    if (previous.workDisplay !== next.workDisplay && JSON.stringify(previous.workDisplay ?? null) !== JSON.stringify(next.workDisplay ?? null)) return false;
    if (previous.workflowHeadline !== next.workflowHeadline && JSON.stringify(previous.workflowHeadline ?? null) !== JSON.stringify(next.workflowHeadline ?? null)) return false;
    if (JSON.stringify(previous.guardState ?? null) !== JSON.stringify(next.guardState ?? null)) return false;
    if (previous.workerQuestionHandling?.answersWorkerQuestions !== next.workerQuestionHandling?.answersWorkerQuestions
        || previous.workerQuestionHandling?.explicitlyStopped !== next.workerQuestionHandling?.explicitlyStopped) return false;
    const previousMetadata = readSessionListRenderableMetadataComparisonFromRenderable(previous.metadata);
    const nextMetadata = readSessionListRenderableMetadataComparisonFromRenderable(next.metadata);

    return previous.id === next.id
        && previous.serverId === next.serverId
        && JSON.stringify(previous.agentActivityHeadline ?? null) === JSON.stringify(next.agentActivityHeadline ?? null)
        && previous.seq === next.seq
        && previous.createdAt === next.createdAt
        && previous.updatedAt === next.updatedAt
        && (previous.meaningfulActivityAt ?? null) === (next.meaningfulActivityAt ?? null)
        && previous.active === next.active
        && previous.activeAt === next.activeAt
        && (previous.archivedAt ?? null) === (next.archivedAt ?? null)
        && (previous.pendingVersion ?? null) === (next.pendingVersion ?? null)
        && (previous.pendingCount ?? null) === (next.pendingCount ?? null)
        && (previous.pendingBlockedCount ?? null) === (next.pendingBlockedCount ?? null)
        && JSON.stringify(previous.pendingActivationAuthorization ?? null) === JSON.stringify(next.pendingActivationAuthorization ?? null)
        && (previous.lastViewedSessionSeq ?? null) === (next.lastViewedSessionSeq ?? null)
        && (previous.latestTurnId ?? null) === (next.latestTurnId ?? null)
        && (previous.latestTurnStatus ?? null) === (next.latestTurnStatus ?? null)
        && (previous.latestTurnStatusObservedAt ?? null) === (next.latestTurnStatusObservedAt ?? null)
        && areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)
        && (previous.latestReadyEventSeq ?? null) === (next.latestReadyEventSeq ?? null)
        && (previous.latestReadyEventAt ?? null) === (next.latestReadyEventAt ?? null)
        && JSON.stringify(previous.lastRuntimeIssue ?? null) === JSON.stringify(next.lastRuntimeIssue ?? null)
        && (previous.runtimeActivityState ?? null) === (next.runtimeActivityState ?? null)
        && (previous.runtimeActivityActiveCount ?? null) === (next.runtimeActivityActiveCount ?? null)
        && (previous.runtimeActivityObservedAt ?? null) === (next.runtimeActivityObservedAt ?? null)
        && (previous.runtimeActivityRevision ?? null) === (next.runtimeActivityRevision ?? null)
        && (previous.lastTurnCompletedAt ?? null) === (next.lastTurnCompletedAt ?? null)
        && readSessionManagerSessionIdV1(previous) === readSessionManagerSessionIdV1(next)
        && previous.origin?.kind === next.origin?.kind
        && previous.origin?.runId === next.origin?.runId
        && previous.workDepth === next.workDepth
        && previous.ownerAccountId === next.ownerAccountId
        && previous.receivedRuleCount === next.receivedRuleCount
        && JSON.stringify(previous.managedSessions ?? null) === JSON.stringify(next.managedSessions ?? null)
        && readSessionMetadataLayoutVersion(previous.metadataLayoutVersion)
            === readSessionMetadataLayoutVersion(next.metadataLayoutVersion)
        && previous.metadataVersion === next.metadataVersion
        && previous.agentStateVersion === next.agentStateVersion
        && previous.thinking === next.thinking
        && previous.thinkingAt === next.thinkingAt
        && previous.presence === next.presence
        && (previous.optimisticThinkingAt ?? null) === (next.optimisticThinkingAt ?? null)
        && (previous.resumingAt ?? null) === (next.resumingAt ?? null)
        && (previous.thinkingGraceUntil ?? null) === (next.thinkingGraceUntil ?? null)
        && (previous.owner ?? null) === (next.owner ?? null)
        && JSON.stringify(previous.access ?? null) === JSON.stringify(next.access ?? null)
        && previous.responsibleAccountId === next.responsibleAccountId
        && areResponsibleAccountSummariesEqual(previous.responsibleAccount, next.responsibleAccount)
        && previous.hasOtherNamedCollaborator === next.hasOtherNamedCollaborator
        && (previous.accessLevel ?? null) === (next.accessLevel ?? null)
        && (previous.canApprovePermissions ?? null) === (next.canApprovePermissions ?? null)
        && (previous.hasPendingPermissionRequests ?? null) === (next.hasPendingPermissionRequests ?? null)
        && (previous.hasPendingUserActionRequests ?? null) === (next.hasPendingUserActionRequests ?? null)
        && (previous.pendingRequestObservedAt ?? null) === (next.pendingRequestObservedAt ?? null)
        && (previous.hasUnreadMessages === true) === (next.hasUnreadMessages === true)
        && (previous.keepVisibleWhenInactive === true) === (next.keepVisibleWhenInactive === true)
        && (previous.metadataUnavailable === true) === (next.metadataUnavailable === true)
        && areSessionListRenderableMetadataComparisonsEqual(previousMetadata, nextMetadata);
}

export function applySessionListRenderablePatch(
    renderable: SessionListRenderableSession,
    patch: SessionListRenderablePatchFields,
): SessionListRenderableSession {
    const next = preserveSessionListRenderablePendingFlags(renderable, reconcileSessionLifecycleProjection(renderable, {
        ...renderable,
        ...patch,
        id: renderable.id,
    }));
    return {
        ...next,
        lockedDisplayTitle: readSessionMetadataLayoutVersion(next.metadataLayoutVersion) === 1
            && next.metadata === null
            && isSessionAccessRecipient(next.access, next.accessLevel)
            ? readSessionDisplayTitleField({ lockedDisplayTitle: next.lockedDisplayTitle }).value
            : null,
    };
}

export function isSessionListRenderablePatchNoop(
    renderable: SessionListRenderableSession,
    patch: SessionListRenderablePatchFields,
): boolean {
    return areSessionListRenderablesEqual(
        renderable,
        applySessionListRenderablePatch(renderable, patch),
    );
}

export function didSessionListRenderableStructuralFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.active !== next.active) return true;
    if (previous.createdAt !== next.createdAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;
    if (String(prevMeta?.machineId ?? '') !== String(nextMeta?.machineId ?? '')) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (!areSessionListWorkspaceLocationsEqual(prevMeta?.sessionWorkspaceLocationV1, nextMeta?.sessionWorkspaceLocationV1)) return true;
    if (String(prevMeta?.homeDir ?? '') !== String(nextMeta?.homeDir ?? '')) return true;
    if (!areSessionListRenderableExternalSessionIdentitiesEqual(
        prevMeta?.externalSessionV1,
        nextMeta?.externalSessionV1,
    )) return true;
    if ((prevMeta?.hiddenSystemSession === true) !== (nextMeta?.hiddenSystemSession === true)) return true;
    if (readSessionDirectoryKind(prevMeta) !== readSessionDirectoryKind(nextMeta)) return true;

    return false;
}

export function didSessionListRenderableProjectGroupingFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if ((previous.metadata?.workspaceId ?? null) !== (next.metadata?.workspaceId ?? null)
        || (previous.metadata?.projectId ?? null) !== (next.metadata?.projectId ?? null)) return true;
    if (!areSessionListWorkspaceLocationsEqual(previous.metadata?.sessionWorkspaceLocationV1, next.metadata?.sessionWorkspaceLocationV1)) return true;
    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;
    const prevParts = resolveSessionProjectGroupingKeyParts(prevMeta ?? null);
    const nextParts = resolveSessionProjectGroupingKeyParts(nextMeta ?? null);

    if (prevParts.pathKey !== nextParts.pathKey) return true;
    if (prevParts.machineGroupId !== nextParts.machineGroupId) return true;
    if (prevParts.bucket !== nextParts.bucket) return true;

    return false;
}

function hasExplicitActiveReachabilityTarget(session: SessionListRenderableSession): boolean {
    return session.active === true
        && String(session.metadata?.machineId ?? '').trim().length > 0
        && String(session.metadata?.path ?? '').trim().length > 0;
}

export function didSessionListRenderableReachabilityPeerFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.active !== next.active) return true;
    if (
        previous.metadataVersion !== next.metadataVersion
        && (!hasExplicitActiveReachabilityTarget(previous) || !hasExplicitActiveReachabilityTarget(next))
    ) {
        return true;
    }

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;

    if (String(prevMeta?.machineId ?? '') !== String(nextMeta?.machineId ?? '')) return true;
    if (String(prevMeta?.host ?? '') !== String(nextMeta?.host ?? '')) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (String(prevMeta?.homeDir ?? '') !== String(nextMeta?.homeDir ?? '')) return true;

    return false;
}

export function didSessionListRenderableWarmCacheFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.updatedAt !== next.updatedAt) return true;
    if ((previous.meaningfulActivityAt ?? null) !== (next.meaningfulActivityAt ?? null)) return true;
    if (previous.createdAt !== next.createdAt) return true;
    if (previous.active !== next.active) return true;
    if (previous.activeAt !== next.activeAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
    if ((previous.pendingCount ?? null) !== (next.pendingCount ?? null)) return true;
    if ((previous.pendingBlockedCount ?? null) !== (next.pendingBlockedCount ?? null)) return true;
    if ((previous.pendingVersion ?? null) !== (next.pendingVersion ?? null)) return true;
    if (JSON.stringify(previous.pendingActivationAuthorization ?? null) !== JSON.stringify(next.pendingActivationAuthorization ?? null)) return true;
    if ((previous.latestTurnId ?? null) !== (next.latestTurnId ?? null)) return true;
    if ((previous.runtimeActivityState ?? null) !== (next.runtimeActivityState ?? null)) return true;
    if ((previous.runtimeActivityActiveCount ?? null) !== (next.runtimeActivityActiveCount ?? null)) return true;
    if ((previous.runtimeActivityObservedAt ?? null) !== (next.runtimeActivityObservedAt ?? null)) return true;
    if ((previous.runtimeActivityRevision ?? null) !== (next.runtimeActivityRevision ?? null)) return true;
    if ((previous.latestReadyEventSeq ?? null) !== (next.latestReadyEventSeq ?? null)) return true;
    if ((previous.latestReadyEventAt ?? null) !== (next.latestReadyEventAt ?? null)) return true;
    if (!areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)) return true;
    if (JSON.stringify(previous.access ?? null) !== JSON.stringify(next.access ?? null)) return true;
    if (previous.responsibleAccountId !== next.responsibleAccountId) return true;
    if (!areResponsibleAccountSummariesEqual(previous.responsibleAccount, next.responsibleAccount)) return true;
    if (previous.hasOtherNamedCollaborator !== next.hasOtherNamedCollaborator) return true;
    if ((previous.accessLevel ?? null) !== (next.accessLevel ?? null)) return true;
    if ((previous.canApprovePermissions ?? null) !== (next.canApprovePermissions ?? null)) return true;
    if (readSessionMetadataLayoutVersion(previous.metadataLayoutVersion)
        !== readSessionMetadataLayoutVersion(next.metadataLayoutVersion)) return true;
    if (previous.metadataVersion !== next.metadataVersion) return true;
    if (previous.agentStateVersion !== next.agentStateVersion) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;
    if ((prevMeta?.name ?? null) !== (nextMeta?.name ?? null)) return true;
    if ((prevMeta?.summaryText ?? null) !== (nextMeta?.summaryText ?? null)) return true;
    if ((prevMeta?.bot?.kind ?? null) !== (nextMeta?.bot?.kind ?? null)) return true;
    if (!areSessionBotFacesEqual(prevMeta?.botFace, nextMeta?.botFace)) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if ((prevMeta?.homeDir ?? null) !== (nextMeta?.homeDir ?? null)) return true;
    if ((prevMeta?.host ?? null) !== (nextMeta?.host ?? null)) return true;
    if ((prevMeta?.machineId ?? null) !== (nextMeta?.machineId ?? null)) return true;
    if ((prevMeta?.flavor ?? null) !== (nextMeta?.flavor ?? null)) return true;
    if ((prevMeta?.hiddenSystemSession === true) !== (nextMeta?.hiddenSystemSession === true)) return true;
    if (readSessionDirectoryKind(prevMeta) !== readSessionDirectoryKind(nextMeta)) return true;
    if (!areSessionListRenderableExternalSessionIdentitiesEqual(
        prevMeta?.externalSessionV1,
        nextMeta?.externalSessionV1,
    )) return true;

    if ((previous.hasPendingPermissionRequests ?? null) !== (next.hasPendingPermissionRequests ?? null)) return true;
    if ((previous.hasPendingUserActionRequests ?? null) !== (next.hasPendingUserActionRequests ?? null)) return true;
    if ((previous.pendingRequestObservedAt ?? null) !== (next.pendingRequestObservedAt ?? null)) return true;

    return false;
}

export function isSessionListRenderableWarmCacheProgressOnlyChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;
    if (previous.viewer !== next.viewer && JSON.stringify(previous.viewer ?? null) !== JSON.stringify(next.viewer ?? null)) return false;
    if (previous.active !== true || next.active !== true) return false;
    if (previous.active !== next.active) return false;
    if (previous.createdAt !== next.createdAt) return false;
    if (previous.presence !== next.presence) return false;
    if (previous.thinking !== next.thinking) return false;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return false;
    if ((previous.pendingCount ?? null) !== (next.pendingCount ?? null)) return false;
    if ((previous.pendingBlockedCount ?? null) !== (next.pendingBlockedCount ?? null)) return false;
    if ((previous.pendingVersion ?? null) !== (next.pendingVersion ?? null)) return false;
    if (JSON.stringify(previous.pendingActivationAuthorization ?? null) !== JSON.stringify(next.pendingActivationAuthorization ?? null)) return false;
    if ((previous.lastViewedSessionSeq ?? null) !== (next.lastViewedSessionSeq ?? null)) return false;
    if ((previous.latestTurnId ?? null) !== (next.latestTurnId ?? null)) return false;
    if ((previous.latestTurnStatus ?? null) !== (next.latestTurnStatus ?? null)) return false;
    if ((previous.latestTurnStatusObservedAt ?? null) !== (next.latestTurnStatusObservedAt ?? null)) return false;
    if ((previous.lastRuntimeIssue ?? null) !== (next.lastRuntimeIssue ?? null)) return false;
    if ((previous.runtimeActivityState ?? null) !== (next.runtimeActivityState ?? null)) return false;
    if ((previous.runtimeActivityActiveCount ?? null) !== (next.runtimeActivityActiveCount ?? null)) return false;
    if ((previous.runtimeActivityObservedAt ?? null) !== (next.runtimeActivityObservedAt ?? null)) return false;
    if ((previous.runtimeActivityRevision ?? null) !== (next.runtimeActivityRevision ?? null)) return false;
    if (!areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)) return false;
    if ((previous.latestReadyEventSeq ?? null) !== (next.latestReadyEventSeq ?? null)) return false;
    if ((previous.latestReadyEventAt ?? null) !== (next.latestReadyEventAt ?? null)) return false;
    if (readSessionMetadataLayoutVersion(previous.metadataLayoutVersion)
        !== readSessionMetadataLayoutVersion(next.metadataLayoutVersion)) return false;
    if (previous.metadataVersion !== next.metadataVersion) return false;
    if (previous.agentStateVersion !== next.agentStateVersion) return false;
    if (JSON.stringify(previous.access ?? null) !== JSON.stringify(next.access ?? null)) return false;
    if (previous.responsibleAccountId !== next.responsibleAccountId) return false;
    if (!areResponsibleAccountSummariesEqual(previous.responsibleAccount, next.responsibleAccount)) return false;
    if (previous.hasOtherNamedCollaborator !== next.hasOtherNamedCollaborator) return false;
    if ((previous.accessLevel ?? null) !== (next.accessLevel ?? null)) return false;
    if ((previous.canApprovePermissions ?? null) !== (next.canApprovePermissions ?? null)) return false;
    if ((previous.hasPendingPermissionRequests ?? null) !== (next.hasPendingPermissionRequests ?? null)) return false;
    if ((previous.hasPendingUserActionRequests ?? null) !== (next.hasPendingUserActionRequests ?? null)) return false;
    if ((previous.pendingRequestObservedAt ?? null) !== (next.pendingRequestObservedAt ?? null)) return false;
    if ((previous.hasUnreadMessages === true) !== (next.hasUnreadMessages === true)) return false;
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return false;
    if ((previous.metadataUnavailable === true) !== (next.metadataUnavailable === true)) return false;
    if (previous.encryptionMode !== next.encryptionMode) return false;
    if (previous.encryptedContentAvailability !== next.encryptedContentAvailability) return false;
    if ((previous.lockedDisplayTitle ?? null) !== (next.lockedDisplayTitle ?? null)) return false;
    if (JSON.stringify(previous.agentActivityHeadline ?? null) !== JSON.stringify(next.agentActivityHeadline ?? null)) return false;
    if (JSON.stringify(previous.forkV1 ?? null) !== JSON.stringify(next.forkV1 ?? null)) return false;
    if (previous.workDisplay !== next.workDisplay) return false;
    if (previous.workflowHeadline !== next.workflowHeadline) return false;
    if (JSON.stringify(previous.guardState ?? null) !== JSON.stringify(next.guardState ?? null)) return false;
    if (!areSessionListRenderableMetadataComparisonsEqual(
        readSessionListRenderableMetadataComparisonFromRenderable(previous.metadata),
        readSessionListRenderableMetadataComparisonFromRenderable(next.metadata),
    )) {
        return false;
    }

    return previous.seq !== next.seq
        || previous.updatedAt !== next.updatedAt
        || (previous.meaningfulActivityAt ?? null) !== (next.meaningfulActivityAt ?? null)
        || previous.activeAt !== next.activeAt;
}
