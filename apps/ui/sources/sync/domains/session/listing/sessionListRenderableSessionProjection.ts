import type { Session } from '@/sync/domains/state/storageTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import { compareSessionMetadataRevisions, readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { isSessionAccessOwner, isSessionAccessRecipient } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { classifySessionTupleApplyCurrentness } from '@/sync/domains/session/sessionTupleApplyCurrentness';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { reconcileSessionLifecycleProjection, type SessionLifecycleProjection } from '../sessionLifecycleProjection';
import { SESSION_OWNER_METADATA_PROJECTION, type SessionOwnerMetadataAuthority } from '../readSessionOwnerMetadataView';
import { isSessionContentReadable, readSessionContentAvailability } from '../encryptedContentAvailability';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';

import type { SessionListRenderableSession } from './sessionListRenderable';
import type { Message } from '@happier-dev/session-core/messages';
import { derivePendingRequestFlags, deriveLatestPendingRequestObservedAt, listPendingRequests,
    readSharedMetadataActionConfirmationState, listPendingPermissionRequests as listCorePermissionRequests,
    listPendingUserActionRequests as listCoreUserActionRequests, type PendingRequestFacts } from '@happier-dev/session-core/pending';
import { readSessionPresentationCompletedRequests } from '../presentation/readSessionPresentationCompletedRequests';
import { readPendingRequestFactsFromSession } from '../pending/listPendingSessionRequests';
import { readSessionFullPublicationUpdatedAt } from '../sessionRuntimeObservation';
import { SESSION_LIST_DOCUMENT_ADMISSION, areSessionListDocumentAdmissionsEqual,
    mergeSessionListDocumentObservations, hasNewerObservedSessionMetadata } from '../sessionDocumentAdmission';

export type SessionPresentationRecord = Session | SessionListRenderableSession;
export type SessionPresentationInput = Readonly<{ record: SessionPresentationRecord; baseSession?: Session; serverId?: string }>;
export type SessionRelationRecord = SessionPresentationRecord | SessionPresentationInput;

export function readSessionPresentationRecord(input: SessionRelationRecord): SessionPresentationRecord {
    return 'record' in input ? input.record : input;
}

export function readSessionPresentationServerId(input: SessionRelationRecord): string | undefined {
    return input.serverId;
}

export function readSessionPresentationInputSource(input: SessionRelationRecord): SessionListPresentationSource | undefined {
    const record = readSessionPresentationRecord(input);
    return 'agentState' in record ? undefined : createSessionListPresentationSource(record, {
        serverId: readSessionPresentationServerId(input), baseSession: 'record' in input ? input.baseSession : undefined,
    });
}

export function readSessionPresentationInputDisplay(input: SessionRelationRecord) {
    const source = readSessionPresentationInputSource(input);
    return source ? readSessionListPresentationDisplay(source) : readSessionPresentationRecord(input);
}

/** Only the named held private leaf is read; never enumerate or clone a held Metadata body. */
export function readSessionListPresentationOwnerMetadataField<K extends keyof Metadata>(source: SessionListPresentationSource, key: K) {
    return source.metadataLayoutVersion === 0
        ? readMetadataField(source.metadata, source.metadataFallback, key)
        : readMetadataField(source.ownerMetadataView, source.ownerMetadataFallback, key);
}

/** A requested full control read, never the inventory/display projection. */
export function readSessionPresentationControl(input: SessionRelationRecord): Session {
    const record = readSessionPresentationRecord(input);
    return 'agentState' in record ? record : buildSessionFromListRenderable(record, {
        serverId: input.serverId, baseSession: 'record' in input ? input.baseSession : undefined,
    });
}

function readPresentationRelations(record: SessionPresentationRecord, baseSession?: Session) {
    return { manager: record.manager !== undefined ? record.manager : baseSession?.manager ?? null,
        managedSessions: record.managedSessions ?? baseSession?.managedSessions ?? null,
        origin: record.origin ?? baseSession?.origin };
}

export function readSessionPresentationInputRelations(input: SessionRelationRecord) {
    return readPresentationRelations(readSessionPresentationRecord(input), 'record' in input ? input.baseSession : undefined);
}

/** Operation-local inputs, not another retained Session or row projection. */
export type SessionListPresentationSource = Readonly<{
    row: SessionListRenderableSession;
    baseSession?: Session;
    serverId?: string;
    metadata: Metadata | null;
    metadataLayoutVersion: number;
    metadataFromRow: boolean;
    ownerMetadataView: Metadata | null | undefined;
    metadataFallback?: Metadata | null;
    ownerMetadataFallback?: Metadata | null;
    relations: ReturnType<typeof readPresentationRelations>;
    lifecycle: SessionLifecycleProjection;
    pending: PendingRequestFacts;
    pendingObserved: boolean;
    messages?: readonly Message[];
}>;

function normalizeProjectionSeq(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

export function isSessionListRenderableNewerThanSession(
    renderable: SessionListRenderableSession,
    session: Pick<Session, 'seq' | 'agentStateVersion' | 'metadataVersion' | 'metadataLayoutVersion'>,
): boolean {
    const observation = hasNewerObservedSessionMetadata(renderable) ? renderable[SESSION_LIST_DOCUMENT_ADMISSION] : undefined;
    return normalizeProjectionSeq(renderable.seq) > normalizeProjectionSeq(session.seq)
        || compareSessionMetadataRevisions({
            incomingLayoutVersion: observation?.observedMetadataLayoutVersion ?? renderable.metadataLayoutVersion,
            incomingMetadataVersion: observation?.observedMetadataVersion ?? renderable.metadataVersion,
            storedLayoutVersion: session.metadataLayoutVersion,
            storedMetadataVersion: session.metadataVersion,
        }) > 0
        || !classifySessionTupleApplyCurrentness(renderable, {
            ...renderable,
            agentStateVersion: session.agentStateVersion,
        }).agentStateCurrent;
}

/**
 * Whether a list row's composed `metadata` is its owner view.
 *
 * A row has no separate owner field: the renderable builders compose this viewer's projection
 * into `metadata` (the owner view for the owner, the shared projection for a recipient). So for a
 * layout-1 owner row that metadata IS the owner view — the fact every row reader (display names,
 * the renderable→Session projection) and every row writer (a shared-only socket frame must not
 * replace it) has to agree on. One rule, so they cannot.
 */
type SessionListRenderableOwnerProjectionInput = Readonly<{
    metadataLayoutVersion?: unknown;
    access?: SessionListRenderableSession['access'];
    accessLevel?: unknown;
}>;

export function isSessionListRenderableOwnerProjection(
    renderable: SessionListRenderableOwnerProjectionInput,
): boolean {
    return readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion) === 1
        && isSessionAccessOwner(renderable.access, renderable.accessLevel);
}

/** Compact display view by default; full continuation facts only under explicit current admission. */
export function readSessionListRenderableOwnerMetadataView(
    renderable: SessionListRenderableOwnerProjectionInput & Readonly<{ metadata: unknown }>
        & Partial<Pick<SessionListRenderableSession, 'metadataVersion' | 'metadataUnavailable'
            | 'encryptionMode' | 'encryptedContentAvailability' | typeof SESSION_OWNER_METADATA_PROJECTION>>,
    options?: Readonly<{
        /** Caller retains the canonical Account-encryption and Home/credential lifetime fences. */
        requireAdmitted: SessionOwnerMetadataAuthority & Readonly<{
            accountCurrentness: AccountEncryptionCurrentnessResponse;
            isCurrent: () => boolean;
        }>;
    }>,
): Metadata | null {
    if (options) {
        const row = renderable;
        const projection = row[SESSION_OWNER_METADATA_PROJECTION];
        if (!options.requireAdmitted.isCurrent() || !isSessionListRenderableOwnerProjection(row)
            || row.metadataUnavailable === true || row.metadata == null
            || !isSessionContentReadable(readSessionContentAvailability(row))
            || !projection?.ownerMetadataView || !projection.accountEncryptionIdentity || typeof row.metadataVersion !== 'number'
            || projection.admittedMetadataVersion !== row.metadataVersion
            || !projection.isCurrentAuthority?.(options.requireAdmitted)) return null;
        return projection.ownerMetadataView;
    }
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion);
    if (metadataLayoutVersion === 0 || isSessionListRenderableOwnerProjection(renderable)) {
        return renderable.metadata as Metadata | null;
    }
    return null;
}

// Display selectors expose metadata under useShallow; an unchanged row must retain this reference.
const sharedMetadataByDisplayMetadata = new WeakMap<object, Metadata>();

/** Restore the declared layout before passing display metadata to Session presentation readers. */
export function readSessionListRenderableSharedMetadata(
    renderable: Readonly<{ metadata: unknown; metadataLayoutVersion?: number }>,
): Metadata | null {
    const metadata = renderable.metadata;
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    if (readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion) !== 1) {
        return metadata as Metadata;
    }
    const cached = sharedMetadataByDisplayMetadata.get(metadata);
    if (cached) return cached;
    // `flavor` in a list row is projected from public agentPresentation, never the private owner flavor.
    const agentId = Reflect.get(metadata, 'flavor');
    const displayMetadata = metadata as Metadata;
    const sharedMetadata = { ...displayMetadata, v: 1,
        agentPresentation: typeof agentId === 'string' && agentId ? { agentId } : undefined };
    sharedMetadataByDisplayMetadata.set(metadata, sharedMetadata);
    return sharedMetadata;
}

function mergeRenderableMetadata(
    baseMetadata: Metadata | null | undefined,
    renderableMetadata: SessionListRenderableSession['metadata'],
): Metadata | null {
    return renderableMetadata === null ? null : baseMetadata
        ? { ...baseMetadata, ...renderableMetadata } as Metadata : renderableMetadata as Metadata;
}

function resolveSessionListMetadataProjection(
    renderable: SessionListRenderableSession,
    baseSession: Session | undefined,
    rowMetadata: Metadata | null,
) {
    const metadataCurrent = classifySessionTupleApplyCurrentness(baseSession, renderable).metadataCurrent;
    const rowMetadataLayoutVersion = readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion ?? baseSession?.metadataLayoutVersion);
    const baseMetadataLayoutVersion = readSessionMetadataLayoutVersion(baseSession?.metadataLayoutVersion);
    const metadataLayoutVersion = metadataCurrent || !baseSession ? rowMetadataLayoutVersion : baseMetadataLayoutVersion;
    const metadataUnavailable = renderable.metadataUnavailable === true || rowMetadata === null;
    const sameMetadataLayout = rowMetadataLayoutVersion === baseMetadataLayoutVersion;
    const ownerMetadataView = metadataUnavailable ? null : metadataLayoutVersion === 0 ? undefined
        : isSessionListRenderableOwnerProjection({ metadataLayoutVersion, access: renderable.access, accessLevel: renderable.accessLevel })
            ? metadataCurrent
                ? rowMetadata
                : baseSession?.ownerMetadataView ?? null
            : null;
    const metadata = metadataUnavailable ? null : metadataCurrent
        ? rowMetadata
        : baseSession?.metadata ?? null;
    return { metadataCurrent, metadataLayoutVersion, rowMetadataLayoutVersion, ownerMetadataView, metadata,
        metadataFallback: metadata !== null && metadataCurrent && sameMetadataLayout ? baseSession?.metadata : undefined,
        ownerMetadataFallback: ownerMetadataView && metadataCurrent && sameMetadataLayout ? baseSession?.ownerMetadataView : undefined };
}

function readAdmittedBaseSession(row: SessionListRenderableSession, base: Session | undefined): Session | undefined {
    const admission = row[SESSION_LIST_DOCUMENT_ADMISSION];
    return admission && !areSessionListDocumentAdmissionsEqual(base?.[SESSION_LIST_DOCUMENT_ADMISSION], admission)
        ? undefined : base;
}

function readMetadataField<K extends keyof Metadata>(metadata: Metadata | null | undefined,
    fallback: Metadata | null | undefined, key: K): Metadata[K] | undefined {
    if (!metadata) return undefined;
    return Object.prototype.hasOwnProperty.call(metadata, key) ? metadata[key] : fallback?.[key];
}

export function createSessionListPresentationSource(
    row: SessionListRenderableSession,
    options: Readonly<{ baseSession?: Session; serverId?: string | null;
        /** A matching summary must not turn its unread bit into new Ready evidence. */
        readyEvent?: Pick<Session, 'latestReadyEventSeq'> }> = {},
): SessionListPresentationSource {
    const baseSession = readAdmittedBaseSession(row, options.baseSession);
    const serverId = options.serverId?.trim() || baseSession?.serverId || row.serverId;
    const rowMetadata = readSessionListRenderableSharedMetadata(row);
    const metadata = resolveSessionListMetadataProjection(row, baseSession, rowMetadata);
    const seq = normalizeProjectionSeq(row.seq);
    // Only lifecycle facts enter this adapter. Do not spread a Session/list body here.
    const lifecycle = reconcileSessionLifecycleProjection(baseSession, {
        serverId, seq: row.hasUnreadMessages === true ? Math.max(1, seq) : seq,
        updatedAt: row.updatedAt, meaningfulActivityAt: row.meaningfulActivityAt,
        lastTurnCompletedAt: row.lastTurnCompletedAt, active: row.active, activeAt: row.activeAt,
        thinking: row.thinking, thinkingAt: row.thinkingAt,
        latestTurnId: row.latestTurnId, latestTurnStatus: row.latestTurnStatus,
        latestTurnStatusObservedAt: row.latestTurnStatusObservedAt,
        latestReadyEventSeq: options.readyEvent ? options.readyEvent.latestReadyEventSeq
            : row.hasUnreadMessages === true ? Math.max(1, seq) : row.latestReadyEventSeq,
        latestReadyEventAt: row.latestReadyEventAt,
        pendingVersion: row.pendingVersion, pendingCount: row.pendingCount,
        pendingBlockedCount: row.pendingBlockedCount, pendingActivationAuthorization: row.pendingActivationAuthorization,
        runtimeActivityState: row.runtimeActivityState, runtimeActivityActiveCount: row.runtimeActivityActiveCount,
        runtimeActivityObservedAt: row.runtimeActivityObservedAt, runtimeActivityRevision: row.runtimeActivityRevision,
    });
    const basePending = baseSession ? readPendingRequestFactsFromSession(baseSession) : undefined;
    const hasPendingSummary = typeof row.hasPendingPermissionRequests === 'boolean' || typeof row.hasPendingUserActionRequests === 'boolean';
    const pending: PendingRequestFacts = {
        sessionId: row.id, active: lifecycle.active,
        agentState: baseSession && classifySessionTupleApplyCurrentness(row, baseSession).agentStateCurrent ? baseSession.agentState : null,
        actionConfirmations: readSharedMetadataActionConfirmationState({
            actionConfirmationsV1: readMetadataField(metadata.metadata, metadata.metadataFallback, 'actionConfirmationsV1'),
        }, metadata.metadataLayoutVersion),
        presentationCompletedRequests: baseSession ? readSessionPresentationCompletedRequests(baseSession) : null,
        projected: {
            permissionCount: typeof row.hasPendingPermissionRequests === 'boolean' ? row.hasPendingPermissionRequests ? 1 : 0 : basePending?.projected?.permissionCount ?? null,
            userActionCount: typeof row.hasPendingUserActionRequests === 'boolean' ? row.hasPendingUserActionRequests ? 1 : 0 : basePending?.projected?.userActionCount ?? null,
            observedAt: hasPendingSummary ? typeof row.pendingRequestObservedAt === 'number' && Number.isFinite(row.pendingRequestObservedAt)
                && row.pendingRequestObservedAt > 0 ? row.pendingRequestObservedAt : null : basePending?.projected?.observedAt ?? null,
            referenceAt: Number.isFinite(lifecycle.updatedAt)
                ? Math.trunc(readSessionFullPublicationUpdatedAt({ id: row.id, serverId, updatedAt: lifecycle.updatedAt })) : null,
        },
    };
    return { row, baseSession, serverId, metadata: metadata.metadata, metadataLayoutVersion: metadata.metadataLayoutVersion,
        metadataFromRow: metadata.metadataCurrent || !baseSession, ownerMetadataView: metadata.ownerMetadataView,
        metadataFallback: metadata.metadataFallback, ownerMetadataFallback: metadata.ownerMetadataFallback,
        relations: readPresentationRelations(row, baseSession), lifecycle, pending,
        pendingObserved: pending.agentState !== null || typeof pending.projected?.permissionCount === 'number'
            && typeof pending.projected?.userActionCount === 'number' };
}

export function readSessionListPresentationOwnerMetadata(source: SessionListPresentationSource) {
    return source.metadataLayoutVersion === 0 ? source.metadata : source.ownerMetadataView;
}

export function readSessionListPresentationRuntime(source: SessionListPresentationSource) {
    return { ...source.lifecycle, id: source.row.id, serverId: source.serverId, archivedAt: source.row.archivedAt,
        presence: source.row.presence, optimisticThinkingAt: source.row.optimisticThinkingAt,
        resumingAt: source.row.resumingAt, thinkingGraceUntil: source.row.thinkingGraceUntil, lastRuntimeIssue: source.row.lastRuntimeIssue };
}

export function readSessionListPresentationPendingFlags(source: SessionListPresentationSource, messages = source.messages) {
    return derivePendingRequestFlags(source.pending, messages ?? []);
}

export function readSessionListPresentationPendingObservedAt(source: SessionListPresentationSource, messages = source.messages) {
    return deriveLatestPendingRequestObservedAt(source.pending, messages ?? []);
}

export function listSessionListPresentationPendingRequests(source: SessionListPresentationSource, messages = source.messages) {
    return listPendingRequests(source.pending, messages ?? []);
}

export function listSessionListPresentationPermissionRequests(source: SessionListPresentationSource, messages = source.messages) {
    return listCorePermissionRequests(source.pending, messages ?? []);
}

export function listSessionListPresentationUserActionRequests(source: SessionListPresentationSource, messages = source.messages) {
    return listCoreUserActionRequests(source.pending, messages ?? []);
}

/** Display fields only: no reconstructed Session and no ambient Home lookup. */
export function readSessionListPresentationDisplay(source: SessionListPresentationSource) {
    const row = source.row;
    return { id: row.id, serverId: source.serverId, metadata: source.metadata, metadataLayoutVersion: source.metadataLayoutVersion,
        ownerMetadataView: source.ownerMetadataView, lockedDisplayTitle: row.lockedDisplayTitle,
        access: row.access, accessLevel: row.accessLevel, encryptionMode: row.encryptionMode ?? source.baseSession?.encryptionMode,
        encryptedContentAvailability: row.encryptedContentAvailability !== undefined ? row.encryptedContentAvailability : source.baseSession?.encryptedContentAvailability };
}

export function buildSessionFromListRenderable(
    renderable: SessionListRenderableSession,
    options: Readonly<{
        baseSession?: Session;
        serverId?: string | null;
    }> = {},
): Session {
    const admittedBase = readAdmittedBaseSession(renderable, options.baseSession);
    if (admittedBase !== options.baseSession) options = { ...options, baseSession: admittedBase };
    const {
        responsibleAccountId: _baseResponsibleAccountId,
        responsibleAccount: _baseResponsibleAccount,
        ...baseSessionWithoutResponsibility
    } = options.baseSession ?? {};
    const seq = normalizeProjectionSeq(renderable.seq);
    const normalizedServerId = typeof options.serverId === 'string' && options.serverId.trim()
        ? options.serverId.trim()
        : options.baseSession?.serverId;
    const pendingRequestObservedAt = typeof renderable.pendingRequestObservedAt === 'number'
        && Number.isFinite(renderable.pendingRequestObservedAt)
        && renderable.pendingRequestObservedAt > 0
        ? renderable.pendingRequestObservedAt
        : null;
    const hasRenderablePendingSummary = typeof renderable.hasPendingPermissionRequests === 'boolean'
        || typeof renderable.hasPendingUserActionRequests === 'boolean';
    const hasCurrentCanonicalAgentState = options.baseSession !== undefined
        && classifySessionTupleApplyCurrentness(renderable, options.baseSession).agentStateCurrent;
    const agentState = hasCurrentCanonicalAgentState
        ? options.baseSession!.agentState
        : null;
    const agentStateVersion = hasCurrentCanonicalAgentState
        ? options.baseSession!.agentStateVersion
        : renderable.agentStateVersion;
    const rowMetadataLayoutVersion = readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion ?? options.baseSession?.metadataLayoutVersion);
    const displayMetadata = readSessionListRenderableSharedMetadata({
        metadata: renderable.metadata, metadataLayoutVersion: rowMetadataLayoutVersion,
    });
    const rowMetadata = displayMetadata === null ? null : {
        ...displayMetadata,
        sessionAgentActivityHeadlineV1: renderable.agentActivityHeadline ?? null,
        sessionWorkflowActivityHeadlineV1: renderable.workflowHeadline ?? null,
        ...(renderable.metadata?.terminalControlServiceabilityV1
            ? { terminal: { controlServiceabilityV1: renderable.metadata.terminalControlServiceabilityV1 } }
            : {}),
    };
    const projection = resolveSessionListMetadataProjection(renderable, options.baseSession, rowMetadata);
    const { metadataCurrent, metadataLayoutVersion } = projection;
    // Full controls deliberately retain the complete held metadata overlay. Inventory/display
    // consumers above read only their admitted raw metadata and the private leaves they need.
    const rowAdmission = renderable[SESSION_LIST_DOCUMENT_ADMISSION];
    const heldFullDocuments = options.baseSession && options.baseSession.metadataProjection !== 'displayOnly' && rowAdmission
        && areSessionListDocumentAdmissionsEqual(options.baseSession[SESSION_LIST_DOCUMENT_ADMISSION], rowAdmission)
        ? options.baseSession : undefined;
    const ownerMetadataView = heldFullDocuments ? heldFullDocuments.ownerMetadataView
        : projection.ownerMetadataView == null ? projection.ownerMetadataView
        : mergeRenderableMetadata(projection.ownerMetadataFallback, projection.ownerMetadataView);
    const projectedMetadata = heldFullDocuments ? heldFullDocuments.metadata : projection.metadata === null ? null
        : mergeRenderableMetadata(projection.metadataFallback, projection.metadata);

    return reconcileSessionLifecycleProjection(options.baseSession, {
        ...baseSessionWithoutResponsibility,
        ...(rowAdmission ? { [SESSION_LIST_DOCUMENT_ADMISSION]: heldFullDocuments
            ? mergeSessionListDocumentObservations(heldFullDocuments[SESSION_LIST_DOCUMENT_ADMISSION]!, rowAdmission)
            : rowAdmission } : {}),
        id: renderable.id,
        viewer: renderable.viewer,
        encryptionMode: renderable.encryptionMode ?? options.baseSession?.encryptionMode,
        encryptedContentAvailability: renderable.encryptedContentAvailability !== undefined
            ? renderable.encryptedContentAvailability
            : options.baseSession?.encryptedContentAvailability,
        serverId: normalizedServerId,
        seq: renderable.hasUnreadMessages === true ? Math.max(1, seq) : seq,
        createdAt: renderable.createdAt,
        updatedAt: renderable.updatedAt,
        active: renderable.active,
        activeAt: renderable.activeAt,
        archivedAt: renderable.archivedAt ?? null,
        meaningfulActivityAt: renderable.meaningfulActivityAt ?? null,
        pendingVersion: renderable.pendingVersion,
        pendingCount: renderable.pendingCount,
        pendingBlockedCount: renderable.pendingBlockedCount,
        pendingActivationAuthorization: renderable.pendingActivationAuthorization ?? null,
        lastViewedSessionSeq: renderable.viewer !== undefined
            ? renderable.viewer.readState.state === 'tracking'
                ? renderable.viewer.readState.lastViewedSessionSeq
                : null
            : renderable.hasUnreadMessages === true ? 0 : seq,
        pendingPermissionRequestCount: typeof renderable.hasPendingPermissionRequests === 'boolean'
            ? renderable.hasPendingPermissionRequests ? 1 : 0
            : options.baseSession?.pendingPermissionRequestCount,
        pendingUserActionRequestCount: typeof renderable.hasPendingUserActionRequests === 'boolean'
            ? renderable.hasPendingUserActionRequests ? 1 : 0
            : options.baseSession?.pendingUserActionRequestCount,
        pendingRequestObservedAt: hasRenderablePendingSummary
            ? pendingRequestObservedAt
            : options.baseSession?.pendingRequestObservedAt,
        latestReadyEventSeq: renderable.hasUnreadMessages === true
            ? Math.max(1, seq)
            : renderable.latestReadyEventSeq,
        latestReadyEventAt: renderable.latestReadyEventAt ?? null,
        latestTurnId: renderable.latestTurnId ?? null,
        latestTurnStatus: renderable.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: renderable.latestTurnStatusObservedAt ?? null,
        runtimeActivityState: renderable.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: renderable.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: renderable.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: renderable.runtimeActivityRevision ?? null,
        lastRuntimeIssue: renderable.lastRuntimeIssue ?? null,
        lastTurnCompletedAt: renderable.lastTurnCompletedAt ?? null,
        manager: renderable.manager !== undefined ? renderable.manager : options.baseSession?.manager ?? null,
        origin: renderable.origin ?? options.baseSession?.origin,
        workDepth: renderable.workDepth ?? options.baseSession?.workDepth,
        ownerAccountId: renderable.ownerAccountId ?? options.baseSession?.ownerAccountId,
        managedSessions: renderable.managedSessions ?? options.baseSession?.managedSessions ?? null,
        receivedRuleCount: renderable.receivedRuleCount,
        metadata: projectedMetadata,
        metadataProjection: heldFullDocuments ? heldFullDocuments.metadataProjection : 'displayOnly',
        workDisplay: metadataCurrent || !options.baseSession
            ? renderable.workDisplay : options.baseSession.workDisplay,
        // The row owns this ephemeral projection; a stale base must not revive a retired title.
        lockedDisplayTitle: metadataLayoutVersion === 1
            && renderable.metadata === null
            && isSessionAccessRecipient(renderable.access, renderable.accessLevel)
            ? readSessionDisplayTitleField({ lockedDisplayTitle: renderable.lockedDisplayTitle }).value
            : null,
        metadataLayoutVersion: heldFullDocuments ? heldFullDocuments.metadataLayoutVersion : metadataLayoutVersion || undefined,
        ownerMetadataView,
        metadataVersion: heldFullDocuments ? heldFullDocuments.metadataVersion : metadataCurrent || !options.baseSession
            ? renderable.metadataVersion : options.baseSession.metadataVersion,
        agentState: heldFullDocuments ? heldFullDocuments.agentState : agentState,
        agentStateVersion: heldFullDocuments ? heldFullDocuments.agentStateVersion : agentStateVersion,
        thinking: renderable.thinking,
        thinkingAt: renderable.thinkingAt,
        presence: renderable.presence,
        optimisticThinkingAt: renderable.optimisticThinkingAt,
        resumingAt: renderable.resumingAt,
        thinkingGraceUntil: renderable.thinkingGraceUntil,
        owner: renderable.owner,
        access: renderable.access,
        ...(Object.prototype.hasOwnProperty.call(renderable, 'responsibleAccountId')
            ? { responsibleAccountId: renderable.responsibleAccountId }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(renderable, 'responsibleAccount')
            ? { responsibleAccount: renderable.responsibleAccount }
            : {}),
        accessLevel: renderable.accessLevel,
        canApprovePermissions: renderable.canApprovePermissions,
    });
}
