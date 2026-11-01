import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { normalizeSessionOrderingNumber, reconcileSessionLifecycleProjection } from '../../domains/session/sessionLifecycleProjection';
import type {
    ScmCommitSelectionPatch,
    ScmStatus,
    ScmWorkingSnapshot,
    Machine,
    Session,
} from '../../domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import type { ConcurrentSessionListCacheByServerId } from '../../domains/session/listing/concurrentSessionListCache';
import { readSessionListRowForServerId, resolveSessionListHomeKey } from '../../domains/session/listing/sessionListRowStateLookup';
import { readSessionArchivePending, resolveSessionArchiveAddress, type SessionArchiveOperation, type SessionArchiveOperations } from '../../domains/session/listing/sessionArchiveState';
import type { SessionListQueryMembership } from '../../domains/session/listing/sessionListQueryController';
import { readStoredSessionMessagesFromStateLike } from "@happier-dev/session-core/messages";
import { captureSessionFullPublicationBaseline, sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import {
    areSessionListRenderablesEqual,
    applySessionListRenderablePatch,
    buildSessionListRenderableFromSession,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
    readSessionListRenderableSourceMetadata,
    type SessionListRenderablePatchFields,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';
import {
    shouldRebuildSessionListIndexForRenderableChange,
    type SessionListIndexRebuildSettings,
} from '../../domains/session/listing/sessionListIndexRebuildImpact';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import { nowServerMs } from '../../runtime/time';
import { clearSessionTranscriptDerivedCachesForSession } from '../../runtime/sessionTranscriptDerivedCaches';
import { readSessionPresentationCompletedRequests } from '../../domains/session/presentation/readSessionPresentationCompletedRequests';
import {
    loadSessionLastViewed,
    loadSessionModelModeUpdatedAts,
    loadSessionModelModes,
    loadSessionPermissionModeUpdatedAts,
    loadSessionPermissionModes,
    loadSessionActionDrafts,
    loadSessionReviewCommentsDrafts,
    loadWorkspaceReviewCommentsDrafts,
    saveSessionLastViewed,
    saveSessionModelModeUpdatedAts,
    saveSessionModelModes,
    saveSessionPermissionModeUpdatedAts,
    saveSessionPermissionModes,
    saveSessionActionDrafts,
    saveSessionReviewCommentsDrafts,
    saveWorkspaceReviewCommentsDrafts,
} from '../../domains/state/sessionPersistence';
import { prepareSessionLocalStateScopeForActivation } from '../../domains/state/persistence';
import {
    resolveWarmCacheAccountScope,
    type SessionListCacheEntryV1,
    type SessionListQueryMembershipCacheEntryV1,
    loadSessionListQueryMembershipWarmCacheEntries,
    saveSessionListQueryMembershipWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import {
    SESSION_LIST_WARM_CACHE_MAX_ENTRIES,
} from '../../domains/state/warmCacheAdapters';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { syncPerformanceTelemetry } from '../../runtime/syncPerformanceTelemetry';
import { type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { isModelSelectableForSession, type SessionModelOptionsContext } from '@/sync/domains/models/modelOptions';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import {
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import { applyReachableTargetsToSessionListRenderables } from '../../domains/session/listing/applyReachableTargetsToSessionListRenderables';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { SessionActionDraftStatus } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { isSessionAccessRecipient } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { areServerAccountScopesEqual, createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    mutateSessionModelModeField,
    mutateSessionPermissionModeField,
} from '@/sync/state/mutators';

import type { StoreGet, StoreSet } from './_shared';
import { areSessionValuesDeepEqual, areStoredSessionsEqual, reuseEqualSessionObjectFields } from './areStoredSessionsEqual';
import { applyAgentStateUpdateToSessionMessages } from './messages';
import type { SessionMessages } from './messages';
import {
    canReuseTranscriptRenderableAggregateRequestStates,
    isTranscriptRenderableAggregate,
    type TranscriptRenderableAggregate,
} from '../../domains/session/listing/transcriptRenderableAggregate';
import {
    doesActiveSessionListIndexProjectionNeedRepair,
    doesActiveSessionListProjectionNeedRepair,
    finalizeSessionListIndexUpdate,
    finalizeSessionListRenderablePublication,
    saveWarmSessionCacheForState,
} from './sessionListIndexFinalization';
import { resolveSessionListRenderableChangeImpact } from './sessionListRenderableChange';
import { persistSessionModelData } from './sessionModelPersistence';
import { persistSessionPermissionData } from './sessionPermissionPersistence';
import { resolveSessionInputModes } from './resolveSessionInputModes';
import {
    clearSessionRepositoryTreeExpandedPathsForState,
    clearWorkspaceRepositoryTreeExpandedPathsForState,
    deleteSessionRepositoryTreeExpansionForState,
    getSessionRepositoryTreeExpandedPathsForState,
    getWorkspaceRepositoryTreeExpandedPathsForState,
    setSessionRepositoryTreeExpandedPathsForState,
    setWorkspaceRepositoryTreeExpandedPathsForState,
} from './sessions.repositoryTreeExpansion';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { preserveSessionRuntimeLocalMetadata } from '@/sync/domains/session/preserveSessionRuntimeLocalMetadata';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { createKeyedTimeoutScheduler } from '@/utils/time/keyedTimeoutScheduler';
import {
    hasTerminalPrimaryTurnStatus,
    resolveSessionRuntimePresenceFields,
    SESSION_RESUMING_PRESENTATION_TIMEOUT_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import { reconcileLatestUsageContextSnapshotModel } from "@happier-dev/session-core/reducer";
import { reconcileSessionTupleProjection } from '@/sync/domains/session/sessionTupleApplyCurrentness';
import {
    buildMachineDisplaysByIdFromMachineList,
    buildSessionListIndexWithServerScope,
} from '../sessionListIndex/buildSessionListIndexWithServerScope';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
    getServerProfileById,
} from '../../domains/server/serverProfiles';
import { normalizeTrimmedString } from '@/sync/domains/session/listing/normalizeTrimmedString';
import {
    EMPTY_PROJECT_AUTHORING_SESSION_INPUTS,
    updateProjectAuthoringSessionInputs,
    type ProjectAuthoringSessionInputs,
} from './projectAuthoringSessions';

export {
    classifySessionTupleApplyCurrentness,
    type SessionTupleApplyCurrentness,
} from '@/sync/domains/session/sessionTupleApplyCurrentness';

/**
 * Does a Home-addressed Session deletion also retire the shared per-id carrier?
 *
 * The same Session id can exist on two Homes (Personal Home relocation/restore keeps
 * the id), while `sessions[sessionId]` and everything keyed off it — transcript,
 * encryption key, project, SCM, drafts, permission/model modes — belongs to exactly one
 * of them. A Home-agnostic fact (`serverId === null`) and a carrier with no Home binding
 * both address it; a fact produced by a different Home does not.
 *
 * One rule, read by the store's `deleteSession` and by the Session teardown choke point
 * `handleDeleteSessionSocketUpdate`, so the two cannot drift.
 */
export function shouldRetireSessionCarrierForServer(
    carrierServerId: string | null | undefined,
    serverId: string | null | undefined,
): boolean {
    const normalizedServerId = normalizeTrimmedString(serverId);
    if (!normalizedServerId) return true;
    const normalizedCarrierServerId = normalizeTrimmedString(carrierServerId);
    if (!normalizedCarrierServerId) return true;
    return areServerProfileIdentifiersEquivalent(normalizedCarrierServerId, normalizedServerId);
}

/**
 * The one reader of the retirement tombstone `deleteSession` writes.
 *
 * The tombstone records WHICH Home's carrier was retired, because the same Session
 * id can exist on several Homes and one Home's deletion says nothing about another
 * one's. `true` records a retirement that addressed no Home and therefore removed
 * the id everywhere, so it answers for every caller; a Home-scoped tombstone
 * answers only for that Home, and for a caller holding no Home at all — the same
 * unqualified boundary the write side uses.
 */
export function isSessionRetiredForServer(
    deletedSessionIds: Readonly<Record<string, string | true>>,
    sessionId: string,
    serverId: string | null | undefined,
): boolean {
    const tombstone = deletedSessionIds[sessionId];
    if (tombstone === undefined) return false;
    if (tombstone === true) return true;
    const normalizedServerId = normalizeTrimmedString(serverId);
    if (!normalizedServerId) return true;
    return areServerProfileIdentifiersEquivalent(tombstone, normalizedServerId);
}

/**
 * In-memory currentness for list reads against committed retirements.
 *
 * `deleteSession` (the one retirement writer) stamps each retirement with a
 * monotonic sequence. A list read captures the sequence when it starts and, when
 * its response lands, drops only the rows whose exact Home retired after that
 * capture: the valid rows of the same page survive, a same-id Session on another
 * Home is untouched, and a read that starts after the retirement (a later regrant)
 * admits the row again. Nothing is persisted and no request registry is kept.
 */
let sessionRetirementSequence = 0;
const sessionRetirementsBySessionId = new Map<string, Array<Readonly<{ serverId: string | null; sequence: number }>>>();

export type SessionListRetirementFence = number;

export function captureSessionListRetirementFence(): SessionListRetirementFence {
    return sessionRetirementSequence;
}

export function wasSessionRetiredSinceFence(
    fence: SessionListRetirementFence,
    serverId: string | null | undefined,
    sessionId: string,
): boolean {
    const retirements = sessionRetirementsBySessionId.get(sessionId);
    if (!retirements) return false;
    const normalizedServerId = normalizeTrimmedString(serverId);
    return retirements.some((retirement) => retirement.sequence > fence && (
        retirement.serverId === null
        || !normalizedServerId
        || areServerProfileIdentifiersEquivalent(retirement.serverId, normalizedServerId)
    ));
}

function recordSessionRetirement(sessionId: string, serverId: string | null): void {
    sessionRetirementSequence += 1;
    const retirements = sessionRetirementsBySessionId.get(sessionId) ?? [];
    retirements.push({ serverId, sequence: sessionRetirementSequence });
    sessionRetirementsBySessionId.set(sessionId, retirements);
}

type SessionModelMode = NonNullable<Session['modelMode']>;
type ScmOperationLogEntry = import('../../runtime/orchestration/projectManager').ScmProjectOperationLogEntry;
type ScmInFlightOperation = import('../../runtime/orchestration/projectManager').ScmProjectInFlightOperation;
type BeginScmOperationResult = import('../../runtime/orchestration/projectManager').BeginScmProjectOperationResult;
type ProjectScmSnapshotError = import('../../runtime/orchestration/projectManager').ProjectScmSnapshotError;

type SessionListIndexSettingsSource = Readonly<{
    sessionListActiveGroupingV1?: 'project' | 'date';
    sessionListInactiveGroupingV1?: 'project' | 'date';
    sessionListSectionModeV1?: 'activity' | 'single';
}>;

function resolveSessionListIndexRebuildSettings(
    settings: SessionListIndexSettingsSource,
): SessionListIndexRebuildSettings {
    return {
        activeGroupingV1: settings.sessionListActiveGroupingV1,
        inactiveGroupingV1: settings.sessionListInactiveGroupingV1,
        sectionModeV1: settings.sessionListSectionModeV1,
    };
}

/** A real Home publication replaces its aliases; readers retain legacy fallback until then. */
function publishSessionListHomeValue<T>(
    values: Readonly<Record<string, T>>,
    serverId: string,
    value: T | undefined,
): Readonly<Record<string, T>> {
    const keys = Object.keys(values).filter(key => areServerProfileIdentifiersEquivalent(key, serverId));
    if (value === undefined && keys.length === 0) return values;
    if (value !== undefined && keys.length === 1 && keys[0] === serverId && values[serverId] === value) return values;
    const next = { ...values };
    for (const key of keys) delete next[key];
    if (value !== undefined) next[serverId] = value;
    return next;
}

export function resolveSessionListMachineDisplaysForServer(
    state: Pick<SessionsDomainDependencies, 'machineDisplayById' | 'machineListByServerId'>,
    serverId: string,
) {
    const scopedMachines = state.machineListByServerId?.[serverId];
    return Array.isArray(scopedMachines)
        ? buildMachineDisplaysByIdFromMachineList(scopedMachines)
        : state.machineDisplayById;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left === right || (
        left.length === right.length
        && left.every((value, index) => value === right[index])
    );
}

/**
 * Reuses the store-maintained transcript aggregate for a renderable rebuild
 * when it is still valid for the session's current `completedRequests`.
 * Returns `null` otherwise so callers fall back to the stored-messages walk
 * (byte-identical derivation, one extra linear pass).
 */
function readReusableRenderableAggregate(
    sessionMessages: unknown,
    session: Pick<Session, 'accessLevel' | 'agentState' | 'metadata' | 'metadataLayoutVersion'>,
): TranscriptRenderableAggregate | null {
    if ((sessionMessages as { isLoaded?: unknown } | null | undefined)?.isLoaded !== true) return null;
    const aggregate = (sessionMessages as { renderableAggregate?: unknown } | null | undefined)?.renderableAggregate;
    if (!isTranscriptRenderableAggregate(aggregate)) return null;
    const completedRequests = readSessionPresentationCompletedRequests(session);
    return canReuseTranscriptRenderableAggregateRequestStates(aggregate, completedRequests) ? aggregate : null;
}

function readLoadedStoredSessionMessagesForRenderable(sessionMessages: unknown) {
    if ((sessionMessages as { isLoaded?: unknown } | null | undefined)?.isLoaded !== true) return undefined;
    return readStoredSessionMessagesFromStateLike(sessionMessages as Parameters<typeof readStoredSessionMessagesFromStateLike>[0]);
}

export type SessionListRowPatchOperation = SessionListRenderablePatchFields
    | ((current: SessionListRenderableSession) => SessionListRenderablePatchFields | null);

type SessionListRowsPublicationBaseline = Readonly<{
    rows: Readonly<Record<string, SessionListRenderableSession>>;
    fullPublicationBaseline: Readonly<Record<string, number | undefined>>;
}>;

function didSessionListRowChangeSinceBaseline(
    serverId: string,
    sessionId: string,
    currentRows: Readonly<Record<string, SessionListRenderableSession>>,
    baseline: SessionListRowsPublicationBaseline,
): boolean {
    const address = normalizeSessionAddress(serverId, sessionId);
    return currentRows[sessionId] !== baseline.rows[sessionId]
        || (address ? sessionRuntimeObservations.read(address)?.fullPublicationUpdatedAt : undefined)
            !== baseline.fullPublicationBaseline[sessionId];
}

export type SessionsDomain = {
    /** Client-local archive admission, independent of Home focus and row hydration. */
    sessionArchiveOperations: SessionArchiveOperations;
    beginSessionArchive: (address: SessionAddress) => SessionArchiveOperation | null;
    finishSessionArchive: (operation: SessionArchiveOperation) => void;
    clearSessionArchiveOperations: (serverId?: string) => void;
    sessions: Record<string, Session>;
    projectAuthoringSessions: ProjectAuthoringSessionInputs;
    /**
     * Ids this viewer has watched be deleted.
     *
     * Neither canonical row state nor `sessions` answers "does this session exist", because
     * both are scoped caches. A replace-mode `/v2/sessions` page evicts ordinary membership,
     * while `sessions` holds only the records this run
     * actually hydrated, a deliberately small set, so it cannot cover an evicted row either.
     *
     * `deleteSession` is the one signal that does mean gone. Every caller reaches it through
     * `handleDeleteSessionSocketUpdate`, on server evidence only: the socket `delete-session`
     * update, the socket `session-share-revoked` update (the session survives for its owner but
     * not for this viewer), an exact session fetch answering `not_found`, and
     * `retireLocalSession`, the local half of an already-authoritative server DELETE. Those are
     * the same grounds the session route states. Anything that must distinguish gone from
     * not-cached — a durable pointer such as a transcript session reference — reads this map
     * rather than inferring absence.
     */
    deletedSessionIds: Record<string, string | true>;
    sessionListRenderableDelta: import('./sessionListIndexFinalization').SessionListRenderableDelta;
    /** Canonical qualified rows. Presence here does not imply ordinary-list membership. */
    sessionListRowsByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    ordinarySessionListMembershipByServerId: Readonly<Record<string, readonly string[] | undefined>>;
    archivedSessionListMembershipByServerId: Readonly<Record<string, readonly string[] | undefined>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    /**
     * Last applied strict-query membership per corpus (`buildSessionListQueryKey`), qualified by
     * the Home and Account it was read under. The query controller owns requests and cursors and
     * commits each applied page here; list surfaces render from this, so a remounted controller,
     * a refresh or an unreachable Home keeps the last-known rows until an authoritative page
     * replaces them. Access denial and credential retirement remove it.
     */
    sessionListQueryMembershipByKey: Readonly<Record<string, SessionListQueryMembership | undefined>>;
    sessionScmStatus: Record<string, ScmStatus | null>;
    sessionLastViewed: Record<string, number>;
    sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]>;
    workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: Record<string, string[]>;
    reviewCommentsDraftsBySessionId: Record<string, ReviewCommentDraft[]>;
    reviewCommentsDraftsByWorkspaceCacheKey: Record<string, ReviewCommentDraft[]>;
    sessionActionDraftsByAddressKey: Record<string, SessionActionDraft[]>;
    sessionLocalStateScope: ServerAccountScope | null;
    isDataReady: boolean;
    isSessionDraftsReady: boolean;

    activateSessionLocalStateScope: (scope: ServerAccountScope) => void;
    clearSessionLocalStateScope: () => void;
    getActiveSessions: () => Session[];
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    applyServerScopedSessionListRows: (
        serverId: string,
        sessions: SessionListRenderableSession[],
        options: Readonly<{ source: 'ordinary' | 'archived' | 'query' | 'rowOnly'; mode: 'replace' | 'append'; baseline?: never }>
            | Readonly<{ source: 'rowOnly'; mode: 'append'; baseline: SessionListRowsPublicationBaseline }>,
    ) => void | SessionListRowsPublicationBaseline;
    applyServerScopedSessionListRowPatches: (
        serverId: string,
        patches: ReadonlyArray<Readonly<{
            sessionId: string;
            patch: SessionListRowPatchOperation;
        }>>,
    ) => void;
    reconcileSessionListRowsForServerScope: (
        serverId: string,
        sessions: SessionListRenderableSession[],
        baseline: Readonly<Record<string, SessionListRenderableSession>>,
        fullPublicationBaseline: Readonly<Record<string, number | undefined>>,
    ) => void;
    mergeSessionListRowsForServerScope: (serverId: string, sessions: SessionListRenderableSession[]) => void;
    clearSessionListRowsForServerScope: (serverId: string) => void;
    commitSessionListQueryMembership: (queryKey: string, membership: SessionListQueryMembership | null) => void;
    /**
     * Local restore phase: publish the focused Home's persisted strict-query memberships for this
     * Account as `lastKnown`, for corpora the store does not already hold.
     */
    restoreSessionListQueryMemberships: (serverId: string, accountId: string) => void;
    applyReady: () => void;

    applyScmStatus: (sessionId: string, status: ScmStatus | null) => void;
    getSessionRepositoryTreeExpandedPaths: (sessionId: string) => string[];
    setSessionRepositoryTreeExpandedPaths: (sessionId: string, paths: string[]) => void;
    clearSessionRepositoryTreeExpandedPaths: (sessionId: string) => void;
    getWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase) => string[];
    setWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase, paths: string[]) => void;
    clearWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionResuming: (sessionId: string) => void;
    armSessionResumingFallback: (sessionId: string) => void;
    clearSessionResuming: (sessionId: string) => void;
    clearSessionThinkingGrace: (sessionId: string) => void;
    applySessionTerminalLifecycle: (sessionId: string, turnCompletedAt: number | null) => void;
    markSessionViewed: (sessionId: string) => void;
    /** Applies the server's authoritative responsible Account after a committed mutation. */
    applySessionResponsibleAccount: (sessionId: string, responsibleAccountId: string | null, scope: ServerAccountScope, responsibleAccount?: import('@happier-dev/protocol').SessionAccessAccountSummaryV1 | null) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode, context?: SessionModelOptionsContext) => void;
    upsertSessionReviewCommentDraft: (sessionId: string, draft: ReviewCommentDraft) => void;
    setSessionReviewCommentDraftIncluded: (sessionId: string, commentId: string, included: boolean) => void;
    deleteSessionReviewCommentDraft: (sessionId: string, commentId: string, expectedDraft?: ReviewCommentDraft) => void;
    clearSessionReviewCommentDrafts: (sessionId: string) => void;
    upsertWorkspaceReviewCommentDraft: (workspaceCacheKey: string, draft: ReviewCommentDraft) => void;
    setWorkspaceReviewCommentDraftIncluded: (workspaceCacheKey: string, commentId: string, included: boolean) => void;
    deleteWorkspaceReviewCommentDraft: (workspaceCacheKey: string, commentId: string, expectedDraft?: ReviewCommentDraft) => void;
    clearWorkspaceReviewCommentDrafts: (workspaceCacheKey: string) => void;
    createSessionActionDraft: (
        scope: ServerAccountScope,
        address: SessionAddress,
        draft: Readonly<{ actionId: string; input?: Record<string, unknown> }>,
    ) => SessionActionDraft;
    updateSessionActionDraftInput: (scope: ServerAccountScope, address: SessionAddress, draftId: string, patch: Record<string, unknown>) => void;
    setSessionActionDraftStatus: (scope: ServerAccountScope, address: SessionAddress, draftId: string, status: SessionActionDraftStatus, error?: string | null) => void;
    deleteSessionActionDraft: (scope: ServerAccountScope, address: SessionAddress, draftId: string) => void;
    clearSessionActionDrafts: (scope: ServerAccountScope, address: SessionAddress) => void;

    getProject: (projectId: string) => import('../../runtime/orchestration/projectManager').Project | null;
    getProjectForSession: (sessionId: string, serverId?: string | null) => import('../../runtime/orchestration/projectManager').Project | null;

    getProjectScmStatus: (projectId: string) => ScmStatus | null;
    getSessionProjectScmStatus: (sessionId: string, serverId?: string | null) => ScmStatus | null;
    updateSessionProjectScmStatus: (sessionId: string, status: ScmStatus | null, serverId?: string | null) => void;
    getProjectScmSnapshot: (projectId: string) => ScmWorkingSnapshot | null;
    getProjectScmSnapshotError: (projectId: string) => ProjectScmSnapshotError | null;
    getSessionProjectScmSnapshot: (sessionId: string, serverId?: string | null) => ScmWorkingSnapshot | null;
    getSessionProjectScmSnapshotError: (sessionId: string, serverId?: string | null) => ProjectScmSnapshotError | null;
    updateSessionProjectScmSnapshot: (sessionId: string, snapshot: ScmWorkingSnapshot | null, serverId?: string | null) => void;
    updateSessionProjectScmSnapshotError: (sessionId: string, error: ProjectScmSnapshotError | null, serverId?: string | null) => void;
    publishSessionProjectScmSnapshots: (
        publishes: ReadonlyArray<Readonly<{
            sessionId: string;
            serverId?: string | null;
            snapshot: ScmWorkingSnapshot;
            status: ScmStatus | null;
        }>>,
    ) => void;
    getWorkspaceScmTouchedPathsForSession: (sessionId: string, serverId?: string | null) => string[];
    markWorkspaceScmTouchedPathsForSession: (sessionId: string, paths: string[], serverId?: string | null) => void;
    pruneWorkspaceScmTouchedPathsForSession: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => void;
    getSessionProjectScmCommitSelectionPaths: (sessionId: string, serverId?: string | null) => string[];
    markSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[], serverId?: string | null) => void;
    unmarkSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[], serverId?: string | null) => void;
    clearSessionProjectScmCommitSelectionPaths: (sessionId: string, serverId?: string | null) => void;
    pruneSessionProjectScmCommitSelectionPaths: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => void;
    getSessionProjectScmCommitSelectionPatches: (sessionId: string, serverId?: string | null) => ScmCommitSelectionPatch[];
    upsertSessionProjectScmCommitSelectionPatch: (sessionId: string, patchSelection: ScmCommitSelectionPatch, serverId?: string | null) => void;
    removeSessionProjectScmCommitSelectionPatch: (sessionId: string, path: string, serverId?: string | null) => void;
    clearSessionProjectScmCommitSelectionPatches: (sessionId: string, serverId?: string | null) => void;
    pruneSessionProjectScmCommitSelectionPatches: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => void;
    getSessionProjectScmOperationLog: (sessionId: string, serverId?: string | null) => ScmOperationLogEntry[];
    appendSessionProjectScmOperation: (
        sessionId: string,
        entry: Omit<ScmOperationLogEntry, 'id' | 'sessionId'>,
        serverId?: string | null,
    ) => void;
    getSessionProjectScmInFlightOperation: (sessionId: string, serverId?: string | null) => ScmInFlightOperation | null;
    beginSessionProjectScmOperation: (
        sessionId: string,
        operation: import('../../runtime/orchestration/projectManager').ScmProjectOperationKind,
        serverId?: string | null,
    ) => BeginScmOperationResult;
    finishSessionProjectScmOperation: (sessionId: string, operationId: string, serverId?: string | null) => boolean;
    updateSessionProjectScmOperationProgress: (sessionId: string, operationId: string, progressText?: string, serverId?: string | null) => boolean;

    getWorkspaceScmStatus: (scope: WorkspaceScopeBase) => ScmStatus | null;
    updateWorkspaceScmStatus: (scope: WorkspaceScopeBase, status: ScmStatus | null) => void;
    getWorkspaceScmSnapshot: (scope: WorkspaceScopeBase) => ScmWorkingSnapshot | null;
    getWorkspaceScmSnapshotError: (scope: WorkspaceScopeBase) => ProjectScmSnapshotError | null;
    updateWorkspaceScmSnapshot: (scope: WorkspaceScopeBase, snapshot: ScmWorkingSnapshot | null) => void;
    updateWorkspaceScmSnapshotError: (scope: WorkspaceScopeBase, error: ProjectScmSnapshotError | null) => void;
    getWorkspaceScmTouchedPaths: (scope: WorkspaceScopeBase) => string[];
    markWorkspaceScmTouchedPaths: (scope: WorkspaceScopeBase, paths: string[], touchedAt?: number) => void;
    pruneWorkspaceScmTouchedPaths: (scope: WorkspaceScopeBase, activePaths: Set<string>) => void;
    getWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase) => string[];
    markWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase, paths: string[], selectedAt?: number) => void;
    unmarkWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase, paths: string[]) => void;
    clearWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase) => void;
    pruneWorkspaceScmCommitSelectionPaths: (scope: WorkspaceScopeBase, activePaths: Set<string>) => void;
    getWorkspaceScmCommitSelectionPatches: (scope: WorkspaceScopeBase) => ScmCommitSelectionPatch[];
    upsertWorkspaceScmCommitSelectionPatch: (scope: WorkspaceScopeBase, patchSelection: ScmCommitSelectionPatch, selectedAt?: number) => void;
    removeWorkspaceScmCommitSelectionPatch: (scope: WorkspaceScopeBase, path: string) => void;
    clearWorkspaceScmCommitSelectionPatches: (scope: WorkspaceScopeBase) => void;
    pruneWorkspaceScmCommitSelectionPatches: (scope: WorkspaceScopeBase, activePaths: Set<string>) => void;
    getWorkspaceScmOperationLog: (scope: WorkspaceScopeBase) => ScmOperationLogEntry[];
    appendWorkspaceScmOperation: (scope: WorkspaceScopeBase, entry: Omit<ScmOperationLogEntry, 'id' | 'sessionId'>) => void;
    getWorkspaceScmInFlightOperation: (scope: WorkspaceScopeBase) => ScmInFlightOperation | null;
    beginWorkspaceScmOperation: (scope: WorkspaceScopeBase, operation: import('../../runtime/orchestration/projectManager').ScmProjectOperationKind) => BeginScmOperationResult;
    finishWorkspaceScmOperation: (scope: WorkspaceScopeBase, operationId: string) => boolean;
    updateWorkspaceScmOperationProgress: (scope: WorkspaceScopeBase, operationId: string, progressText?: string) => boolean;

    /**
     * Retire a Session locally for ONE Home, or for every Home when `serverId` is
     * omitted or null. Only the addressed Home's row/membership/index goes; the
     * shared per-id carrier (record, transcript, SCM, drafts, modes) goes only when
     * that Home is the carrier's own — see `shouldRetireSessionCarrierForServer`.
     */
    deleteSession: (sessionId: string, serverId?: string | null) => void;
};

type SessionsDomainDependencies = {
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, import('../../domains/machines/machineDisplayRenderable').MachineDisplayRenderable>;
    machineListByServerId?: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    sessionMessages: Record<string, SessionMessages>;
    sessionMessagesHistoryStartLoaded: Record<string, true>;
    profile: { id: string };
    // Keep resilient: older settings payloads (or partial boot states) may not yet include this key.
    settings: {
        sessionListActiveGroupingV1?: 'project' | 'date';
        sessionListInactiveGroupingV1?: 'project' | 'date';
        sessionListSectionModeV1?: 'activity' | 'single';
    };
};

// UI-only "optimistic processing" marker.
// Cleared via timers so components don't need to poll time.
const OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS = 15_000;
const optimisticThinkingTimeouts = createKeyedTimeoutScheduler();
const resumingTimeouts = createKeyedTimeoutScheduler();

// UI-only "thinking debounce" marker.
// Kept for a short grace period after the session stops streaming, so the UI doesn't flicker
// between "working" and "online" between output chunks.
const SESSION_THINKING_GRACE_TIMEOUT_MS = 3_000;
const thinkingGraceTimeouts = createKeyedTimeoutScheduler();
const SESSION_LIST_WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS = 1_000;

let actionDraftIdCounter = 0;
function createActionDraftId(nowMs: number): string {
    actionDraftIdCounter += 1;
    return `action_draft_${nowMs}_${actionDraftIdCounter}`;
}

type IncomingSessionApply = Omit<Session, 'presence'> & { presence?: 'online' | number };

function resolveOrderedSessionApply(
    previousSession: Session | undefined,
    incomingSession: IncomingSessionApply,
): IncomingSessionApply {
    let nextSession: IncomingSessionApply = reconcileSessionLifecycleProjection(previousSession, reconcileSessionTupleProjection(previousSession, incomingSession));
    if (!previousSession) return nextSession;
    const applyPatch = (patch: Partial<IncomingSessionApply>): void => {
        nextSession = { ...nextSession, ...patch };
    };
    // HTTP hydration omits device-local presence. Keep its last observation only
    // for this Home's carrier; an explicit undefined still invalidates it.
    const previousServerId = normalizeTrimmedString(previousSession.serverId);
    const incomingServerId = normalizeTrimmedString(incomingSession.serverId);
    const isSameHome = previousServerId === incomingServerId || (
        previousServerId !== null && incomingServerId !== null
        && areServerProfileIdentifiersEquivalent(previousServerId, incomingServerId)
    );
    if (isSameHome && !Object.prototype.hasOwnProperty.call(incomingSession, 'presence')) {
        applyPatch({ presence: previousSession.presence });
    }
    // Additive-optional presentation projection: an omitted value carries no
    // information (older producer or partial writer), so it preserves the last
    // known server decision instead of asserting a solo Session. An explicit
    // boolean, including `false`, always replaces it.
    if (incomingSession.hasOtherNamedCollaborator === undefined && previousSession.hasOtherNamedCollaborator !== undefined) {
        applyPatch({ hasOtherNamedCollaborator: previousSession.hasOtherNamedCollaborator });
    }

    return nextSession;
}

/**
 * Keep the one safe shared projection that an authorized layout-v1 recipient already saw while
 * a subsequent hydration is locked. This belongs at the Session store owner so HTTP, socket and
 * snapshot writers cannot disagree. The projection is deliberately discarded on any content,
 * access, or Home change; owner rows never qualify.
 */
function resolveLockedDisplayTitle(
    previousSession: Session | undefined,
    incomingSession: IncomingSessionApply,
): string | null {
    if (
        readSessionMetadataLayoutVersion(incomingSession.metadataLayoutVersion) !== 1
        || incomingSession.metadata !== null
        || !isSessionAccessRecipient(incomingSession.access, incomingSession.accessLevel)
    ) {
        return null;
    }

    const incomingServerId = normalizeTrimmedString(incomingSession.serverId);
    if (!previousSession) return null;
    const previousServerId = normalizeTrimmedString(previousSession.serverId);
    if (
        !incomingServerId
        || !previousServerId
        || !areServerProfileIdentifiersEquivalent(previousServerId, incomingServerId)
        || readSessionMetadataLayoutVersion(previousSession.metadataLayoutVersion) !== 1
        || !isSessionAccessRecipient(previousSession.access, previousSession.accessLevel)
    ) {
        return null;
    }

    const sharedMetadata = readSessionListRenderableSourceMetadata(previousSession);
    return readSessionDisplayTitleField({ metadata: sharedMetadata }).value
        ?? (typeof previousSession.lockedDisplayTitle === 'string'
            ? previousSession.lockedDisplayTitle.trim() || null
            : null);
}

function measureSessionApplyPhase<T>(
    name: string,
    fields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, fields(), fn);
}

function didPreserveRenderableMetadata(
    previous: SessionListRenderableSession | undefined,
    incoming: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    return incoming.metadata == null
        && previous?.metadata != null
        && next.metadata === previous.metadata
        && next.metadataVersion === previous.metadataVersion;
}

function didPreserveRenderablePendingFlags(
    previous: SessionListRenderableSession | undefined,
    incoming: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;
    return incoming.active === true
        && typeof incoming.hasPendingPermissionRequests !== 'boolean'
        && typeof incoming.hasPendingUserActionRequests !== 'boolean'
        && next.agentStateVersion === previous.agentStateVersion
        && (
            next.hasPendingPermissionRequests === previous.hasPendingPermissionRequests
            || next.hasPendingUserActionRequests === previous.hasPendingUserActionRequests
            || (
                typeof incoming.pendingBlockedCount !== 'number'
                && typeof previous.pendingBlockedCount === 'number'
                && next.pendingBlockedCount === previous.pendingBlockedCount
            )
        );
}

/**
 * The strict-query warm cache mirrors the store: each change to the focused Home's memberships
 * rewrites that Account's record from the memberships a page confirmed in this process. Retirement
 * (access denial, credential retirement, Account replacement) therefore deletes it too, and a
 * restored-only (`lastKnown`) corpus the process never read again is not carried forward, which is
 * what keeps the record bounded. Ids per corpus follow the session-list row window: only rows that
 * window persists can render after a reload.
 */
function saveSessionListQueryMembershipWarmCacheForChange(
    memberships: SessionsDomain['sessionListQueryMembershipByKey'],
    changed: ReadonlyArray<SessionListQueryMembership>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    if (!activeServerId) return;
    const accountIds = new Set(changed
        .filter((membership) => areServerProfileIdentifiersEquivalent(membership.serverId, activeServerId))
        .map((membership) => membership.accountId));
    for (const accountId of accountIds) {
        const entries: Record<string, SessionListQueryMembershipCacheEntryV1> = {};
        for (const [queryKey, membership] of Object.entries(memberships)) {
            if (!membership || membership.lastKnown || membership.accountId !== accountId) continue;
            if (!areServerProfileIdentifiersEquivalent(membership.serverId, activeServerId)) continue;
            entries[queryKey] = {
                serverId: membership.serverId,
                sessionIds: membership.sessionIds.slice(0, SESSION_LIST_WARM_CACHE_MAX_ENTRIES),
            };
        }
        saveSessionListQueryMembershipWarmCacheEntries(activeServerId, accountId, entries);
    }
}

function listChangedSessionListQueryMemberships(
    previous: SessionsDomain['sessionListQueryMembershipByKey'],
    next: SessionsDomain['sessionListQueryMembershipByKey'],
): SessionListQueryMembership[] {
    if (previous === next) return [];
    const changed: SessionListQueryMembership[] = [];
    for (const queryKey of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        const before = previous[queryKey];
        const after = next[queryKey];
        if (before === after) continue;
        if (before) changed.push(before);
        if (after) changed.push(after);
    }
    return changed;
}

export function createSessionsDomain<S extends SessionsDomain & SessionsDomainDependencies>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): SessionsDomain {
    let sessionLocalStateScope: ServerAccountScope | null = null;
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    let sessionPermissionModeUpdatedAts = loadSessionPermissionModeUpdatedAts();
    let sessionModelModeUpdatedAts = loadSessionModelModeUpdatedAts();
    let sessionLastViewed = loadSessionLastViewed();
    let reviewCommentsDraftsBySessionId = loadSessionReviewCommentsDrafts();
    let reviewCommentsDraftsByWorkspaceCacheKey = loadWorkspaceReviewCommentsDrafts();
    let sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]> = {};
    let workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: Record<string, string[]> = {};
    let sessionActionDraftsByAddressKey: Record<string, SessionActionDraft[]> = {};
    let deferredWarmCacheSaveTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearDeferredWarmCacheSave = (): void => {
        if (!deferredWarmCacheSaveTimeout) return;
        clearTimeout(deferredWarmCacheSaveTimeout);
        deferredWarmCacheSaveTimeout = null;
    };

    const saveWarmSessionCacheImmediately = (
        state: SessionsDomain & SessionsDomainDependencies,
        previousEntries?: Record<string, SessionListCacheEntryV1>,
    ): void => {
        clearDeferredWarmCacheSave();
        saveWarmSessionCacheForState(state, previousEntries);
    };

    const scheduleWarmSessionCacheSave = (
        stateForTelemetry?: SessionsDomain & SessionsDomainDependencies,
    ): void => {
        const countActiveOrdinaryRows = (state: SessionsDomain & SessionsDomainDependencies): number => {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            return activeServerId
                ? (state.ordinarySessionListMembershipByServerId[activeServerId]?.length ?? 0)
                : 0;
        };
        if (deferredWarmCacheSaveTimeout) {
            syncPerformanceTelemetry.countLazy('sync.store.sessions.warmCache.schedule', () => ({
                coalesced: 1,
                renderables: countActiveOrdinaryRows(stateForTelemetry ?? get()),
                scheduled: 0,
            }));
            return;
        }
        syncPerformanceTelemetry.countLazy('sync.store.sessions.warmCache.schedule', () => ({
            coalesced: 0,
            renderables: countActiveOrdinaryRows(stateForTelemetry ?? get()),
            scheduled: 1,
        }));
        deferredWarmCacheSaveTimeout = setTimeout(() => {
            deferredWarmCacheSaveTimeout = null;
            const currentState = get();
            measureSessionApplyPhase(
                'sync.store.sessions.warmCache.flush',
                () => ({ renderables: countActiveOrdinaryRows(currentState) }),
                () => saveWarmSessionCacheForState(currentState),
            );
        }, SESSION_LIST_WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS);
    };
    const hydrateSessionLocalStateScope = (scope: ServerAccountScope) => {
        sessionLocalStateScope = scope;
        sessionPermissionModes = loadSessionPermissionModes(scope);
        sessionModelModes = loadSessionModelModes(scope);
        sessionPermissionModeUpdatedAts = loadSessionPermissionModeUpdatedAts(scope);
        sessionModelModeUpdatedAts = loadSessionModelModeUpdatedAts(scope);
        sessionLastViewed = loadSessionLastViewed(scope);
        reviewCommentsDraftsBySessionId = loadSessionReviewCommentsDrafts(scope);
        reviewCommentsDraftsByWorkspaceCacheKey = loadWorkspaceReviewCommentsDrafts(scope);
        sessionActionDraftsByAddressKey = {
            ...Object.fromEntries(Object.entries(sessionActionDraftsByAddressKey).filter(([, drafts]) => (
                drafts[0]?.address.serverId !== scope.serverId || drafts[0]?.accountId === scope.accountId
            ))),
            ...loadSessionActionDrafts(scope),
        };
    };
    const resolveWorkspaceTargetForSessionInStore = (sessionId: string) =>
        resolveWorkspaceTargetForSessionFromState(get(), sessionId);
    const ensureProjectManagerSession = (sessionId: string): void => {
        const state = get();
        const session = state.sessions[sessionId];
        if (!session) return;
        const metadata = readSessionOwnerMetadataView(session);
        if (!metadata?.path) return;

        const machineId = typeof metadata.machineId === 'string' ? metadata.machineId : '';
        const machineMetadata = machineId ? state.machines[machineId]?.metadata ?? null : undefined;
        const sessionServerId =
            'serverId' in session && typeof session.serverId === 'string'
                ? session.serverId.trim()
                : '';
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        projectManager.addSession(session, {
            serverId: sessionServerId || activeServerId || null,
            machineMetadata: machineMetadata ?? null,
        });
    };

    const updateSessionResumingAt = (sessionId: string, resumingAt: number | null): void => {
        set((state) => {
            const session = state.sessions[sessionId];
            if (!session || (session.resumingAt ?? null) === resumingAt) return state;

            // Capture this Home's already-observed recency before message-first updates can
            // advance the row; legacy hydration carrying that baseline is not new activity.
            const observedMeaningfulActivityAt = resumingAt === null ? null : normalizeSessionOrderingNumber(
                readSessionListRowForServerId(state.sessionListRowsByServerId, session.serverId, sessionId)?.meaningfulActivityAt,
            );
            const previousMeaningfulActivityAt = normalizeSessionOrderingNumber(session.meaningfulActivityAt);
            const nextSession = {
                ...session,
                resumingAt,
                ...(observedMeaningfulActivityAt !== null
                    && observedMeaningfulActivityAt > (previousMeaningfulActivityAt ?? 0)
                    ? { meaningfulActivityAt: observedMeaningfulActivityAt }
                    : {}),
            };
            let nextRowsByServerId = state.sessionListRowsByServerId;
            for (const [serverId, rows] of Object.entries(state.sessionListRowsByServerId ?? {})) {
                const row = rows?.[sessionId];
                if (!row || (row.resumingAt ?? null) === resumingAt) continue;
                nextRowsByServerId = {
                    ...nextRowsByServerId,
                    [serverId]: {
                        ...rows,
                        [sessionId]: { ...row, resumingAt },
                    },
                };
            }

            return {
                ...state,
                sessions: { ...state.sessions, [sessionId]: nextSession },
                sessionListRowsByServerId: nextRowsByServerId,
            };
        });
    };

    const clearServerScopedSessionListRows = (serverIdRaw: string): void => set((state) => {
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw.trim());
        const retainedQueryMemberships = Object.entries(state.sessionListQueryMembershipByKey)
            .filter(([, membership]) => membership && !areServerProfileIdentifiersEquivalent(membership.serverId, serverId));
        const didRemoveQueryMembership = retainedQueryMemberships.length
            !== Object.keys(state.sessionListQueryMembershipByKey).length;
        if (!serverId) return state;
        const nextRowsByServerId = publishSessionListHomeValue(state.sessionListRowsByServerId, serverId, undefined);
        const nextOrdinaryMembershipByServerId = publishSessionListHomeValue(state.ordinarySessionListMembershipByServerId, serverId, undefined);
        const nextArchivedMembershipByServerId = publishSessionListHomeValue(state.archivedSessionListMembershipByServerId, serverId, undefined);
        const nextIndexByServerId = publishSessionListHomeValue(state.sessionListIndexByServerId, serverId, undefined);
        if (nextRowsByServerId === state.sessionListRowsByServerId
            && nextOrdinaryMembershipByServerId === state.ordinarySessionListMembershipByServerId
            && nextArchivedMembershipByServerId === state.archivedSessionListMembershipByServerId
            && nextIndexByServerId === state.sessionListIndexByServerId
            && !didRemoveQueryMembership) return state;
        const removedSessionIds = [...new Set(Object.entries(state.ordinarySessionListMembershipByServerId)
            .flatMap(([key, ids]) => areServerProfileIdentifiersEquivalent(key, serverId) ? ids ?? [] : []))];
        const nextStateBase = {
            ...state,
            sessionListRowsByServerId: nextRowsByServerId,
            ordinarySessionListMembershipByServerId: nextOrdinaryMembershipByServerId,
            archivedSessionListMembershipByServerId: nextArchivedMembershipByServerId,
            sessionListIndexByServerId: nextIndexByServerId,
            ...(didRemoveQueryMembership
                ? { sessionListQueryMembershipByKey: Object.fromEntries(retainedQueryMemberships) }
                : {}),
        };
        return finalizeSessionListRenderablePublication(
            state,
            nextStateBase,
            nextIndexByServerId !== state.sessionListIndexByServerId,
            serverId === activeServerId && removedSessionIds.length > 0,
            false,
            { warmCacheEventName: 'sync.store.sessions.renderables.clear.warmCache' },
            {
                saveImmediately: saveWarmSessionCacheImmediately,
                scheduleDeferredSave: scheduleWarmSessionCacheSave,
            },
            removedSessionIds.length > 0 ? { changedSessionIds: [], removedSessionIds } : undefined,
        );
    });

    const applySessionListQueryMembershipCommit = (
        queryKey: string,
        membership: SessionListQueryMembership | null,
    ): void => set((state) => {
        const previous = state.sessionListQueryMembershipByKey[queryKey];
        if (!membership) {
            if (!previous) return state;
            const next = { ...state.sessionListQueryMembershipByKey };
            delete next[queryKey];
            return { ...state, sessionListQueryMembershipByKey: next };
        }
        if (
            previous
            // A restored `lastKnown` entry is always replaced by an applied page.
            && previous.lastKnown !== true
            && previous.serverId === membership.serverId
            && previous.accountId === membership.accountId
            && areStringArraysEqual(previous.sessionIds, membership.sessionIds)
        ) {
            return state;
        }
        return {
            ...state,
            sessionListQueryMembershipByKey: { ...state.sessionListQueryMembershipByKey, [queryKey]: membership },
        };
    });

    return {
        sessionArchiveOperations: {},
        beginSessionArchive: (address) => {
            const captured = resolveSessionArchiveAddress(address);
            if (!captured) return null;
            let operation: SessionArchiveOperation | null = null;
            set((state) => {
                if (readSessionArchivePending(state, captured)) return state;
                operation = captured;
                return { ...state, sessionArchiveOperations: {
                    ...state.sessionArchiveOperations,
                    [captured.serverId]: { ...state.sessionArchiveOperations[captured.serverId], [captured.sessionId]: captured },
                } };
            });
            return operation;
        },
        finishSessionArchive: (operation) => set((state) => {
            const bucket = state.sessionArchiveOperations[operation.serverId];
            if (bucket?.[operation.sessionId] !== operation) return state;
            const { [operation.sessionId]: _finished, ...remaining } = bucket;
            const next = { ...state.sessionArchiveOperations };
            if (Object.keys(remaining).length > 0) next[operation.serverId] = remaining;
            else delete next[operation.serverId];
            return { ...state, sessionArchiveOperations: next };
        }),
        clearSessionArchiveOperations: (serverId) => set((state) => {
            const keys = Object.keys(state.sessionArchiveOperations);
            if (keys.length === 0) return state;
            if (serverId === undefined) return { ...state, sessionArchiveOperations: {} };
            const retired = keys.filter(key => areServerProfileIdentifiersEquivalent(key, serverId));
            if (retired.length === 0) return state;
            const next = { ...state.sessionArchiveOperations };
            for (const key of retired) delete next[key];
            return { ...state, sessionArchiveOperations: next };
        }),
        sessions: {},
        projectAuthoringSessions: EMPTY_PROJECT_AUTHORING_SESSION_INPUTS,
        deletedSessionIds: {},
        sessionListRenderableDelta: {
            revision: 0,
            changedSessionIds: [],
            removedSessionIds: [],
            rebuiltSessionListIndex: false,
        },
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        archivedSessionListMembershipByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionListQueryMembershipByKey: {},
        sessionScmStatus: {},
        sessionLastViewed,
        sessionRepositoryTreeExpandedPathsBySessionId,
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
        reviewCommentsDraftsBySessionId,
        reviewCommentsDraftsByWorkspaceCacheKey,
        sessionActionDraftsByAddressKey,
        sessionLocalStateScope,
        isDataReady: false,
        isSessionDraftsReady: false,
        activateSessionLocalStateScope: (scope) => {
            clearDeferredWarmCacheSave();
            prepareSessionLocalStateScopeForActivation(scope);
            hydrateSessionLocalStateScope(scope);
            set((state) => {
                let nextSessions = state.sessions;
                for (const [sessionId, session] of Object.entries(state.sessions)) {
                    const scopedPermissionMode = sessionPermissionModes[sessionId] ?? 'default';
                    const scopedPermissionModeUpdatedAt = sessionPermissionModeUpdatedAts[sessionId] ?? null;
                    const scopedModelMode = sessionModelModes[sessionId] ?? 'default';
                    const scopedModelModeUpdatedAt = sessionModelModeUpdatedAts[sessionId] ?? null;
                    if (
                        session.permissionMode === scopedPermissionMode
                        && (session.permissionModeUpdatedAt ?? null) === scopedPermissionModeUpdatedAt
                        && session.modelMode === scopedModelMode
                        && (session.modelModeUpdatedAt ?? null) === scopedModelModeUpdatedAt
                    ) {
                        continue;
                    }
                    if (nextSessions === state.sessions) {
                        nextSessions = { ...state.sessions };
                    }
                    nextSessions[sessionId] = {
                        ...session,
                        permissionMode: scopedPermissionMode,
                        permissionModeUpdatedAt: scopedPermissionModeUpdatedAt,
                        modelMode: scopedModelMode,
                        modelModeUpdatedAt: scopedModelModeUpdatedAt,
                    };
                }

                const nextLastViewed = areSessionValuesDeepEqual(state.sessionLastViewed, sessionLastViewed)
                    ? state.sessionLastViewed : { ...sessionLastViewed };
                const nextSessionReviews = areSessionValuesDeepEqual(state.reviewCommentsDraftsBySessionId, reviewCommentsDraftsBySessionId)
                    ? state.reviewCommentsDraftsBySessionId
                    : reuseEqualSessionObjectFields(state.reviewCommentsDraftsBySessionId, reviewCommentsDraftsBySessionId);
                const nextWorkspaceReviews = areSessionValuesDeepEqual(state.reviewCommentsDraftsByWorkspaceCacheKey, reviewCommentsDraftsByWorkspaceCacheKey)
                    ? state.reviewCommentsDraftsByWorkspaceCacheKey
                    : reuseEqualSessionObjectFields(state.reviewCommentsDraftsByWorkspaceCacheKey, reviewCommentsDraftsByWorkspaceCacheKey);
                const nextActionDrafts = areSessionValuesDeepEqual(state.sessionActionDraftsByAddressKey, sessionActionDraftsByAddressKey)
                    ? state.sessionActionDraftsByAddressKey
                    : reuseEqualSessionObjectFields(state.sessionActionDraftsByAddressKey, sessionActionDraftsByAddressKey);
                const nextScope = areServerAccountScopesEqual(state.sessionLocalStateScope, scope)
                    ? state.sessionLocalStateScope : scope;
                if (nextSessions === state.sessions
                    && nextLastViewed === state.sessionLastViewed
                    && nextSessionReviews === state.reviewCommentsDraftsBySessionId
                    && nextWorkspaceReviews === state.reviewCommentsDraftsByWorkspaceCacheKey
                    && nextActionDrafts === state.sessionActionDraftsByAddressKey
                    && nextScope === state.sessionLocalStateScope) return state;

                return {
                    ...state,
                    sessions: nextSessions,
                    sessionLastViewed: nextLastViewed,
                    reviewCommentsDraftsBySessionId: nextSessionReviews,
                    reviewCommentsDraftsByWorkspaceCacheKey: nextWorkspaceReviews,
                    sessionActionDraftsByAddressKey: nextActionDrafts,
                    sessionLocalStateScope: nextScope,
                };
            });
        },
        clearSessionLocalStateScope: () => {
            clearDeferredWarmCacheSave();
            sessionLocalStateScope = null;
            sessionPermissionModes = {};
            sessionModelModes = {};
            sessionPermissionModeUpdatedAts = {};
            sessionModelModeUpdatedAts = {};
            sessionLastViewed = {};
            reviewCommentsDraftsBySessionId = {};
            reviewCommentsDraftsByWorkspaceCacheKey = {};
            sessionActionDraftsByAddressKey = {};
            set((state) => {
                const lastViewed = Object.keys(state.sessionLastViewed).length === 0 ? state.sessionLastViewed : {};
                const sessionReviews = Object.keys(state.reviewCommentsDraftsBySessionId).length === 0 ? state.reviewCommentsDraftsBySessionId : {};
                const workspaceReviews = Object.keys(state.reviewCommentsDraftsByWorkspaceCacheKey).length === 0 ? state.reviewCommentsDraftsByWorkspaceCacheKey : {};
                const actionDrafts = Object.keys(state.sessionActionDraftsByAddressKey).length === 0 ? state.sessionActionDraftsByAddressKey : {};
                if (state.sessionLocalStateScope === null
                    && lastViewed === state.sessionLastViewed
                    && sessionReviews === state.reviewCommentsDraftsBySessionId
                    && workspaceReviews === state.reviewCommentsDraftsByWorkspaceCacheKey
                    && actionDrafts === state.sessionActionDraftsByAddressKey) return state;
                return {
                    ...state,
                    sessionLastViewed: lastViewed,
                    reviewCommentsDraftsBySessionId: sessionReviews,
                    reviewCommentsDraftsByWorkspaceCacheKey: workspaceReviews,
                    sessionActionDraftsByAddressKey: actionDrafts,
                    sessionLocalStateScope: null,
                };
            });
        },
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
        getSessionRepositoryTreeExpandedPaths: (sessionId: string) => {
            return getSessionRepositoryTreeExpandedPathsForState(get(), sessionId, resolveWorkspaceTargetForSessionInStore);
        },
        setSessionRepositoryTreeExpandedPaths: (sessionId: string, paths: string[]) => set((state) => {
            const nextExpansionState = setSessionRepositoryTreeExpandedPathsForState(
                state,
                sessionId,
                paths,
                resolveWorkspaceTargetForSessionInStore,
            );
            sessionRepositoryTreeExpandedPathsBySessionId =
                nextExpansionState.sessionRepositoryTreeExpandedPathsBySessionId;
            workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey =
                nextExpansionState.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
            return {
                ...state,
                ...nextExpansionState,
            };
        }),
        clearSessionRepositoryTreeExpandedPaths: (sessionId: string) => set((state) => {
            const currentExpansionState = {
                sessionRepositoryTreeExpandedPathsBySessionId: state.sessionRepositoryTreeExpandedPathsBySessionId,
                workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey:
                    state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
            };
            const nextExpansionState = clearSessionRepositoryTreeExpandedPathsForState(
                currentExpansionState,
                sessionId,
                resolveWorkspaceTargetForSessionInStore,
            );
            if (nextExpansionState === currentExpansionState) return state;
            sessionRepositoryTreeExpandedPathsBySessionId =
                nextExpansionState.sessionRepositoryTreeExpandedPathsBySessionId;
            workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey =
                nextExpansionState.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
            return {
                ...state,
                ...nextExpansionState,
            };
        }),
        getWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase) => {
            return getWorkspaceRepositoryTreeExpandedPathsForState(get(), scope);
        },
        setWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase, paths: string[]) => set((state) => {
            const currentExpansionState = {
                sessionRepositoryTreeExpandedPathsBySessionId: state.sessionRepositoryTreeExpandedPathsBySessionId,
                workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey:
                    state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
            };
            const nextExpansionState = setWorkspaceRepositoryTreeExpandedPathsForState(currentExpansionState, scope, paths);
            if (nextExpansionState === currentExpansionState) return state;
            sessionRepositoryTreeExpandedPathsBySessionId =
                nextExpansionState.sessionRepositoryTreeExpandedPathsBySessionId;
            workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey =
                nextExpansionState.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
            return {
                ...state,
                ...nextExpansionState,
            };
        }),
        clearWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase) => set((state) => {
            const currentExpansionState = {
                sessionRepositoryTreeExpandedPathsBySessionId: state.sessionRepositoryTreeExpandedPathsBySessionId,
                workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey:
                    state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
            };
            const nextExpansionState = clearWorkspaceRepositoryTreeExpandedPathsForState(currentExpansionState, scope);
            if (nextExpansionState === currentExpansionState) return state;
            sessionRepositoryTreeExpandedPathsBySessionId =
                nextExpansionState.sessionRepositoryTreeExpandedPathsBySessionId;
            workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey =
                nextExpansionState.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
            return {
                ...state,
                ...nextExpansionState,
            };
        }),
        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => syncPerformanceTelemetry.measure(
            'sync.store.sessions.apply',
            { sessions: sessions.length },
            () => set((state) => {
            const localNowMs = Date.now();

            // Drafts are persisted out-of-band from the session payload, so we must always consult the
            // persisted draft map when hydrating a session. This ensures drafts written for a session
            // before it is loaded (e.g. fork "branch and edit" draft restore) are applied when the
            // session first appears in the store.
            // Persisted maps must be consulted for any session that appears after bootstrap (deep links, pagination,
            // socket-delivered sessions, etc.), not only when the sessions store is initially empty.
            const savedPermissionModes = sessionPermissionModes;
            const savedModelModes = sessionModelModes;
            const savedPermissionModeUpdatedAts = sessionPermissionModeUpdatedAts;
            const savedModelModeUpdatedAts = sessionModelModeUpdatedAts;

            // Merge new sessions with existing ones
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            const activeRows = activeServerId
                ? state.sessionListRowsByServerId[activeServerId] ?? {}
                : {};
            let mergedSessions: Record<string, Session> = state.sessions;
            let projectAuthoringSessions = state.projectAuthoringSessions;
            let mergedRowsByServerId = state.sessionListRowsByServerId;
            let mergedOrdinaryMembershipByServerId = state.ordinarySessionListMembershipByServerId;
            let mergedArchivedMembershipByServerId = state.archivedSessionListMembershipByServerId;
            const inactiveOwnerServerIdsNeedingIndexRebuild = new Set<string>();
            let mergedRenderables: Record<string, SessionListRenderableSession> = activeRows;
            let needsSessionListIndexRebuild = Boolean(activeServerId) && (state.sessionListIndexByServerId?.[activeServerId] == null);
            const sessionListIndexSettings = resolveSessionListIndexRebuildSettings(state.settings);
            let needsProjectManagerUpdate = Object.keys(state.sessions).length === 0;
            let needsReachablePeerReevaluation = false;
            let didAnyImmediateWarmCacheRelevantRenderableChange = false;
            let didAnyDeferredWarmCacheRelevantRenderableChange = false;
            let changedSessionCount = 0;
            let changedRenderableCount = 0;
            const changedRenderableSessionIds = new Set<string>();
            let reconciledSessionMessageCount = 0;
            let listViewFieldChangeCount = 0;
            let didReachablePeerReevaluation = false;

            measureSessionApplyPhase(
                'sync.store.sessions.apply.merge',
                () => ({ sessions: sessions.length }),
                () => {
            // Runtime presence is an ephemeral device observation. Durable `active` state is
            // orthogonal and must not be promoted into online/offline reachability.
            sessions.forEach(incomingSession => {
                const retainedSession = state.sessions[incomingSession.id];
                const previousHome = normalizeTrimmedString(retainedSession?.serverId);
                const incomingHome = normalizeTrimmedString(incomingSession.serverId);
                // Version and runtime facts belong to one Home. A newly admitted
                // explicit foreign carrier cannot inherit the previous Home's shell.
                const previousSession = previousHome && incomingHome
                    && !areServerProfileIdentifiersEquivalent(previousHome, incomingHome)
                    ? undefined : retainedSession;
                const orderedSession = resolveOrderedSessionApply(previousSession, incomingSession);
                const declaredOwnerServerId = normalizeTrimmedString(orderedSession.serverId);
                const ownerServerId = resolveServerProfileScopeIdForIdentifier(declaredOwnerServerId ?? activeServerId);
                const ownerRowsKey = resolveSessionListHomeKey(mergedRowsByServerId, ownerServerId);
                const ownerRows = ownerRowsKey ? mergedRowsByServerId[ownerRowsKey] : {};
                const previousRenderable = ownerRows[incomingSession.id];
                const session = reconcileSessionLifecycleProjection(previousRenderable, orderedSession);
                // Use centralized resolver for consistent state management
                const presence = session.presence;

                // Preserve existing draft and permission mode if they exist, or load from saved data
                const hasLoadedSession = previousSession !== undefined;
                const savedPermissionMode = savedPermissionModes[session.id];
                const savedModelMode = savedModelModes[session.id];
                const savedPermissionModeUpdatedAt = savedPermissionModeUpdatedAts[session.id];
                const savedModelModeUpdatedAt = savedModelModeUpdatedAts[session.id];
                const existingOptimisticThinkingAt = previousSession?.optimisticThinkingAt ?? null;
                const existingResumingAt = previousSession?.resumingAt ?? null;
                const existingThinkingGraceUntil = previousSession?.thinkingGraceUntil ?? null;
                const runtimePresence = resolveSessionRuntimePresenceFields({
                    thinking: session.thinking,
                    thinkingAt: session.thinkingAt,
                    latestTurnStatus: session.latestTurnStatus,
                    latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
                });
                const wasThinking = previousSession
                    ? resolveSessionRuntimePresenceFields({
                        thinking: previousSession.thinking,
                        thinkingAt: previousSession.thinkingAt,
                        latestTurnStatus: previousSession.latestTurnStatus,
                        latestTurnStatusObservedAt: previousSession.latestTurnStatusObservedAt,
                    }).thinking
                    : false;
                const existingLastTurnCompletedAt = previousSession?.lastTurnCompletedAt ?? null;
                const hasTerminalPrimaryTurnProjection = hasTerminalPrimaryTurnStatus(session.latestTurnStatus);
                const incomingLastTurnCompletedAt = typeof session.lastTurnCompletedAt === 'number'
                    && Number.isFinite(session.lastTurnCompletedAt)
                    ? session.lastTurnCompletedAt
                    : null;
                const {
                    permissionMode: mergedPermissionMode,
                    permissionModeUpdatedAt: mergedPermissionModeUpdatedAt,
                    modelMode: mergedModelMode,
                    modelModeUpdatedAt: mergedModelModeUpdatedAt,
                } = resolveSessionInputModes({
                    session: { ...session, presence },
                    existing: previousSession,
                    saved: {
                        permissionMode: savedPermissionMode,
                        permissionModeUpdatedAt: savedPermissionModeUpdatedAt,
                        modelMode: savedModelMode,
                        modelModeUpdatedAt: savedModelModeUpdatedAt,
                    },
                    nowMs: nowServerMs(),
                });

                if (mergedModelMode !== previousSession?.modelMode) {
                    const reducerState = state.sessionMessages[session.id]?.reducerState;
                    if (reducerState) {
                        reconcileLatestUsageContextSnapshotModel(reducerState, mergedModelMode);
                    }
                }

                let mergedThinkingGraceUntil = existingThinkingGraceUntil;
                if (hasTerminalPrimaryTurnProjection) {
                    mergedThinkingGraceUntil = null;
                    optimisticThinkingTimeouts.cancel(session.id);
                    thinkingGraceTimeouts.cancel(session.id);
                } else if (presence !== 'online') {
                    mergedThinkingGraceUntil = null;
                    thinkingGraceTimeouts.cancel(session.id);
                } else if (runtimePresence.thinking === true) {
                    mergedThinkingGraceUntil = null;
                    thinkingGraceTimeouts.cancel(session.id);
                } else if (wasThinking) {
                    mergedThinkingGraceUntil = localNowMs + SESSION_THINKING_GRACE_TIMEOUT_MS;

                    const sessionId = session.id;
                    const expectedThinkingGraceUntil = mergedThinkingGraceUntil;
                    thinkingGraceTimeouts.schedule(sessionId, SESSION_THINKING_GRACE_TIMEOUT_MS, () => {
                        set((s) => {
                            const current = s.sessions[sessionId];
                            if (!current) return s;
                            if ((current.thinkingGraceUntil ?? null) !== expectedThinkingGraceUntil) return s;

                            const next = {
                                ...s.sessions,
                                [sessionId]: {
                                    ...current,
                                    thinkingGraceUntil: null,
                                },
                            };
                            return {
                                ...s,
                                sessions: next,
                            };
                        });
                    });
                } else if (typeof mergedThinkingGraceUntil === 'number' && mergedThinkingGraceUntil <= localNowMs) {
                    mergedThinkingGraceUntil = null;
                    thinkingGraceTimeouts.cancel(session.id);
                }

                const activityAdvanced =
                    (session.latestTurnStatusObservedAt ?? 0) > (previousSession?.latestTurnStatusObservedAt ?? 0)
                    || (session.meaningfulActivityAt ?? 0) > (previousSession?.meaningfulActivityAt ?? 0)
                    || (session.latestReadyEventAt ?? 0) > (previousSession?.latestReadyEventAt ?? 0);
                const preserveOptimisticWakeAcrossPassiveReconnect =
                    existingResumingAt !== null
                    && existingOptimisticThinkingAt !== null
                    && runtimePresence.thinking !== true
                    && !activityAdvanced;
                const mergedOptimisticThinkingAt = runtimePresence.thinking
                    || (hasTerminalPrimaryTurnProjection && !preserveOptimisticWakeAcrossPassiveReconnect)
                    ? null
                    : existingOptimisticThinkingAt;
                let mergedResumingAt = existingResumingAt;
                if (existingResumingAt !== null) {
                    const isLiveOwner = presence === 'online' && session.active === true;
                    const connectedIdleWithoutPendingWork =
                        isLiveOwner
                        && hasTerminalPrimaryTurnProjection
                        && mergedOptimisticThinkingAt === null;
                    if (
                        runtimePresence.thinking === true
                        || (isLiveOwner && activityAdvanced)
                        || connectedIdleWithoutPendingWork
                    ) {
                        mergedResumingAt = null;
                        resumingTimeouts.cancel(session.id);
                    }
                }

                const nextSession: Session = {
                    ...session,
                    // Turn facts travel through the shell Session to transcript consumers.
                    // Reuse equal hydration echoes so reference-based subscribers stay local.
                    sessionTurns: areSessionValuesDeepEqual(previousSession?.sessionTurns, session.sessionTurns)
                        ? previousSession?.sessionTurns
                        : session.sessionTurns,
                    metadata: (
                        session.metadataLayoutVersion === undefined
                        || session.metadataLayoutVersion === 0
                    )
                        ? preserveSessionRuntimeLocalMetadata(
                            previousSession?.metadata,
                            session.metadata,
                        )
                        : session.metadata,
                    lockedDisplayTitle: resolveLockedDisplayTitle(previousSession, session),
                    thinking: runtimePresence.thinking,
                    thinkingAt: runtimePresence.thinkingAt,
                    presence,
                    optimisticThinkingAt: mergedOptimisticThinkingAt,
                    resumingAt: mergedResumingAt,
                    thinkingGraceUntil: mergedThinkingGraceUntil,
                    lastTurnCompletedAt: incomingLastTurnCompletedAt ?? existingLastTurnCompletedAt,
                    permissionMode: mergedPermissionMode,
                    // Preserve local coordination timestamp (not synced to server)
                    permissionModeUpdatedAt: mergedPermissionModeUpdatedAt,
                    modelMode: mergedModelMode,
                    modelModeUpdatedAt: mergedModelModeUpdatedAt,
                };
                // Preserve the full response clock independently of merged compact-list lifecycle facts.
                const publicationAddress = normalizeSessionAddress(nextSession.serverId, nextSession.id);
                if (publicationAddress) {
                    sessionRuntimeObservations.recordFullPublication(publicationAddress, incomingSession.updatedAt, nextSession);
                }
                const mergedSession = previousSession && areStoredSessionsEqual(previousSession, nextSession)
                    ? previousSession
                    : reuseEqualSessionObjectFields(previousSession, nextSession);
                if (mergedSession !== previousSession) {
                    changedSessionCount += 1;
                    if (mergedSessions === state.sessions) {
                        mergedSessions = { ...state.sessions };
                    }
                    mergedSessions[session.id] = mergedSession;
                    projectAuthoringSessions = updateProjectAuthoringSessionInputs(projectAuthoringSessions, session.id, mergedSession);
                }

                const mergedTranscriptAggregate = readReusableRenderableAggregate(
                    state.sessionMessages[session.id],
                    mergedSessions[session.id]!,
                );
                const nextRenderableBase = buildSessionListRenderableFromSession(
                    mergedSessions[session.id]!,
                    previousRenderable,
                    mergedTranscriptAggregate
                        ? undefined
                        : readLoadedStoredSessionMessagesForRenderable(state.sessionMessages[session.id]),
                    mergedTranscriptAggregate,
                );
                const currentRenderable = preserveSessionListRenderableStaleFields(previousRenderable, nextRenderableBase);
                const nextRenderable = previousRenderable
                    ? preserveSessionListRenderableTransientState(previousRenderable, currentRenderable, {
                        preserveResumingAt: false,
                    })
                    : currentRenderable;
                const mergedRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderable)
                    ? previousRenderable
                    : nextRenderable;
                const renderableChangeImpact = resolveSessionListRenderableChangeImpact(previousRenderable, mergedRenderable, {
                    sessionListIndexSettings,
                });
                if (mergedRenderable !== previousRenderable) {
                    changedRenderableCount += 1;
                    changedRenderableSessionIds.add(session.id);
                    const isActiveOwner = Boolean(
                        activeServerId
                        && ownerServerId
                        && areServerProfileIdentifiersEquivalent(ownerServerId, activeServerId),
                    );
                    if (isActiveOwner && renderableChangeImpact.needsSessionListIndexRebuild) {
                        listViewFieldChangeCount += 1;
                    } else if (ownerServerId && renderableChangeImpact.needsSessionListIndexRebuild) {
                        inactiveOwnerServerIdsNeedingIndexRebuild.add(ownerServerId);
                    }
                    if (isActiveOwner && renderableChangeImpact.didWarmCacheRelevantRenderableChange) {
                        if (
                            !renderableChangeImpact.needsSessionListIndexRebuild
                            && renderableChangeImpact.isWarmCacheProgressOnlyChange
                        ) {
                            didAnyDeferredWarmCacheRelevantRenderableChange = true;
                        } else {
                            didAnyImmediateWarmCacheRelevantRenderableChange = true;
                        }
                    }
                    if (ownerServerId) {
                        const nextOwnerRows = { ...ownerRows, [session.id]: mergedRenderable };
                        mergedRowsByServerId = publishSessionListHomeValue(mergedRowsByServerId, ownerServerId, nextOwnerRows);
                        if (isActiveOwner) mergedRenderables = nextOwnerRows;
                        const ordinaryKey = resolveSessionListHomeKey(mergedOrdinaryMembershipByServerId, ownerServerId);
                        const archivedKey = resolveSessionListHomeKey(mergedArchivedMembershipByServerId, ownerServerId);
                        mergedOrdinaryMembershipByServerId = publishSessionListHomeValue(mergedOrdinaryMembershipByServerId,
                            ownerServerId, ordinaryKey ? mergedOrdinaryMembershipByServerId[ordinaryKey] : undefined);
                        mergedArchivedMembershipByServerId = publishSessionListHomeValue(mergedArchivedMembershipByServerId,
                            ownerServerId, archivedKey ? mergedArchivedMembershipByServerId[archivedKey] : undefined);
                        if (ownerRowsKey !== ownerServerId && ordinaryKey) {
                            if (isActiveOwner) needsSessionListIndexRebuild = true;
                            else inactiveOwnerServerIdsNeedingIndexRebuild.add(ownerServerId);
                        }
                        const didArchivalStateChange = (previousRenderable?.archivedAt ?? null)
                            !== (mergedRenderable.archivedAt ?? null);
                        if (didArchivalStateChange) {
                            const ordinaryMembership = mergedOrdinaryMembershipByServerId[ownerServerId] ?? [];
                            const archivedMembership = mergedArchivedMembershipByServerId[ownerServerId] ?? [];
                            if (mergedRenderable.archivedAt != null && ordinaryMembership.includes(session.id)) {
                                mergedOrdinaryMembershipByServerId = {
                                    ...mergedOrdinaryMembershipByServerId,
                                    [ownerServerId]: ordinaryMembership.filter((id) => id !== session.id),
                                };
                                mergedArchivedMembershipByServerId = {
                                    ...mergedArchivedMembershipByServerId,
                                    [ownerServerId]: [...new Set([...archivedMembership, session.id])],
                                };
                                if (isActiveOwner) {
                                    needsSessionListIndexRebuild = true;
                                    didAnyImmediateWarmCacheRelevantRenderableChange = true;
                                } else {
                                    inactiveOwnerServerIdsNeedingIndexRebuild.add(ownerServerId);
                                }
                            } else if (mergedRenderable.archivedAt == null && archivedMembership.includes(session.id)) {
                                mergedArchivedMembershipByServerId = {
                                    ...mergedArchivedMembershipByServerId,
                                    [ownerServerId]: archivedMembership.filter((id) => id !== session.id),
                                };
                                mergedOrdinaryMembershipByServerId = {
                                    ...mergedOrdinaryMembershipByServerId,
                                    [ownerServerId]: [...new Set([...ordinaryMembership, session.id])],
                                };
                                if (isActiveOwner) {
                                    needsSessionListIndexRebuild = true;
                                    didAnyImmediateWarmCacheRelevantRenderableChange = true;
                                } else {
                                    inactiveOwnerServerIdsNeedingIndexRebuild.add(ownerServerId);
                                }
                            }
                        }
                    }
                }

                if (
                    !needsSessionListIndexRebuild
                    && activeServerId
                    && ownerServerId
                    && areServerProfileIdentifiersEquivalent(ownerServerId, activeServerId)
                ) {
                    if (renderableChangeImpact.needsSessionListIndexRebuild) {
                        needsSessionListIndexRebuild = true;
                    }
                }

                if (!needsProjectManagerUpdate) {
                    if (renderableChangeImpact.needsProjectManagerUpdate) {
                        needsProjectManagerUpdate = true;
                    }
                }

                if (!needsReachablePeerReevaluation) {
                    if (renderableChangeImpact.needsReachablePeerReevaluation) {
                        needsReachablePeerReevaluation = true;
                    }
                }
            });
                },
            );

            if (needsReachablePeerReevaluation && (!needsSessionListIndexRebuild || !needsProjectManagerUpdate)) {
                measureSessionApplyPhase(
                    'sync.store.sessions.apply.reachablePeers',
                    () => ({ renderables: Object.keys(mergedRenderables).length }),
                    () => {
                        didReachablePeerReevaluation = true;
                        const previousReachableRenderables = activeRows;
                        const nextReachableRenderables = applyReachableTargetsToSessionListRenderables({
                            sessions: mergedRenderables,
                            sessionRecords: mergedSessions,
                            machineRecords: state.machines,
                            getProjectForSession: state.getProjectForSession,
                        });

                        for (const sessionId of new Set([
                            ...Object.keys(previousReachableRenderables),
                            ...Object.keys(nextReachableRenderables),
                        ])) {
                            const previousRenderable = previousReachableRenderables[sessionId];
                            const nextRenderable = nextReachableRenderables[sessionId];
                            if (!nextRenderable) continue;
                            const renderableChangeImpact = resolveSessionListRenderableChangeImpact(previousRenderable, nextRenderable, {
                                sessionListIndexSettings,
                            });
                            if (nextRenderable !== previousRenderable) {
                                changedRenderableCount += 1;
                                changedRenderableSessionIds.add(sessionId);
                                if (renderableChangeImpact.needsSessionListIndexRebuild) {
                                    listViewFieldChangeCount += 1;
                                }
                                if (renderableChangeImpact.didWarmCacheRelevantRenderableChange) {
                                    if (
                                        !renderableChangeImpact.needsSessionListIndexRebuild
                                        && renderableChangeImpact.isWarmCacheProgressOnlyChange
                                    ) {
                                        didAnyDeferredWarmCacheRelevantRenderableChange = true;
                                    } else {
                                        didAnyImmediateWarmCacheRelevantRenderableChange = true;
                                    }
                                }
                            }

                            if (
                                !needsSessionListIndexRebuild
                                && renderableChangeImpact.needsSessionListIndexRebuild
                            ) {
                                needsSessionListIndexRebuild = true;
                            }

                            if (
                                !needsProjectManagerUpdate
                                && renderableChangeImpact.needsProjectManagerUpdate
                            ) {
                                needsProjectManagerUpdate = true;
                            }

                            if (needsSessionListIndexRebuild && needsProjectManagerUpdate) {
                                break;
                            }
                        }
                        if (nextReachableRenderables !== mergedRenderables) {
                            mergedRenderables = nextReachableRenderables;
                        }
                    },
                );
            }

            // Process AgentState updates for sessions that already have messages loaded
            let updatedSessionMessages = state.sessionMessages;

            measureSessionApplyPhase(
                'sync.store.sessions.apply.messageReconcile',
                () => ({ sessions: sessions.length }),
                () => {
            sessions.forEach(session => {
                const newSession = mergedSessions[session.id];

                // Session message cache can outlive a page reload and keep locally synthesized
                // "Request interrupted" placeholders even when the backend request is still live.
                // Reconcile loaded transcript state from AgentState on every snapshot so the cache
                // stays aligned even when agentStateVersion is unchanged across reload.
                const existingSessionMessages = updatedSessionMessages[session.id];
                if (existingSessionMessages && newSession.agentState) {
                    const updated = applyAgentStateUpdateToSessionMessages({
                        existing: existingSessionMessages,
                        agentState: newSession.agentState,
                        mainHistoryStartLoaded: state.sessionMessagesHistoryStartLoaded?.[session.id] === true,
                    });
                    if (updated.sessionMessages !== existingSessionMessages) {
                        reconciledSessionMessageCount += 1;
                        if (updatedSessionMessages === state.sessionMessages) {
                            updatedSessionMessages = { ...state.sessionMessages };
                        }
                        updatedSessionMessages[session.id] = {
                            ...updated.sessionMessages,
                            isLoaded: existingSessionMessages.isLoaded,
                        };
                    }
                    // Guard usage/todos writes with value equality so snapshot
                    // reconciles do not churn the Session identity (and every
                    // useSession subscriber) with value-identical copies.
                    if (
                        updated.sessionLatestUsage !== undefined
                        && !areSessionValuesDeepEqual(mergedSessions[session.id]?.latestUsage ?? null, updated.sessionLatestUsage)
                    ) {
                        if (mergedSessions === state.sessions) {
                            mergedSessions = { ...state.sessions };
                        }
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            latestUsage: updated.sessionLatestUsage,
                        };
                    }
                    if (
                        updated.sessionTodos !== undefined
                        && mergedSessions[session.id]?.todos !== updated.sessionTodos
                        && !areSessionValuesDeepEqual(mergedSessions[session.id]?.todos ?? null, updated.sessionTodos)
                    ) {
                        if (mergedSessions === state.sessions) {
                            mergedSessions = { ...state.sessions };
                        }
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            todos: updated.sessionTodos,
                        };
                    }
                }
            });

            if (updatedSessionMessages !== state.sessionMessages) {
                sessions.forEach(session => {
                    const currentRenderable = mergedRenderables[session.id];
                    if (!currentRenderable) {
                        return;
                    }

                    const reconciledTranscriptAggregate = readReusableRenderableAggregate(
                        updatedSessionMessages[session.id],
                        mergedSessions[session.id]!,
                    );
                    const nextRenderableBase = buildSessionListRenderableFromSession(
                        mergedSessions[session.id]!,
                        currentRenderable,
                        reconciledTranscriptAggregate
                            ? undefined
                            : readLoadedStoredSessionMessagesForRenderable(updatedSessionMessages[session.id]),
                        reconciledTranscriptAggregate,
                    );
                    const nextRenderable = preserveSessionListRenderableTransientState(currentRenderable, nextRenderableBase, {
                        preserveResumingAt: false,
                    });
                    const mergedRenderable = areSessionListRenderablesEqual(currentRenderable, nextRenderable)
                        ? currentRenderable
                        : nextRenderable;
                    const renderableChangeImpact = resolveSessionListRenderableChangeImpact(currentRenderable, mergedRenderable, {
                        sessionListIndexSettings,
                    });

                    if (mergedRenderable !== currentRenderable) {
                        changedRenderableCount += 1;
                        changedRenderableSessionIds.add(session.id);
                        if (renderableChangeImpact.needsSessionListIndexRebuild) {
                            listViewFieldChangeCount += 1;
                        }
                        if (renderableChangeImpact.didWarmCacheRelevantRenderableChange) {
                            if (
                                !renderableChangeImpact.needsSessionListIndexRebuild
                                && renderableChangeImpact.isWarmCacheProgressOnlyChange
                            ) {
                                didAnyDeferredWarmCacheRelevantRenderableChange = true;
                            } else {
                                didAnyImmediateWarmCacheRelevantRenderableChange = true;
                            }
                        }
                        if (mergedRenderables === activeRows) {
                            mergedRenderables = { ...activeRows };
                        }
                        mergedRenderables[session.id] = mergedRenderable;
                    }

                    if (!needsSessionListIndexRebuild && renderableChangeImpact.needsSessionListIndexRebuild) {
                        needsSessionListIndexRebuild = true;
                    }

                    if (!needsProjectManagerUpdate && renderableChangeImpact.needsProjectManagerUpdate) {
                        needsProjectManagerUpdate = true;
                    }
                });
            }
                },
            );

            syncPerformanceTelemetry.count('sync.store.sessions.apply.merge.outcome', {
                sessions: sessions.length,
                changedSessions: changedSessionCount,
                changedRenderables: changedRenderableCount,
                reconciledSessionMessages: reconciledSessionMessageCount,
                indexRebuild: needsSessionListIndexRebuild ? 1 : 0,
                listViewFieldChanges: listViewFieldChangeCount,
                projectManagerUpdate: needsProjectManagerUpdate ? 1 : 0,
                reachablePeerReevaluation: needsReachablePeerReevaluation ? 1 : 0,
                warmCacheRelevant: (didAnyImmediateWarmCacheRelevantRenderableChange || didAnyDeferredWarmCacheRelevantRenderableChange) ? 1 : 0,
            });

            let mergedSessionListIndexByServerId = state.sessionListIndexByServerId;
            for (const serverId of inactiveOwnerServerIdsNeedingIndexRebuild) {
                const rows = mergedRowsByServerId[serverId] ?? {};
                const ordinaryRows = Object.fromEntries(
                    (mergedOrdinaryMembershipByServerId[serverId] ?? []).flatMap((sessionId) => {
                        const row = rows[sessionId];
                        return row ? [[sessionId, row] as const] : [];
                    }),
                );
                const previousIndexKey = resolveSessionListHomeKey(mergedSessionListIndexByServerId, serverId);
                const previousIndex = previousIndexKey ? mergedSessionListIndexByServerId[previousIndexKey] ?? null : null;
                const nextIndex = buildSessionListIndexWithServerScope({
                    sessions: ordinaryRows,
                    machines: resolveSessionListMachineDisplaysForServer(state, serverId),
                    activeGroupingV1: sessionListIndexSettings.activeGroupingV1,
                    inactiveGroupingV1: sessionListIndexSettings.inactiveGroupingV1,
                    sectionModeV1: sessionListIndexSettings.sectionModeV1,
                    previousIndex,
                    serverScope: {
                        serverId,
                        serverName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
                    },
                });
                if (nextIndex === previousIndex) continue;
                mergedSessionListIndexByServerId = publishSessionListHomeValue(mergedSessionListIndexByServerId, serverId, nextIndex);
            }

            const nextStateBase = {
                ...state,
                sessions: mergedSessions,
                projectAuthoringSessions,
                sessionListRowsByServerId: mergedRowsByServerId,
                ordinarySessionListMembershipByServerId: mergedOrdinaryMembershipByServerId,
                archivedSessionListMembershipByServerId: mergedArchivedMembershipByServerId,
                sessionListIndexByServerId: mergedSessionListIndexByServerId,
                sessionMessages: updatedSessionMessages,
            };

            const needsActiveProjectionRepair = !needsSessionListIndexRebuild
                && doesActiveSessionListProjectionNeedRepair(nextStateBase);
            if (needsActiveProjectionRepair) {
                needsSessionListIndexRebuild = true;
            }

            if (
                mergedSessions === state.sessions
                && mergedRowsByServerId === state.sessionListRowsByServerId
                && mergedSessionListIndexByServerId === state.sessionListIndexByServerId
                && updatedSessionMessages === state.sessionMessages
                && !needsSessionListIndexRebuild
                && !needsProjectManagerUpdate
            ) {
                syncPerformanceTelemetry.count('sync.store.sessions.apply.noop', {
                    sessions: sessions.length,
                });
                return state;
            }

            if (needsProjectManagerUpdate) {
                measureSessionApplyPhase(
                    'sync.store.sessions.apply.projectManager',
                    () => ({ sessions: Object.keys(mergedSessions).length }),
                    () => {
                        const machineMetadataMap = new Map<string, any>();
                        Object.values(state.machines).forEach(machine => {
                            if (machine.metadata) {
                                machineMetadataMap.set(machine.id, machine.metadata);
                            }
                        });
                        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                        projectManager.updateSessions(Object.values(mergedSessions), machineMetadataMap, activeServerId);
                    },
                );
            }

            syncPerformanceTelemetry.count('sync.store.sessions.apply.changed', {
                sessions: sessions.length,
                changedSessions: changedSessionCount,
                changedRenderables: changedRenderableCount,
                reconciledSessionMessages: reconciledSessionMessageCount,
                indexRebuild: needsSessionListIndexRebuild ? 1 : 0,
                listViewFieldChanges: listViewFieldChangeCount,
                projectManagerUpdate: needsProjectManagerUpdate ? 1 : 0,
                reachablePeerReevaluation: didReachablePeerReevaluation ? 1 : 0,
            });

            return finalizeSessionListIndexUpdate(
                state,
                nextStateBase,
                needsSessionListIndexRebuild,
                didAnyImmediateWarmCacheRelevantRenderableChange,
                didAnyDeferredWarmCacheRelevantRenderableChange,
                undefined,
                {
                    deferImmediateSaveWhenAlreadyWarm: true,
                    scheduleDeferredSave: scheduleWarmSessionCacheSave,
                    saveImmediately: saveWarmSessionCacheImmediately,
                },
                {
                    changedSessionIds: Array.from(changedRenderableSessionIds),
                    removedSessionIds: [],
                },
            );
            }),
        ),
        applyServerScopedSessionListRows: (serverIdRaw, sessions, options) => {
            // A paged reader advances only over its own accepted publications, never over
            // concurrent writes made by store subscribers while this publication completes.
            const publishedRows: Record<string, SessionListRenderableSession> | undefined = options.baseline ? {} : undefined;
            let publishedFullPublicationBaseline: Readonly<Record<string, number | undefined>> | undefined;
            set((state) => {
                const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw.trim());
                if (!serverId) return state;
                const previousRowsByServerId = state.sessionListRowsByServerId ?? {};
                const previousRowsKey = resolveSessionListHomeKey(previousRowsByServerId, serverId);
                const previousRows = previousRowsKey ? previousRowsByServerId[previousRowsKey] : {};
                const previousOrdinaryKey = resolveSessionListHomeKey(state.ordinarySessionListMembershipByServerId, serverId);
                const previousArchivedKey = resolveSessionListHomeKey(state.archivedSessionListMembershipByServerId, serverId);
                const previousIndexKey = resolveSessionListHomeKey(state.sessionListIndexByServerId, serverId);
                const previousIndex = previousIndexKey ? state.sessionListIndexByServerId[previousIndexKey] : undefined;
                const hasScopeAliases = [previousRowsByServerId, state.ordinarySessionListMembershipByServerId,
                    state.archivedSessionListMembershipByServerId, state.sessionListIndexByServerId].some(values =>
                    Object.keys(values).some(key => key !== serverId && areServerProfileIdentifiersEquivalent(key, serverId)));
                let nextRows = previousRows as Record<string, SessionListRenderableSession>;
                const changedSessionIds: string[] = [];
                const changedRows: Array<Readonly<{
                    previous: SessionListRenderableSession | undefined;
                    next: SessionListRenderableSession;
                }>> = [];
                let staleMetadataPreservedCount = 0;
                let stalePendingFlagsPreservedCount = 0;
                for (const incoming of sessions) {
                    if (options.baseline && didSessionListRowChangeSinceBaseline(serverId, incoming.id, previousRows, options.baseline)) continue;
                    const previous = nextRows[incoming.id];
                    const withStaleFields = preserveSessionListRenderableStaleFields(previous,
                        incoming.serverId === serverId ? incoming : { ...incoming, serverId });
                    let next = preserveSessionListRenderableTransientState(previous, withStaleFields);
                    if (didPreserveRenderableMetadata(previous, incoming, next)) staleMetadataPreservedCount += 1;
                    if (didPreserveRenderablePendingFlags(previous, incoming, next)) stalePendingFlagsPreservedCount += 1;
                    if (areSessionListRenderablesEqual(previous, next)) {
                        if (publishedRows && previous) publishedRows[incoming.id] = previous;
                        continue;
                    }
                    next = reuseEqualSessionObjectFields(previous, next);
                    if (publishedRows) publishedRows[incoming.id] = next;
                    if (nextRows === previousRows) nextRows = { ...previousRows };
                    nextRows[incoming.id] = next;
                    changedSessionIds.push(incoming.id);
                    changedRows.push({ previous, next });
                }
                if (publishedRows) {
                    // A retained heartbeat can advance this witness without changing the row.
                    // Capture it before set notifies subscribers, which may publish newer facts.
                    publishedFullPublicationBaseline = captureSessionFullPublicationBaseline(serverId, Object.keys(publishedRows));
                }

                const previousOrdinaryMembershipValue = previousOrdinaryKey ? state.ordinarySessionListMembershipByServerId[previousOrdinaryKey] : undefined;
                const previousOrdinaryMembership = previousOrdinaryMembershipValue ?? [];
                const previousArchivedMembershipValue = previousArchivedKey ? state.archivedSessionListMembershipByServerId[previousArchivedKey] : undefined;
                const previousArchivedMembership = previousArchivedMembershipValue ?? [];
                const incomingOrdinaryIds = sessions
                    .filter((session) => session.archivedAt == null)
                    .map((session) => session.id);
                const incomingArchivedIds = sessions
                    .filter((session) => session.archivedAt != null)
                    .map((session) => session.id);
                let nextOrdinaryMembership = previousOrdinaryMembership;
                let nextArchivedMembership = previousArchivedMembership;
                if (options.source === 'archived') {
                    const candidateArchivedMembership = options.mode === 'replace'
                        ? incomingArchivedIds
                        : [...new Set([...previousArchivedMembership, ...incomingArchivedIds])];
                    nextArchivedMembership = previousArchivedMembershipValue !== undefined
                        && areStringArraysEqual(previousArchivedMembership, candidateArchivedMembership)
                        ? previousArchivedMembership
                        : candidateArchivedMembership;
                    const incomingArchivedSet = new Set(incomingArchivedIds);
                    const candidateOrdinaryMembership = previousOrdinaryMembership.filter(
                        (sessionId) => !incomingArchivedSet.has(sessionId),
                    );
                    nextOrdinaryMembership = areStringArraysEqual(previousOrdinaryMembership, candidateOrdinaryMembership)
                        ? previousOrdinaryMembership
                        : candidateOrdinaryMembership;
                } else if (options.source === 'ordinary') {
                    const candidateOrdinaryMembership = options.mode === 'replace'
                        ? incomingOrdinaryIds
                        : [...new Set([...previousOrdinaryMembership, ...incomingOrdinaryIds])];
                    nextOrdinaryMembership = previousOrdinaryMembershipValue !== undefined
                        && areStringArraysEqual(previousOrdinaryMembership, candidateOrdinaryMembership)
                        ? previousOrdinaryMembership
                        : candidateOrdinaryMembership;
                    const incomingOrdinarySet = new Set(incomingOrdinaryIds);
                    const candidateArchivedMembership = previousArchivedMembership.filter(
                        (sessionId) => !incomingOrdinarySet.has(sessionId),
                    );
                    nextArchivedMembership = areStringArraysEqual(previousArchivedMembership, candidateArchivedMembership)
                        ? previousArchivedMembership
                        : candidateArchivedMembership;
                }

                const previousOrdinaryMembershipSet = new Set(previousOrdinaryMembership);
                const nextOrdinaryMembershipSet = new Set(nextOrdinaryMembership);
                const addedOrdinarySessionIds = nextOrdinaryMembership.filter(
                    (sessionId) => !previousOrdinaryMembershipSet.has(sessionId),
                );
                const removedOrdinarySessionIds = previousOrdinaryMembership.filter(
                    (sessionId) => !nextOrdinaryMembershipSet.has(sessionId),
                );
                const publishedChangedSessionIds = [...new Set([
                    ...changedSessionIds,
                    ...addedOrdinarySessionIds,
                ])];
                const settings = resolveSessionListIndexRebuildSettings(state.settings);
                let listViewFieldChangeCount = addedOrdinarySessionIds.length + removedOrdinarySessionIds.length;
                let didAnyImmediateWarmCacheRelevantRenderableChange = addedOrdinarySessionIds.length > 0
                    || removedOrdinarySessionIds.length > 0;
                let didAnyDeferredWarmCacheRelevantRenderableChange = false;
                let needsOrdinaryIndexRebuild = nextOrdinaryMembership !== previousOrdinaryMembership
                    || (previousIndex != null && previousIndexKey !== serverId);
                for (const { previous, next } of changedRows) {
                    if (!previousOrdinaryMembershipSet.has(next.id) && !nextOrdinaryMembershipSet.has(next.id)) continue;
                    const impact = resolveSessionListRenderableChangeImpact(previous, next, {
                        sessionListIndexSettings: settings,
                    });
                    if (impact.needsSessionListIndexRebuild) {
                        needsOrdinaryIndexRebuild = true;
                        listViewFieldChangeCount += 1;
                    }
                    if (impact.didWarmCacheRelevantRenderableChange) {
                        if (!impact.needsSessionListIndexRebuild && impact.isWarmCacheProgressOnlyChange) {
                            didAnyDeferredWarmCacheRelevantRenderableChange = true;
                        } else {
                            didAnyImmediateWarmCacheRelevantRenderableChange = true;
                        }
                    }
                }
                if (
                    state.sessionListIndexByServerId[serverId] == null
                    // An ad-hoc row-only read owns no corpus, so it must not bootstrap the ordinary
                    // index either: a Voice or Action command would otherwise publish a list the
                    // mounted pagination owner has not established (Lane 07.2 §6, L07-I35).
                    && options.source !== 'rowOnly'
                    && (options.source === 'ordinary' || nextOrdinaryMembership.length > 0)
                ) {
                    needsOrdinaryIndexRebuild = true;
                }

                const eventKind = options.source === 'query'
                    ? 'query'
                    : options.mode === 'replace' ? 'replace' : 'merge';
                const eventName = `sync.store.sessions.renderables.${eventKind}`;
                const didMembershipChange = nextOrdinaryMembership !== previousOrdinaryMembership
                    || nextArchivedMembership !== previousArchivedMembership;
                if (nextRows === previousRows && !didMembershipChange && !needsOrdinaryIndexRebuild && !hasScopeAliases) {
                    syncPerformanceTelemetry.count(eventName, {
                        incoming: sessions.length,
                        previous: Object.keys(previousRows).length,
                        changed: 0,
                        removed: 0,
                        noop: 1,
                        indexRebuild: 0,
                        listRebuild: 0,
                        projectionRepair: 0,
                        listViewFieldChanges: 0,
                        staleMetadataPreserved: staleMetadataPreservedCount,
                        stalePendingFlagsPreserved: stalePendingFlagsPreservedCount,
                        warmCacheRelevant: 0,
                    });
                    return state;
                }

                const buildOrdinaryIndex = () => {
                    const ordinaryRows: Record<string, SessionListRenderableSession> = {};
                    for (const sessionId of nextOrdinaryMembership) {
                        const row = nextRows[sessionId];
                        if (row) ordinaryRows[sessionId] = row;
                    }
                    return buildSessionListIndexWithServerScope({
                        sessions: ordinaryRows,
                        machines: resolveSessionListMachineDisplaysForServer(state, serverId),
                        activeGroupingV1: settings.activeGroupingV1,
                        inactiveGroupingV1: settings.inactiveGroupingV1,
                        sectionModeV1: settings.sectionModeV1,
                        previousIndex: previousIndex ?? null,
                        serverScope: {
                            serverId,
                            serverName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
                        },
                    });
                };
                const nextRowsByServerId = publishSessionListHomeValue(previousRowsByServerId, serverId, nextRows);
                const nextIndex = needsOrdinaryIndexRebuild
                    ? measureSessionApplyPhase(
                        `${eventName}.indexRebuild`,
                        () => ({
                            renderables: nextOrdinaryMembership.length,
                            incoming: sessions.length,
                            changed: changedSessionIds.length,
                            removed: removedOrdinarySessionIds.length,
                            listViewFieldChanges: listViewFieldChangeCount,
                        }),
                        buildOrdinaryIndex,
                    )
                    : previousIndex;
                const nextStateBase = {
                    ...state,
                    sessionListRowsByServerId: nextRowsByServerId,
                    ordinarySessionListMembershipByServerId: publishSessionListHomeValue(
                        state.ordinarySessionListMembershipByServerId, serverId,
                        previousOrdinaryMembershipValue !== undefined || nextOrdinaryMembership !== previousOrdinaryMembership
                            ? nextOrdinaryMembership : undefined,
                    ),
                    archivedSessionListMembershipByServerId: publishSessionListHomeValue(
                        state.archivedSessionListMembershipByServerId, serverId,
                        previousArchivedMembershipValue !== undefined || nextArchivedMembership !== previousArchivedMembership
                            ? nextArchivedMembership : undefined,
                    ),
                    sessionListIndexByServerId: publishSessionListHomeValue(state.sessionListIndexByServerId, serverId, nextIndex),
                };

                syncPerformanceTelemetry.count(eventName, {
                    incoming: sessions.length,
                    previous: Object.keys(previousRows).length,
                    changed: changedSessionIds.length,
                    removed: removedOrdinarySessionIds.length,
                    noop: 0,
                    indexRebuild: needsOrdinaryIndexRebuild ? 1 : 0,
                    listRebuild: needsOrdinaryIndexRebuild ? 1 : 0,
                    projectionRepair: 0,
                    listViewFieldChanges: listViewFieldChangeCount,
                    staleMetadataPreserved: staleMetadataPreservedCount,
                    stalePendingFlagsPreserved: stalePendingFlagsPreservedCount,
                    warmCacheRelevant: (didAnyImmediateWarmCacheRelevantRenderableChange || didAnyDeferredWarmCacheRelevantRenderableChange) ? 1 : 0,
                });

                const isActiveServer = Boolean(activeServerId) && serverId === activeServerId;
                const shouldPublishDelta = publishedChangedSessionIds.length > 0
                    || removedOrdinarySessionIds.length > 0
                    || needsOrdinaryIndexRebuild;
                return finalizeSessionListRenderablePublication(
                    state,
                    nextStateBase,
                    needsOrdinaryIndexRebuild,
                    isActiveServer && didAnyImmediateWarmCacheRelevantRenderableChange,
                    isActiveServer && didAnyDeferredWarmCacheRelevantRenderableChange,
                    {
                        warmCacheEventName: `${eventName}.warmCache`,
                        fields: () => ({
                            incoming: sessions.length,
                            changed: changedSessionIds.length,
                            removed: removedOrdinarySessionIds.length,
                            listViewFieldChanges: listViewFieldChangeCount,
                        }),
                    },
                    {
                        saveImmediately: saveWarmSessionCacheImmediately,
                        scheduleDeferredSave: scheduleWarmSessionCacheSave,
                    },
                    shouldPublishDelta ? {
                        changedSessionIds: publishedChangedSessionIds,
                        removedSessionIds: removedOrdinarySessionIds,
                    } : undefined,
                );
            });
            return publishedRows && publishedFullPublicationBaseline
                ? { rows: publishedRows, fullPublicationBaseline: publishedFullPublicationBaseline }
                : undefined;
        },
        applyServerScopedSessionListRowPatches: (serverIdRaw, patches) => set((state) => {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            const trimmedServerId = serverIdRaw.trim();
            // A pending request may have captured the profile's pre-discovery id.
            // Patch the existing equivalent corpus and its membership together.
            const serverId = resolveSessionListHomeKey(state.sessionListRowsByServerId, trimmedServerId)
                ?? (activeServerId && areServerProfileIdentifiersEquivalent(trimmedServerId, activeServerId)
                    ? activeServerId : trimmedServerId);
            if (!serverId || patches.length === 0) return state;
            const previousRowsByServerId = state.sessionListRowsByServerId ?? {};
            const previousRows = previousRowsByServerId[serverId] ?? {};
            const ordinaryMembership = state.ordinarySessionListMembershipByServerId?.[serverId] ?? [];
            const archivedMembership = state.archivedSessionListMembershipByServerId?.[serverId] ?? [];
            const ordinaryMembershipSet = new Set(ordinaryMembership);
            const archivedMembershipSet = new Set(archivedMembership);
            let nextOrdinaryMembership = ordinaryMembership;
            let nextArchivedMembership = archivedMembership;
            let didArchivalMembershipChange = false;
            const settings = resolveSessionListIndexRebuildSettings(state.settings);
            let needsOrdinaryIndexRebuild = state.sessionListIndexByServerId[serverId] == null
                && ordinaryMembership.length > 0;
            let nextRows = previousRows as Record<string, SessionListRenderableSession>;
            let didAnyWarmCacheRelevantRenderableChange = false;
            let changedCount = 0;
            const changedSessionIds: string[] = [];
            const touchedSessionIds = new Set<string>();
            let missingCount = 0;
            let noopPatchCount = 0;
            let listViewFieldChangeCount = 0;
            for (const { sessionId, patch: operation } of patches) {
                const previous = nextRows[sessionId];
                if (!previous) {
                    missingCount += 1;
                    continue;
                }
                const patch = typeof operation === 'function' ? operation(previous) : operation;
                if (patch === null) continue;
                let next = applySessionListRenderablePatch(
                    previous,
                    patch,
                );
                if (next.serverId !== serverId) next = { ...next, serverId };
                if (areSessionListRenderablesEqual(previous, next)) {
                    noopPatchCount += 1;
                    continue;
                }
                next = reuseEqualSessionObjectFields(previous, next);
                if (nextRows === previousRows) nextRows = { ...previousRows };
                nextRows[sessionId] = next;
                touchedSessionIds.add(sessionId);
            }
            // Projectors see each preceding admitted row, but only their final
            // state owns publication, membership, index and persistence impact.
            for (const sessionId of touchedSessionIds) {
                const previous = previousRows[sessionId];
                let next = nextRows[sessionId];
                if (areSessionListRenderablesEqual(previous, next)) {
                    nextRows[sessionId] = previous;
                    continue;
                }
                next = reuseEqualSessionObjectFields(previous, next);
                nextRows[sessionId] = next;
                changedCount += 1;
                changedSessionIds.push(sessionId);
                const didArchivalStateChange = (previous.archivedAt ?? null) !== (next.archivedAt ?? null);
                if (didArchivalStateChange && next.archivedAt != null && ordinaryMembershipSet.delete(sessionId)) {
                    archivedMembershipSet.add(sessionId);
                    didArchivalMembershipChange = true;
                    needsOrdinaryIndexRebuild = true;
                    didAnyWarmCacheRelevantRenderableChange = true;
                } else if (didArchivalStateChange && next.archivedAt == null && archivedMembershipSet.delete(sessionId)) {
                    ordinaryMembershipSet.add(sessionId);
                    didArchivalMembershipChange = true;
                    needsOrdinaryIndexRebuild = true;
                    didAnyWarmCacheRelevantRenderableChange = true;
                }
                if (ordinaryMembershipSet.has(sessionId)) {
                    const impact = resolveSessionListRenderableChangeImpact(previous, next, {
                        sessionListIndexSettings: settings,
                    });
                    if (impact.needsSessionListIndexRebuild) {
                        needsOrdinaryIndexRebuild = true;
                        listViewFieldChangeCount += 1;
                    }
                    if (impact.didWarmCacheRelevantRenderableChange) {
                        didAnyWarmCacheRelevantRenderableChange = true;
                    }
                }
            }
            if (changedCount === 0) nextRows = previousRows;
            if (didArchivalMembershipChange) {
                nextOrdinaryMembership = [
                    ...ordinaryMembership.filter((id) => ordinaryMembershipSet.has(id)),
                    ...Array.from(ordinaryMembershipSet).filter((id) => !ordinaryMembership.includes(id)),
                ];
                nextArchivedMembership = [
                    ...archivedMembership.filter((id) => archivedMembershipSet.has(id)),
                    ...Array.from(archivedMembershipSet).filter((id) => !archivedMembership.includes(id)),
                ];
            }
            syncPerformanceTelemetry.count('sync.store.sessions.renderables.patch', {
                patches: patches.length,
                changed: changedCount,
                noopPatches: noopPatchCount,
                missing: missingCount,
                listRebuild: needsOrdinaryIndexRebuild ? 1 : 0,
                listViewFieldChanges: listViewFieldChangeCount,
                warmCacheRelevant: didAnyWarmCacheRelevantRenderableChange ? 1 : 0,
            });
            if (nextRows === previousRows && !needsOrdinaryIndexRebuild) return state;
            const nextRowsByServerId = {
                ...previousRowsByServerId,
                [serverId]: nextRows,
            };
            const nextIndex = needsOrdinaryIndexRebuild
                ? measureSessionApplyPhase(
                    'sync.store.sessions.renderables.patch.indexRebuild',
                    () => ({
                        renderables: nextOrdinaryMembership.length,
                        patches: patches.length,
                        changed: changedCount,
                        missing: missingCount,
                        listViewFieldChanges: listViewFieldChangeCount,
                    }),
                    () => buildSessionListIndexWithServerScope({
                        sessions: Object.fromEntries(nextOrdinaryMembership.flatMap((sessionId) => {
                            const row = nextRows[sessionId];
                            return row ? [[sessionId, row] as const] : [];
                        })),
                        machines: resolveSessionListMachineDisplaysForServer(state, serverId),
                        activeGroupingV1: settings.activeGroupingV1,
                        inactiveGroupingV1: settings.inactiveGroupingV1,
                        sectionModeV1: settings.sectionModeV1,
                        previousIndex: state.sessionListIndexByServerId[serverId] ?? null,
                        serverScope: {
                            serverId,
                            serverName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
                        },
                    }),
                )
                : state.sessionListIndexByServerId[serverId];
            const nextStateBase = {
                ...state,
                sessionListRowsByServerId: nextRowsByServerId,
                ...(nextOrdinaryMembership !== ordinaryMembership ? {
                    ordinarySessionListMembershipByServerId: {
                        ...state.ordinarySessionListMembershipByServerId,
                        [serverId]: nextOrdinaryMembership,
                    },
                } : {}),
                ...(nextArchivedMembership !== archivedMembership ? {
                    archivedSessionListMembershipByServerId: {
                        ...state.archivedSessionListMembershipByServerId,
                        [serverId]: nextArchivedMembership,
                    },
                } : {}),
                ...(needsOrdinaryIndexRebuild ? {
                    sessionListIndexByServerId: {
                        ...state.sessionListIndexByServerId,
                        [serverId]: nextIndex,
                    },
                } : {}),
            };
            const isActiveServer = Boolean(activeServerId) && serverId === activeServerId;
            return finalizeSessionListRenderablePublication(
                state,
                nextStateBase,
                needsOrdinaryIndexRebuild,
                false,
                isActiveServer && didAnyWarmCacheRelevantRenderableChange,
                {
                    warmCacheEventName: 'sync.store.sessions.renderables.patch.warmCache',
                    fields: () => ({
                        patches: patches.length,
                        changed: changedCount,
                        missing: missingCount,
                        listViewFieldChanges: listViewFieldChangeCount,
                    }),
                },
                {
                    saveImmediately: saveWarmSessionCacheImmediately,
                    scheduleDeferredSave: scheduleWarmSessionCacheSave,
                },
                changedSessionIds.length > 0 || needsOrdinaryIndexRebuild ? {
                    changedSessionIds,
                    removedSessionIds: [],
                } : undefined,
            );
        }),
        reconcileSessionListRowsForServerScope: (serverIdRaw, sessions, baseline, fullPublicationBaseline) => set((state) => {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw.trim());
            if (!serverId) return state;
            const previousRowsByServerId = state.sessionListRowsByServerId;
            const previousRowsKey = resolveSessionListHomeKey(previousRowsByServerId, serverId);
            const previousRows = previousRowsKey ? previousRowsByServerId[previousRowsKey] : {};
            const previousMembershipKey = resolveSessionListHomeKey(state.ordinarySessionListMembershipByServerId, serverId);
            const previousIndexKey = resolveSessionListHomeKey(state.sessionListIndexByServerId, serverId);
            const archivedKey = resolveSessionListHomeKey(state.archivedSessionListMembershipByServerId, serverId);
            const previousMembership = previousMembershipKey ? state.ordinarySessionListMembershipByServerId[previousMembershipKey] ?? [] : [];
            const previousOrdinaryMembership = new Set(previousMembership);
            let changedRows: Record<string, SessionListRenderableSession> | null = null;
            const incomingById = new Map(sessions.map((session) => [session.id, session]));
            const publicationBaseline = { rows: baseline, fullPublicationBaseline };
            const changedSinceBaseline = (sessionId: string) => didSessionListRowChangeSinceBaseline(
                serverId, sessionId, previousRows, publicationBaseline,
            );
            const sessionIds = new Set([
                ...Object.keys(previousRows),
                ...Object.keys(baseline),
                ...incomingById.keys(),
            ]);
            for (const sessionId of sessionIds) {
                const previous = previousRows[sessionId];
                // Active Sync and exact-session hydration publish immutable row
                // objects. A retained full heartbeat records its observation
                // separately; either signal fences the older paged snapshot.
                if (changedSinceBaseline(sessionId)) {
                    continue;
                }
                const incoming = incomingById.get(sessionId);
                if (!incoming) {
                    if (previous && previousOrdinaryMembership.has(sessionId)) {
                        changedRows ??= { ...previousRows };
                        delete changedRows[sessionId];
                    }
                    continue;
                }
                const withStaleFields = preserveSessionListRenderableStaleFields(previous,
                    incoming.serverId === serverId ? incoming : { ...incoming, serverId });
                const next = preserveSessionListRenderableTransientState(previous, withStaleFields);
                const reconciled = previous && areSessionListRenderablesEqual(previous, next)
                    ? previous
                    : reuseEqualSessionObjectFields(previous, next);
                if (reconciled !== previous) {
                    changedRows ??= { ...previousRows };
                    changedRows[sessionId] = reconciled;
                }
            }
            const nextRows = changedRows ?? previousRows;
            const incomingMembership = sessions.map((session) => session.id).filter((sessionId) => nextRows[sessionId] !== undefined);
            const incomingMembershipSet = new Set(incomingMembership);
            const candidateMembership = [
                ...incomingMembership,
                ...previousMembership.filter((sessionId) => (
                    !incomingMembershipSet.has(sessionId)
                    && changedSinceBaseline(sessionId)
                    && nextRows[sessionId] != null
                )),
            ];
            const nextMembership = areStringArraysEqual(previousMembership, candidateMembership)
                ? previousMembership : candidateMembership;
            const ordinaryRows = Object.fromEntries(
                nextMembership.flatMap((sessionId) => {
                    const row = nextRows[sessionId];
                    return row ? [[sessionId, row] as const] : [];
                }),
            );
            const settings = resolveSessionListIndexRebuildSettings(state.settings);
            const nextIndex = buildSessionListIndexWithServerScope({
                sessions: ordinaryRows,
                machines: resolveSessionListMachineDisplaysForServer(state, serverId),
                activeGroupingV1: settings.activeGroupingV1,
                inactiveGroupingV1: settings.inactiveGroupingV1,
                sectionModeV1: settings.sectionModeV1,
                previousIndex: previousIndexKey ? state.sessionListIndexByServerId[previousIndexKey] ?? null : null,
                serverScope: {
                    serverId,
                    serverName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
                },
            });
            const nextRowsByServerId = publishSessionListHomeValue(previousRowsByServerId, serverId, nextRows);
            const nextMembershipSet = new Set(nextMembership);
            const changedSessionIds = nextMembership.filter((sessionId) => (
                !previousOrdinaryMembership.has(sessionId)
                || !areSessionListRenderablesEqual(previousRows[sessionId], nextRows[sessionId])
            ));
            const removedSessionIds = previousMembership.filter((sessionId) => !nextMembershipSet.has(sessionId));
            const didOrdinaryProjectionChange = changedSessionIds.length > 0 || removedSessionIds.length > 0;
            const nextStateBase = {
                ...state,
                sessionListRowsByServerId: nextRowsByServerId,
                ordinarySessionListMembershipByServerId: publishSessionListHomeValue(state.ordinarySessionListMembershipByServerId, serverId, nextMembership),
                archivedSessionListMembershipByServerId: publishSessionListHomeValue(state.archivedSessionListMembershipByServerId,
                    serverId, archivedKey ? state.archivedSessionListMembershipByServerId[archivedKey] : undefined),
                sessionListIndexByServerId: publishSessionListHomeValue(state.sessionListIndexByServerId, serverId, nextIndex),
            };
            if (nextStateBase.sessionListRowsByServerId === state.sessionListRowsByServerId
                && nextStateBase.ordinarySessionListMembershipByServerId === state.ordinarySessionListMembershipByServerId
                && nextStateBase.archivedSessionListMembershipByServerId === state.archivedSessionListMembershipByServerId
                && nextStateBase.sessionListIndexByServerId === state.sessionListIndexByServerId) return state;
            return finalizeSessionListRenderablePublication(
                state,
                nextStateBase,
                nextIndex !== state.sessionListIndexByServerId[serverId],
                serverId === activeServerId && didOrdinaryProjectionChange,
                false,
                { warmCacheEventName: 'sync.store.sessions.renderables.reconcile.warmCache' },
                {
                    saveImmediately: saveWarmSessionCacheImmediately,
                    scheduleDeferredSave: scheduleWarmSessionCacheSave,
                },
                didOrdinaryProjectionChange ? { changedSessionIds, removedSessionIds } : undefined,
            );
        }),
        mergeSessionListRowsForServerScope: (serverIdRaw, sessions) => set((state) => {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw.trim());
            if (!serverId || sessions.length === 0) return state;
            const previousRowsByServerId = state.sessionListRowsByServerId;
            const previousRowsKey = resolveSessionListHomeKey(previousRowsByServerId, serverId);
            const previousRows = previousRowsKey ? previousRowsByServerId[previousRowsKey] : {};
            const previousMembershipKey = resolveSessionListHomeKey(state.ordinarySessionListMembershipByServerId, serverId);
            const previousIndexKey = resolveSessionListHomeKey(state.sessionListIndexByServerId, serverId);
            const archivedKey = resolveSessionListHomeKey(state.archivedSessionListMembershipByServerId, serverId);
            let changedRows: Record<string, SessionListRenderableSession> | null = null;
            for (const incoming of sessions) {
                const previous = (changedRows ?? previousRows)[incoming.id];
                const withStaleFields = preserveSessionListRenderableStaleFields(previous,
                    incoming.serverId === serverId ? incoming : { ...incoming, serverId });
                const next = preserveSessionListRenderableTransientState(previous, withStaleFields);
                const reconciled = previous && areSessionListRenderablesEqual(previous, next)
                    ? previous
                    : reuseEqualSessionObjectFields(previous, next);
                if (reconciled !== previous) {
                    changedRows ??= { ...previousRows };
                    changedRows[incoming.id] = reconciled;
                }
            }
            const nextRows = changedRows ?? previousRows;
            const previousMembership = previousMembershipKey ? state.ordinarySessionListMembershipByServerId[previousMembershipKey] ?? [] : [];
            const previousMembershipSet = new Set(previousMembership);
            const candidateMembership = [...new Set([
                ...previousMembership,
                ...sessions.map((session) => session.id),
            ])];
            const nextMembership = areStringArraysEqual(previousMembership, candidateMembership)
                ? previousMembership : candidateMembership;
            const ordinaryRows = Object.fromEntries(
                nextMembership.flatMap((sessionId) => {
                    const row = nextRows[sessionId];
                    return row ? [[sessionId, row] as const] : [];
                }),
            );
            const settings = resolveSessionListIndexRebuildSettings(state.settings);
            const nextIndex = buildSessionListIndexWithServerScope({
                sessions: ordinaryRows,
                machines: resolveSessionListMachineDisplaysForServer(state, serverId),
                activeGroupingV1: settings.activeGroupingV1,
                inactiveGroupingV1: settings.inactiveGroupingV1,
                sectionModeV1: settings.sectionModeV1,
                previousIndex: previousIndexKey ? state.sessionListIndexByServerId[previousIndexKey] ?? null : null,
                serverScope: {
                    serverId,
                    serverName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
                },
            });
            const nextRowsByServerId = publishSessionListHomeValue(previousRowsByServerId, serverId, nextRows);
            const changedSessionIds = sessions.flatMap((session) => (
                !previousMembershipSet.has(session.id)
                || !areSessionListRenderablesEqual(previousRows[session.id], nextRows[session.id])
                    ? [session.id]
                    : []
            ));
            const didOrdinaryProjectionChange = changedSessionIds.length > 0;
            const nextStateBase = {
                ...state,
                sessionListRowsByServerId: nextRowsByServerId,
                ordinarySessionListMembershipByServerId: publishSessionListHomeValue(state.ordinarySessionListMembershipByServerId, serverId, nextMembership),
                archivedSessionListMembershipByServerId: publishSessionListHomeValue(state.archivedSessionListMembershipByServerId,
                    serverId, archivedKey ? state.archivedSessionListMembershipByServerId[archivedKey] : undefined),
                sessionListIndexByServerId: publishSessionListHomeValue(state.sessionListIndexByServerId, serverId, nextIndex),
            };
            if (nextStateBase.sessionListRowsByServerId === state.sessionListRowsByServerId
                && nextStateBase.ordinarySessionListMembershipByServerId === state.ordinarySessionListMembershipByServerId
                && nextStateBase.archivedSessionListMembershipByServerId === state.archivedSessionListMembershipByServerId
                && nextStateBase.sessionListIndexByServerId === state.sessionListIndexByServerId) return state;
            return finalizeSessionListRenderablePublication(
                state,
                nextStateBase,
                nextIndex !== state.sessionListIndexByServerId[serverId],
                serverId === activeServerId && didOrdinaryProjectionChange,
                false,
                { warmCacheEventName: 'sync.store.sessions.renderables.scopedMerge.warmCache' },
                {
                    saveImmediately: saveWarmSessionCacheImmediately,
                    scheduleDeferredSave: scheduleWarmSessionCacheSave,
                },
                didOrdinaryProjectionChange ? { changedSessionIds, removedSessionIds: [] } : undefined,
            );
        }),
        clearSessionListRowsForServerScope: (serverIdRaw) => {
            const previousQueryMemberships = get().sessionListQueryMembershipByKey;
            clearServerScopedSessionListRows(serverIdRaw);
            const nextQueryMemberships = get().sessionListQueryMembershipByKey;
            saveSessionListQueryMembershipWarmCacheForChange(
                nextQueryMemberships,
                listChangedSessionListQueryMemberships(previousQueryMemberships, nextQueryMemberships),
            );
        },
        commitSessionListQueryMembership: (queryKey, membership) => {
            const previousQueryMemberships = get().sessionListQueryMembershipByKey;
            applySessionListQueryMembershipCommit(queryKey, membership);
            const nextQueryMemberships = get().sessionListQueryMembershipByKey;
            saveSessionListQueryMembershipWarmCacheForChange(
                nextQueryMemberships,
                listChangedSessionListQueryMemberships(previousQueryMemberships, nextQueryMemberships),
            );
        },
        restoreSessionListQueryMemberships: (serverIdRaw, accountIdRaw) => set((state) => {
            const serverId = serverIdRaw.trim();
            const accountId = accountIdRaw.trim();
            if (!serverId || !accountId) return state;
            let next: Record<string, SessionListQueryMembership | undefined> | null = null;
            const persisted = loadSessionListQueryMembershipWarmCacheEntries(serverId, accountId);
            for (const [queryKey, entry] of Object.entries(persisted)) {
                if (state.sessionListQueryMembershipByKey[queryKey]) continue;
                if (!areServerProfileIdentifiersEquivalent(entry.serverId, serverId)) continue;
                next ??= { ...state.sessionListQueryMembershipByKey };
                next[queryKey] = { serverId: entry.serverId, accountId, sessionIds: entry.sessionIds, lastKnown: true };
            }
            return next ? { ...state, sessionListQueryMembershipByKey: next } : state;
        }),
        applyReady: () => set((state) => state.isDataReady ? state : ({
            ...state,
            isDataReady: true
        })),
        applyScmStatus: (sessionId: string, status: ScmStatus | null) => set((state) => {
            // Update project git status as well
            const projectChanged = projectManager.updateSessionProjectScmStatus(sessionId, status);
            if (areSessionValuesDeepEqual(state.sessionScmStatus[sessionId], status)) {
                return projectChanged ? { ...state } : state;
            }

            return {
                ...state,
                sessionScmStatus: {
                    ...state.sessionScmStatus,
                    [sessionId]: status
                }
            };
        }),
        upsertSessionReviewCommentDraft: (sessionId: string, draft: ReviewCommentDraft) => set((state) => {
            const existing = state.reviewCommentsDraftsBySessionId[sessionId] ?? [];
            const previous = existing.find((d) => d.id === draft.id);
            if (previous && areSessionValuesDeepEqual(previous, draft)) return state;
            const nextDraft = reuseEqualSessionObjectFields(previous, draft);
            const next = previous
                ? existing.map((d) => (d.id === draft.id ? nextDraft : d))
                : [...existing, draft];

            const merged = { ...state.reviewCommentsDraftsBySessionId, [sessionId]: next };
            reviewCommentsDraftsBySessionId = merged;
            saveSessionReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsBySessionId: merged };
        }),
        setSessionReviewCommentDraftIncluded: (sessionId: string, commentId: string, included: boolean) => set((state) => {
            const existing = state.reviewCommentsDraftsBySessionId[sessionId] ?? [];
            if (!existing.some((draft) => draft.id === commentId && (draft.includeInPrompt !== false) !== included)) return state;
            const next = existing.map((draft) => (
                draft.id === commentId && (draft.includeInPrompt !== false) !== included
                    ? { ...draft, includeInPrompt: included } : draft
            ));
            const merged = { ...state.reviewCommentsDraftsBySessionId, [sessionId]: next };
            reviewCommentsDraftsBySessionId = merged;
            saveSessionReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsBySessionId: merged };
        }),
        deleteSessionReviewCommentDraft: (sessionId: string, commentId: string, expectedDraft?: ReviewCommentDraft) => set((state) => {
            const existing = state.reviewCommentsDraftsBySessionId[sessionId] ?? [];
            const next = existing.filter((draft) => draft.id !== commentId
                || (expectedDraft !== undefined && !areSessionValuesDeepEqual(draft, expectedDraft)));
            if (next.length === existing.length) return state;
            const merged = { ...state.reviewCommentsDraftsBySessionId };
            if (next.length > 0) merged[sessionId] = next;
            else delete merged[sessionId];
            reviewCommentsDraftsBySessionId = merged;
            saveSessionReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsBySessionId: merged };
        }),
        clearSessionReviewCommentDrafts: (sessionId: string) => set((state) => {
            if (!(sessionId in state.reviewCommentsDraftsBySessionId)) return state;
            const merged = { ...state.reviewCommentsDraftsBySessionId };
            delete merged[sessionId];
            reviewCommentsDraftsBySessionId = merged;
            saveSessionReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsBySessionId: merged };
        }),
        upsertWorkspaceReviewCommentDraft: (workspaceCacheKey: string, draft: ReviewCommentDraft) => set((state) => {
            const key = String(workspaceCacheKey ?? '').trim();
            if (!key) return state;
            const existing = state.reviewCommentsDraftsByWorkspaceCacheKey[key] ?? [];
            const previous = existing.find((d) => d.id === draft.id);
            if (previous && areSessionValuesDeepEqual(previous, draft)) return state;
            const nextDraft = reuseEqualSessionObjectFields(previous, draft);
            const next = previous
                ? existing.map((d) => (d.id === draft.id ? nextDraft : d))
                : [...existing, draft];
            const merged = { ...state.reviewCommentsDraftsByWorkspaceCacheKey, [key]: next };
            reviewCommentsDraftsByWorkspaceCacheKey = merged;
            saveWorkspaceReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsByWorkspaceCacheKey: merged };
        }),
        setWorkspaceReviewCommentDraftIncluded: (workspaceCacheKey: string, commentId: string, included: boolean) => set((state) => {
            const key = String(workspaceCacheKey ?? '').trim();
            if (!key) return state;
            const existing = state.reviewCommentsDraftsByWorkspaceCacheKey[key] ?? [];
            if (!existing.some((draft) => draft.id === commentId && (draft.includeInPrompt !== false) !== included)) return state;
            const next = existing.map((draft) => (
                draft.id === commentId && (draft.includeInPrompt !== false) !== included
                    ? { ...draft, includeInPrompt: included } : draft
            ));
            const merged = { ...state.reviewCommentsDraftsByWorkspaceCacheKey, [key]: next };
            reviewCommentsDraftsByWorkspaceCacheKey = merged;
            saveWorkspaceReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsByWorkspaceCacheKey: merged };
        }),
        deleteWorkspaceReviewCommentDraft: (workspaceCacheKey: string, commentId: string, expectedDraft?: ReviewCommentDraft) => set((state) => {
            const key = String(workspaceCacheKey ?? '').trim();
            if (!key) return state;
            const existing = state.reviewCommentsDraftsByWorkspaceCacheKey[key] ?? [];
            const next = existing.filter((draft) => draft.id !== commentId
                || (expectedDraft !== undefined && !areSessionValuesDeepEqual(draft, expectedDraft)));
            if (next.length === existing.length) return state;
            const merged = { ...state.reviewCommentsDraftsByWorkspaceCacheKey };
            if (next.length > 0) merged[key] = next;
            else delete merged[key];
            reviewCommentsDraftsByWorkspaceCacheKey = merged;
            saveWorkspaceReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsByWorkspaceCacheKey: merged };
        }),
        clearWorkspaceReviewCommentDrafts: (workspaceCacheKey: string) => set((state) => {
            const key = String(workspaceCacheKey ?? '').trim();
            if (!key) return state;
            if (!(key in state.reviewCommentsDraftsByWorkspaceCacheKey)) return state;
            const merged = { ...state.reviewCommentsDraftsByWorkspaceCacheKey };
            delete merged[key];
            reviewCommentsDraftsByWorkspaceCacheKey = merged;
            saveWorkspaceReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsByWorkspaceCacheKey: merged };
        }),

        createSessionActionDraft: (scope: ServerAccountScope, address: SessionAddress, draft) => {
            const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
            const normalizedScope = createServerAccountScope(scope.serverId, scope.accountId);
            if (!normalizedAddress || !normalizedScope || normalizedAddress.serverId !== normalizedScope.serverId) {
                throw new Error('Session action draft target must match its exact Home Account scope');
            }
            const nowMs = nowServerMs();
            const created: SessionActionDraft = {
                id: createActionDraftId(nowMs),
                address: normalizedAddress,
                accountId: normalizedScope.accountId,
                actionId: String(draft.actionId),
                createdAt: nowMs,
                status: 'editing',
                input: { ...(draft.input ?? {}) },
                error: null,
            };
            set((state) => {
                const addressKey = sessionAddressKey(normalizedAddress);
                const existing = state.sessionActionDraftsByAddressKey[addressKey] ?? [];
                const next = [...existing, created];
                const merged = { ...state.sessionActionDraftsByAddressKey, [addressKey]: next };
                sessionActionDraftsByAddressKey = merged;
                saveSessionActionDrafts(merged, normalizedScope);
                return { ...state, sessionActionDraftsByAddressKey: merged };
            });
            return created;
        },
        updateSessionActionDraftInput: (scope: ServerAccountScope, address: SessionAddress, draftId: string, patch: Record<string, unknown>) =>
            set((state) => {
                const normalizedScope = createServerAccountScope(scope.serverId, scope.accountId);
                const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
                if (!normalizedScope || !normalizedAddress || normalizedScope.serverId !== normalizedAddress.serverId) return state;
                const addressKey = sessionAddressKey(normalizedAddress);
                const inMemory = state.sessionActionDraftsByAddressKey[addressKey]?.filter((draft) => draft.accountId === normalizedScope.accountId);
                const existing = inMemory?.length ? inMemory : loadSessionActionDrafts(normalizedScope)[addressKey] ?? [];
                const idx = existing.findIndex((d) => d.id === draftId);
                if (idx < 0) return state;
                const prev = existing[idx]!;
                const updated: SessionActionDraft = {
                    ...prev,
                    input: reuseEqualSessionObjectFields(prev.input, { ...(prev.input ?? {}), ...(patch ?? {}) }),
                };
                if (inMemory?.length && areSessionValuesDeepEqual(prev, updated)) return state;
                const next = [...existing.slice(0, idx), updated, ...existing.slice(idx + 1)];
                const merged = { ...state.sessionActionDraftsByAddressKey, [addressKey]: next };
                sessionActionDraftsByAddressKey = merged;
                saveSessionActionDrafts(merged, normalizedScope);
                return { ...state, sessionActionDraftsByAddressKey: merged };
            }),
        setSessionActionDraftStatus: (scope: ServerAccountScope, address: SessionAddress, draftId: string, status: SessionActionDraftStatus, error?: string | null) =>
            set((state) => {
                const normalizedScope = createServerAccountScope(scope.serverId, scope.accountId);
                const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
                if (!normalizedScope || !normalizedAddress || normalizedScope.serverId !== normalizedAddress.serverId) return state;
                const addressKey = sessionAddressKey(normalizedAddress);
                const inMemory = state.sessionActionDraftsByAddressKey[addressKey]?.filter((draft) => draft.accountId === normalizedScope.accountId);
                const existing = inMemory?.length ? inMemory : loadSessionActionDrafts(normalizedScope)[addressKey] ?? [];
                const idx = existing.findIndex((d) => d.id === draftId);
                if (idx < 0) return state;
                const prev = existing[idx]!;
                const updated: SessionActionDraft = {
                    ...prev,
                    status,
                    ...(typeof error !== 'undefined' ? { error: error ?? null } : {}),
                };
                if (inMemory?.length && areSessionValuesDeepEqual(prev, updated)) return state;
                const next = [...existing.slice(0, idx), updated, ...existing.slice(idx + 1)];
                const merged = { ...state.sessionActionDraftsByAddressKey, [addressKey]: next };
                sessionActionDraftsByAddressKey = merged;
                saveSessionActionDrafts(merged, normalizedScope);
                return { ...state, sessionActionDraftsByAddressKey: merged };
            }),
        deleteSessionActionDraft: (scope: ServerAccountScope, address: SessionAddress, draftId: string) =>
            set((state) => {
                const normalizedScope = createServerAccountScope(scope.serverId, scope.accountId);
                const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
                if (!normalizedScope || !normalizedAddress || normalizedScope.serverId !== normalizedAddress.serverId) return state;
                const addressKey = sessionAddressKey(normalizedAddress);
                const inMemory = state.sessionActionDraftsByAddressKey[addressKey]?.filter((draft) => draft.accountId === normalizedScope.accountId);
                const existing = inMemory?.length ? inMemory : loadSessionActionDrafts(normalizedScope)[addressKey] ?? [];
                if (!existing.some((draft) => draft.id === draftId)) return state;
                const next = existing.filter((d) => d.id !== draftId);
                const merged = { ...state.sessionActionDraftsByAddressKey };
                if (next.length > 0) merged[addressKey] = next;
                else delete merged[addressKey];
                sessionActionDraftsByAddressKey = merged;
                saveSessionActionDrafts(merged, normalizedScope);
                return { ...state, sessionActionDraftsByAddressKey: merged };
            }),
        clearSessionActionDrafts: (scope: ServerAccountScope, address: SessionAddress) =>
            set((state) => {
                const normalizedScope = createServerAccountScope(scope.serverId, scope.accountId);
                const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
                if (!normalizedScope || !normalizedAddress || normalizedScope.serverId !== normalizedAddress.serverId) return state;
                const addressKey = sessionAddressKey(normalizedAddress);
                const inMemory = state.sessionActionDraftsByAddressKey[addressKey]?.filter((draft) => draft.accountId === normalizedScope.accountId);
                const existing = inMemory?.length ? inMemory : loadSessionActionDrafts(normalizedScope)[addressKey] ?? [];
                if (existing.length === 0) return state;
                const merged = { ...state.sessionActionDraftsByAddressKey };
                delete merged[addressKey];
                sessionActionDraftsByAddressKey = merged;
                saveSessionActionDrafts(merged, normalizedScope);
                return { ...state, sessionActionDraftsByAddressKey: merged };
            }),
        markSessionOptimisticThinking: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const nextSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    optimisticThinkingAt: Date.now(),
                },
            };

            optimisticThinkingTimeouts.schedule(sessionId, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS, () => {
                set((s) => {
                    const current = s.sessions[sessionId];
                    if (!current) return s;
                    if (!current.optimisticThinkingAt) return s;

                    const next = {
                        ...s.sessions,
                        [sessionId]: {
                            ...current,
                            optimisticThinkingAt: null,
                        },
                    };
                    return {
                        ...s,
                        sessions: next,
                    };
                });
            });

            return {
                ...state,
                sessions: nextSessions,
            };
        }),
        clearSessionOptimisticThinking: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            if (!session.optimisticThinkingAt) return state;

            optimisticThinkingTimeouts.cancel(sessionId);

            const nextSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    optimisticThinkingAt: null,
                },
            };

            return {
                ...state,
                sessions: nextSessions,
            };
        }),
        markSessionResuming: (sessionId: string) => {
            const resumingAt = Date.now();
            if (!get().sessions[sessionId]) return;
            resumingTimeouts.cancel(sessionId);
            updateSessionResumingAt(sessionId, resumingAt);
        },
        armSessionResumingFallback: (sessionId: string) => {
            const resumingAt = get().sessions[sessionId]?.resumingAt ?? null;
            if (resumingAt === null) return;
            resumingTimeouts.schedule(sessionId, SESSION_RESUMING_PRESENTATION_TIMEOUT_MS, () => {
                const current = get().sessions[sessionId];
                if ((current?.resumingAt ?? null) !== resumingAt) return;
                updateSessionResumingAt(sessionId, null);
            });
        },
        clearSessionResuming: (sessionId: string) => {
            resumingTimeouts.cancel(sessionId);
            updateSessionResumingAt(sessionId, null);
        },
        clearSessionThinkingGrace: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            if ((session.thinkingGraceUntil ?? null) === null) return state;

            thinkingGraceTimeouts.cancel(sessionId);

            const nextSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    thinkingGraceUntil: null,
                },
            };

            return {
                ...state,
                sessions: nextSessions,
            };
        }),
        applySessionTerminalLifecycle: (sessionId: string, turnCompletedAt: number | null) => {
            resumingTimeouts.cancel(sessionId);
            updateSessionResumingAt(sessionId, null);
            set((state) => {
                const session = state.sessions[sessionId];
                if (!session) return state;

                optimisticThinkingTimeouts.cancel(sessionId);
                thinkingGraceTimeouts.cancel(sessionId);

                const normalizedTurnCompletedAt = typeof turnCompletedAt === 'number'
                    && Number.isFinite(turnCompletedAt)
                    && turnCompletedAt > 0
                    ? turnCompletedAt
                    : session.lastTurnCompletedAt ?? null;
                const nextSession: Session = {
                    ...session,
                    thinking: false,
                    updatedAt: nowServerMs(),
                    optimisticThinkingAt: null,
                    resumingAt: null,
                    thinkingGraceUntil: null,
                    lastTurnCompletedAt: normalizedTurnCompletedAt,
                };

                if (areStoredSessionsEqual(session, nextSession)) return state;

                const nextSessions = {
                    ...state.sessions,
                    [sessionId]: nextSession,
                };

                return {
                    ...state,
                    sessions: nextSessions,
                    projectAuthoringSessions: updateProjectAuthoringSessionInputs(state.projectAuthoringSessions, sessionId, nextSession),
                };
            });
        },
        applySessionResponsibleAccount: (sessionId: string, responsibleAccountId: string | null, scope: ServerAccountScope, responsibleAccount?: import('@happier-dev/protocol').SessionAccessAccountSummaryV1 | null) => set((state) => {
            const activeScope = state.sessionLocalStateScope;
            // A late response must never update a different Account after sign-in changes.
            if (activeScope?.serverId === scope.serverId && !areServerAccountScopesEqual(activeScope, scope)) return state;
            const active = areServerAccountScopesEqual(activeScope, scope);
            const session = active ? state.sessions[sessionId] : undefined;
            const rows = state.sessionListRowsByServerId[scope.serverId];
            const row = rows?.[sessionId];
            const nextSummary = responsibleAccount === undefined
                ? (responsibleAccountId === null ? null : (session as { responsibleAccount?: unknown } | undefined)?.responsibleAccount as never ?? (row as { responsibleAccount?: unknown } | undefined)?.responsibleAccount as never ?? undefined)
                : responsibleAccount;
            const sessionChanged = session && (session.responsibleAccountId !== responsibleAccountId || (nextSummary !== undefined && !areSessionValuesDeepEqual(session.responsibleAccount ?? null, nextSummary ?? null)));
            const rowChanged = row && (row.responsibleAccountId !== responsibleAccountId || (nextSummary !== undefined && !areSessionValuesDeepEqual(row.responsibleAccount ?? null, nextSummary ?? null)));
            if (!sessionChanged && !rowChanged) return state;
            const applySummary = nextSummary === undefined ? {} : { responsibleAccount: nextSummary };
            const nextRows = rowChanged
                ? { ...state.sessionListRowsByServerId, [scope.serverId]: { ...rows, [sessionId]: { ...row, responsibleAccountId, ...applySummary } } }
                : state.sessionListRowsByServerId;
            return {
                ...state,
                sessions: sessionChanged ? { ...state.sessions, [sessionId]: { ...session, responsibleAccountId, ...applySummary } } : state.sessions,
                sessionListRowsByServerId: nextRows,
            };
        }),
        markSessionViewed: (sessionId: string) => {
            const now = Date.now();
            sessionLastViewed[sessionId] = now;
            saveSessionLastViewed(sessionLastViewed, sessionLocalStateScope);
            set((state) => ({
                ...state,
                sessionLastViewed: { ...sessionLastViewed }
            }));
        },
        updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const now = nowServerMs();
            // Update the session with the new permission mode
            const updatedSessions = {
                ...state.sessions,
                // Mark as locally updated so older message-based inference cannot override this selection.
                // Newer user messages (from any device) will still take over.
                [sessionId]: mutateSessionPermissionModeField({ session, mode, updatedAt: now }),
            };

            const persisted = persistSessionPermissionData(updatedSessions, sessionLocalStateScope, {
                modes: sessionPermissionModes,
                updatedAts: sessionPermissionModeUpdatedAts,
            });
            if (persisted) {
                sessionPermissionModes = persisted.modes;
                sessionPermissionModeUpdatedAts = persisted.updatedAts;
            }

            // No need to rebuild session-list index since permission mode doesn't affect list grouping/presentation.
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
	        updateSessionModelMode: (sessionId: string, mode: SessionModelMode, context?: SessionModelOptionsContext) => set((state) => {
	            const session = state.sessions[sessionId];
	            if (!session) return state;
	
	            const now = nowServerMs();
                const normalized = typeof mode === 'string' ? mode.trim() : '';
                const candidate: SessionModelMode = (normalized || 'default') as any;
                const ownerMetadataView = readSessionOwnerMetadataView(session);
                const composerOptionsInput = session.composerOptionsInput === undefined ? ownerMetadataView : session.composerOptionsInput;
                const resolvedAgentId = readSessionPresentationAgentId(session) ?? resolveAgentIdFromSessionMetadata(ownerMetadataView);
                const effectiveMode: SessionModelMode =
                    resolvedAgentId && candidate !== 'default' && !isModelSelectableForSession(resolvedAgentId, composerOptionsInput, candidate, context)
                        ? 'default'
                        : candidate;

                const reducerState = state.sessionMessages[sessionId]?.reducerState;
                if (reducerState) {
                    reconcileLatestUsageContextSnapshotModel(reducerState, effectiveMode);
                }
	
	            // Update the session with the new model mode
	            const updatedSessions = {
	                ...state.sessions,
	                [sessionId]: mutateSessionModelModeField({
                        session,
                        modelMode: effectiveMode,
                        updatedAt: now,
                    }),
	            };

            const persisted = persistSessionModelData(updatedSessions, sessionLocalStateScope, {
                modes: sessionModelModes,
                updatedAts: sessionModelModeUpdatedAts,
            });
            if (persisted) {
                sessionModelModes = persisted.modes;
                sessionModelModeUpdatedAts = persisted.updatedAts;
            }

            // No need to rebuild session-list index since model mode doesn't affect list grouping/presentation.
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        // Project management methods
        getProject: (projectId: string) => projectManager.getProject(projectId),
        getProjectForSession: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? projectManager.getProjectForWorkspace(scope) : null;
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getProjectForSession(sessionId);
        },
        // Project source-control methods
        getProjectScmStatus: (projectId: string) => projectManager.getProjectScmStatus(projectId),
        getSessionProjectScmStatus: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().getWorkspaceScmStatus(scope) : null;
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmStatus(sessionId);
        },
        updateSessionProjectScmStatus: (sessionId: string, status: ScmStatus | null, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().updateWorkspaceScmStatus(scope, status) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.updateSessionProjectScmStatus(sessionId, status)) {
                set((state) => ({ ...state }));
            }
        },
        getProjectScmSnapshot: (projectId: string) => projectManager.getProjectScmSnapshot(projectId),
        getProjectScmSnapshotError: (projectId: string) => projectManager.getProjectScmSnapshotError(projectId),
        getSessionProjectScmSnapshot: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().getWorkspaceScmSnapshot(scope) : null;
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmSnapshot(sessionId);
        },
        getSessionProjectScmSnapshotError: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().getWorkspaceScmSnapshotError(scope) : null;
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmSnapshotError(sessionId);
        },
        updateSessionProjectScmSnapshot: (sessionId: string, snapshot: ScmWorkingSnapshot | null, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().updateWorkspaceScmSnapshot(scope, snapshot) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.updateSessionProjectScmSnapshot(sessionId, snapshot)) {
                set((state) => ({ ...state }));
            }
        },
        updateSessionProjectScmSnapshotError: (
            sessionId: string,
            error: import('../../runtime/orchestration/projectManager').ProjectScmSnapshotError | null,
            serverId?: string | null,
        ) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().updateWorkspaceScmSnapshotError(scope, error) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.updateSessionProjectScmSnapshotError(sessionId, error)) {
                set((state) => ({ ...state }));
            }
        },
        publishSessionProjectScmSnapshots: (publishes) => {
            // A project SCM refresh publishes to every session sharing the repo. Doing that
            // through the individual snapshot/status/prune actions costs up to six store
            // notifications per session; every notification re-runs all store subscribers,
            // which starves the JS thread on large accounts. All project-manager mutations
            // happen here first, then a single notification covers the whole batch.
            if (publishes.length === 0) return;
            const statusUpdates: Record<string, ScmStatus | null> = {};
            let projectChanged = false;
            for (const { sessionId, serverId, snapshot, status } of publishes) {
                if (serverId != null) {
                    const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                    if (!scope) continue;
                    projectChanged = projectManager.updateWorkspaceScmSnapshot(scope, snapshot) || projectChanged;
                    projectChanged = projectManager.updateWorkspaceScmSnapshotError(scope, null) || projectChanged;
                    projectChanged = projectManager.updateWorkspaceScmStatus(scope, status) || projectChanged;
                    const activePaths = new Set(snapshot.entries.map((entry) => entry.path));
                    projectChanged = projectManager.pruneWorkspaceScmTouchedPaths(scope, activePaths) || projectChanged;
                    projectChanged = projectManager.pruneWorkspaceScmCommitSelectionPaths(scope, activePaths) || projectChanged;
                    projectChanged = projectManager.pruneWorkspaceScmCommitSelectionPatches(scope, activePaths) || projectChanged;
                    continue;
                }
                ensureProjectManagerSession(sessionId);
                projectChanged = projectManager.updateSessionProjectScmSnapshot(sessionId, snapshot) || projectChanged;
                projectChanged = projectManager.updateSessionProjectScmSnapshotError(sessionId, null) || projectChanged;
                projectChanged = projectManager.updateSessionProjectScmStatus(sessionId, status) || projectChanged;
                const activePaths = new Set(snapshot.entries.map((entry) => entry.path));
                projectChanged = projectManager.pruneWorkspaceScmTouchedPathsForSession(sessionId, activePaths) || projectChanged;
                projectChanged = projectManager.pruneSessionProjectScmCommitSelectionPaths(sessionId, activePaths) || projectChanged;
                projectChanged = projectManager.pruneSessionProjectScmCommitSelectionPatches(sessionId, activePaths) || projectChanged;
                statusUpdates[sessionId] = status;
            }
            set((state) => {
                let nextStatus = state.sessionScmStatus;
                for (const [sessionId, status] of Object.entries(statusUpdates)) {
                    if (areSessionValuesDeepEqual(nextStatus[sessionId], status)) continue;
                    if (nextStatus === state.sessionScmStatus) nextStatus = { ...state.sessionScmStatus };
                    nextStatus[sessionId] = status;
                }
                return projectChanged || nextStatus !== state.sessionScmStatus
                    ? { ...state, sessionScmStatus: nextStatus }
                    : state;
            });
        },
        getWorkspaceScmTouchedPathsForSession: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().getWorkspaceScmTouchedPaths(scope) : [];
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getWorkspaceScmTouchedPathsForSession(sessionId);
        },
        markWorkspaceScmTouchedPathsForSession: (sessionId: string, paths: string[], serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().markWorkspaceScmTouchedPaths(scope, paths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.markWorkspaceScmTouchedPathsForSession(sessionId, paths)) {
                set((state) => ({ ...state }));
            }
        },
        pruneWorkspaceScmTouchedPathsForSession: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().pruneWorkspaceScmTouchedPaths(scope, activePaths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.pruneWorkspaceScmTouchedPathsForSession(sessionId, activePaths)) {
                set((state) => ({ ...state }));
            }
        },
        getSessionProjectScmCommitSelectionPaths: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().getWorkspaceScmCommitSelectionPaths(scope) : [];
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmCommitSelectionPaths(sessionId);
        },
        markSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[], serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().markWorkspaceScmCommitSelectionPaths(scope, paths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.markSessionProjectScmCommitSelectionPaths(sessionId, paths)) {
                set((state) => ({ ...state }));
            }
        },
        unmarkSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[], serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().unmarkWorkspaceScmCommitSelectionPaths(scope, paths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.unmarkSessionProjectScmCommitSelectionPaths(sessionId, paths)) {
                set((state) => ({ ...state }));
            }
        },
        clearSessionProjectScmCommitSelectionPaths: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().clearWorkspaceScmCommitSelectionPaths(scope) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.clearSessionProjectScmCommitSelectionPaths(sessionId)) {
                set((state) => ({ ...state }));
            }
        },
        pruneSessionProjectScmCommitSelectionPaths: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().pruneWorkspaceScmCommitSelectionPaths(scope, activePaths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.pruneSessionProjectScmCommitSelectionPaths(sessionId, activePaths)) {
                set((state) => ({ ...state }));
            }
        },
        getSessionProjectScmCommitSelectionPatches: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().getWorkspaceScmCommitSelectionPatches(scope) : [];
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmCommitSelectionPatches(sessionId);
        },
        upsertSessionProjectScmCommitSelectionPatch: (sessionId: string, patchSelection: ScmCommitSelectionPatch, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().upsertWorkspaceScmCommitSelectionPatch(scope, patchSelection) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.upsertSessionProjectScmCommitSelectionPatch(sessionId, patchSelection)) {
                set((state) => ({ ...state }));
            }
        },
        removeSessionProjectScmCommitSelectionPatch: (sessionId: string, path: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().removeWorkspaceScmCommitSelectionPatch(scope, path) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.removeSessionProjectScmCommitSelectionPatch(sessionId, path)) {
                set((state) => ({ ...state }));
            }
        },
        clearSessionProjectScmCommitSelectionPatches: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().clearWorkspaceScmCommitSelectionPatches(scope) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.clearSessionProjectScmCommitSelectionPatches(sessionId)) {
                set((state) => ({ ...state }));
            }
        },
        pruneSessionProjectScmCommitSelectionPatches: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().pruneWorkspaceScmCommitSelectionPatches(scope, activePaths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            if (projectManager.pruneSessionProjectScmCommitSelectionPatches(sessionId, activePaths)) {
                set((state) => ({ ...state }));
            }
        },
        getSessionProjectScmOperationLog: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().getWorkspaceScmOperationLog(scope) : [];
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmOperationLog(sessionId);
        },
        appendSessionProjectScmOperation: (
            sessionId: string,
            entry: Omit<ScmOperationLogEntry, 'id' | 'sessionId'>,
            serverId?: string | null,
        ) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().appendWorkspaceScmOperation(scope, entry) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            projectManager.appendSessionProjectScmOperation(sessionId, entry);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmInFlightOperation: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().getWorkspaceScmInFlightOperation(scope) : null;
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmInFlightOperation(sessionId);
        },
        beginSessionProjectScmOperation: (
            sessionId: string,
            operation: import('../../runtime/orchestration/projectManager').ScmProjectOperationKind,
            serverId?: string | null,
        ) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().beginWorkspaceScmOperation(scope, operation) : { started: false, reason: 'missing_project', inFlight: null };
            }
            ensureProjectManagerSession(sessionId);
            const result = projectManager.beginSessionProjectScmOperation(sessionId, operation);
            if (result.started) {
                set((state) => ({ ...state }));
            }
            return result;
        },
        finishSessionProjectScmOperation: (sessionId: string, operationId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().finishWorkspaceScmOperation(scope, operationId) : false;
            }
            ensureProjectManagerSession(sessionId);
            const finished = projectManager.finishSessionProjectScmOperation(sessionId, operationId);
            if (finished) {
                set((state) => ({ ...state }));
            }
            return finished;
        },
        updateSessionProjectScmOperationProgress: (sessionId, operationId, progressText, serverId) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().updateWorkspaceScmOperationProgress(scope, operationId, progressText) : false;
            }
            ensureProjectManagerSession(sessionId);
            const updated = projectManager.updateSessionProjectScmOperationProgress(sessionId, operationId, progressText);
            if (updated) set((state) => ({ ...state }));
            return updated;
        },
        getWorkspaceScmStatus: (scope) => projectManager.getWorkspaceScmStatus(scope),
        updateWorkspaceScmStatus: (scope, status) => {
            if (projectManager.updateWorkspaceScmStatus(scope, status)) {
                set((state) => ({ ...state }));
            }
        },
        getWorkspaceScmSnapshot: (scope) => projectManager.getWorkspaceScmSnapshot(scope),
        getWorkspaceScmSnapshotError: (scope) => projectManager.getWorkspaceScmSnapshotError(scope),
        updateWorkspaceScmSnapshot: (scope, snapshot) => {
            if (projectManager.updateWorkspaceScmSnapshot(scope, snapshot)) {
                set((state) => ({ ...state }));
            }
        },
        updateWorkspaceScmSnapshotError: (scope, error) => {
            if (projectManager.updateWorkspaceScmSnapshotError(scope, error)) {
                set((state) => ({ ...state }));
            }
        },
        getWorkspaceScmTouchedPaths: (scope) => projectManager.getWorkspaceScmTouchedPaths(scope),
        markWorkspaceScmTouchedPaths: (scope, paths, touchedAt) => {
            if (projectManager.markWorkspaceScmTouchedPaths(scope, paths, touchedAt)) {
                set((state) => ({ ...state }));
            }
        },
        pruneWorkspaceScmTouchedPaths: (scope, activePaths) => {
            if (projectManager.pruneWorkspaceScmTouchedPaths(scope, activePaths)) {
                set((state) => ({ ...state }));
            }
        },
        getWorkspaceScmCommitSelectionPaths: (scope) => projectManager.getWorkspaceScmCommitSelectionPaths(scope),
        markWorkspaceScmCommitSelectionPaths: (scope, paths, selectedAt) => {
            if (projectManager.markWorkspaceScmCommitSelectionPaths(scope, paths, selectedAt)) {
                set((state) => ({ ...state }));
            }
        },
        unmarkWorkspaceScmCommitSelectionPaths: (scope, paths) => {
            if (projectManager.unmarkWorkspaceScmCommitSelectionPaths(scope, paths)) {
                set((state) => ({ ...state }));
            }
        },
        clearWorkspaceScmCommitSelectionPaths: (scope) => {
            if (projectManager.clearWorkspaceScmCommitSelectionPaths(scope)) {
                set((state) => ({ ...state }));
            }
        },
        pruneWorkspaceScmCommitSelectionPaths: (scope, activePaths) => {
            if (projectManager.pruneWorkspaceScmCommitSelectionPaths(scope, activePaths)) {
                set((state) => ({ ...state }));
            }
        },
        getWorkspaceScmCommitSelectionPatches: (scope) => projectManager.getWorkspaceScmCommitSelectionPatches(scope),
        upsertWorkspaceScmCommitSelectionPatch: (scope, patchSelection, selectedAt) => {
            if (projectManager.upsertWorkspaceScmCommitSelectionPatch(scope, patchSelection, selectedAt)) {
                set((state) => ({ ...state }));
            }
        },
        removeWorkspaceScmCommitSelectionPatch: (scope, path) => {
            if (projectManager.removeWorkspaceScmCommitSelectionPatch(scope, path)) {
                set((state) => ({ ...state }));
            }
        },
        clearWorkspaceScmCommitSelectionPatches: (scope) => {
            if (projectManager.clearWorkspaceScmCommitSelectionPatches(scope)) {
                set((state) => ({ ...state }));
            }
        },
        pruneWorkspaceScmCommitSelectionPatches: (scope, activePaths) => {
            if (projectManager.pruneWorkspaceScmCommitSelectionPatches(scope, activePaths)) {
                set((state) => ({ ...state }));
            }
        },
        getWorkspaceScmOperationLog: (scope) => projectManager.getWorkspaceScmOperationLog(scope),
        appendWorkspaceScmOperation: (scope, entry) => {
            projectManager.appendWorkspaceScmOperation(scope, entry);
            set((state) => ({ ...state }));
        },
        getWorkspaceScmInFlightOperation: (scope) => projectManager.getWorkspaceScmInFlightOperation(scope),
        beginWorkspaceScmOperation: (scope, operation) => {
            const result = projectManager.beginWorkspaceScmOperation(scope, operation);
            if (result.started) {
                set((state) => ({ ...state }));
            }
            return result;
        },
        finishWorkspaceScmOperation: (scope, operationId) => {
            const finished = projectManager.finishWorkspaceScmOperation(scope, operationId);
            if (finished) {
                set((state) => ({ ...state }));
            }
            return finished;
        },
        updateWorkspaceScmOperationProgress: (scope, operationId, progressText) => {
            const updated = projectManager.updateWorkspaceScmOperationProgress(scope, operationId, progressText);
            if (updated) set((state) => ({ ...state }));
            return updated;
        },
        deleteSession: (sessionId: string, serverId?: string | null) => set((state) => {
            const targetServerId = normalizeTrimmedString(serverId) || null;
            const observationAddress = normalizeSessionAddress(targetServerId ?? state.sessions[sessionId]?.serverId, sessionId);
            if (observationAddress) sessionRuntimeObservations.forget(observationAddress);
            // Fence every list read already in flight for this exact Home (or every
            // Home, when no Home was addressed) before its response can reinsert the row.
            recordSessionRetirement(sessionId, targetServerId);
            const retireActiveCarrier = shouldRetireSessionCarrierForServer(
                state.sessions[sessionId]?.serverId,
                targetServerId,
            );
            if (retireActiveCarrier) {
                optimisticThinkingTimeouts.cancel(sessionId);
                resumingTimeouts.cancel(sessionId);
                thinkingGraceTimeouts.cancel(sessionId);
            }

            // Remove session from sessions
            const { [sessionId]: deletedSession, ...remainingSessionRecords } = state.sessions;
            const remainingSessions = retireActiveCarrier ? remainingSessionRecords : state.sessions;
            let didDeleteRenderable = false;
            let remainingRowsByServerId = state.sessionListRowsByServerId as Record<string, Readonly<Record<string, SessionListRenderableSession>>>;
            let remainingOrdinaryMembershipByServerId = state.ordinarySessionListMembershipByServerId as Record<string, readonly string[] | undefined>;
            let remainingArchivedMembershipByServerId = state.archivedSessionListMembershipByServerId as Record<string, readonly string[] | undefined>;
            let remainingIndexByServerId = state.sessionListIndexByServerId as Record<string, SessionListIndexItem[] | null | undefined>;
            const indexSettings = resolveSessionListIndexRebuildSettings(state.settings);
            for (const [serverId, rows] of Object.entries(state.sessionListRowsByServerId)) {
                if (!rows[sessionId]) continue;
                if (targetServerId && !areServerProfileIdentifiersEquivalent(serverId, targetServerId)) {
                    // Another Home's row for the same Session id is a different Session.
                    continue;
                }
                didDeleteRenderable = true;
                const { [sessionId]: _deletedRow, ...remainingRows } = rows;
                if (remainingRowsByServerId === state.sessionListRowsByServerId) {
                    remainingRowsByServerId = { ...state.sessionListRowsByServerId };
                }
                remainingRowsByServerId[serverId] = remainingRows;
                const previousOrdinaryMembership = state.ordinarySessionListMembershipByServerId[serverId] ?? [];
                const nextOrdinaryMembership = previousOrdinaryMembership.filter((id) => id !== sessionId);
                if (nextOrdinaryMembership.length !== previousOrdinaryMembership.length) {
                    if (remainingOrdinaryMembershipByServerId === state.ordinarySessionListMembershipByServerId) {
                        remainingOrdinaryMembershipByServerId = { ...state.ordinarySessionListMembershipByServerId };
                    }
                    remainingOrdinaryMembershipByServerId[serverId] = nextOrdinaryMembership;
                }
                const previousArchivedMembership = state.archivedSessionListMembershipByServerId[serverId] ?? [];
                const nextArchivedMembership = previousArchivedMembership.filter((id) => id !== sessionId);
                if (nextArchivedMembership.length !== previousArchivedMembership.length) {
                    if (remainingArchivedMembershipByServerId === state.archivedSessionListMembershipByServerId) {
                        remainingArchivedMembershipByServerId = { ...state.archivedSessionListMembershipByServerId };
                    }
                    remainingArchivedMembershipByServerId[serverId] = nextArchivedMembership;
                }
                if (nextOrdinaryMembership.length !== previousOrdinaryMembership.length) {
                    const ordinaryRows = Object.fromEntries(nextOrdinaryMembership.flatMap((id) => {
                        const candidate = remainingRows[id];
                        return candidate ? [[id, candidate] as const] : [];
                    }));
                    if (remainingIndexByServerId === state.sessionListIndexByServerId) {
                        remainingIndexByServerId = { ...state.sessionListIndexByServerId };
                    }
                    remainingIndexByServerId[serverId] = buildSessionListIndexWithServerScope({
                        sessions: ordinaryRows,
                        machines: resolveSessionListMachineDisplaysForServer(state, serverId),
                        activeGroupingV1: indexSettings.activeGroupingV1,
                        inactiveGroupingV1: indexSettings.inactiveGroupingV1,
                        sectionModeV1: indexSettings.sectionModeV1,
                        previousIndex: state.sessionListIndexByServerId[serverId] ?? null,
                        serverScope: { serverId, serverName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId) },
                    });
                }
            }

            // Everything below this point is the SHARED per-id carrier: the hydrated
            // record, its transcript, SCM status, tree expansion, drafts and the
            // persisted permission/model modes are keyed by bare Session id and belong
            // to exactly one Home. Another Home's deletion of the same id removes only
            // that Home's row above; erasing this is silent local data loss.
            const {
                [sessionId]: deletedMessages,
                ...remainingSessionMessagesWithoutCarrier
            } = state.sessionMessages;
            const {
                [sessionId]: _deletedCoverage,
                ...remainingHistoryStartLoadedWithoutCarrier
            } = state.sessionMessagesHistoryStartLoaded ?? {};
            const {
                [sessionId]: _deletedScmStatus,
                ...remainingScmStatusWithoutCarrier
            } = state.sessionScmStatus;
            const {
                [sessionId]: _deletedReviewDrafts,
                ...remainingReviewDraftsWithoutCarrier
            } = state.reviewCommentsDraftsBySessionId;

            const remainingSessionMessages = retireActiveCarrier
                ? remainingSessionMessagesWithoutCarrier
                : state.sessionMessages;
            const remainingHistoryStartLoaded = retireActiveCarrier
                ? remainingHistoryStartLoadedWithoutCarrier
                : state.sessionMessagesHistoryStartLoaded ?? {};
            const remainingScmStatus = retireActiveCarrier
                ? remainingScmStatusWithoutCarrier
                : state.sessionScmStatus;
            const remainingReviewDrafts = retireActiveCarrier
                ? remainingReviewDraftsWithoutCarrier
                : state.reviewCommentsDraftsBySessionId;
            const remainingActionDrafts = retireActiveCarrier
                ? { ...state.sessionActionDraftsByAddressKey }
                : state.sessionActionDraftsByAddressKey;

            let nextTreeExpansionState: ReturnType<typeof deleteSessionRepositoryTreeExpansionForState> | null = null;
            if (retireActiveCarrier) {
                // Module-scoped derived caches (hooks.ts message-array/subagent caches)
                // root the materialized transcript outside the store, so release them
                // through the shared seam as well.
                clearSessionTranscriptDerivedCachesForSession(sessionId);

                nextTreeExpansionState = deleteSessionRepositoryTreeExpansionForState(state, sessionId);
                sessionRepositoryTreeExpandedPathsBySessionId =
                    nextTreeExpansionState.sessionRepositoryTreeExpandedPathsBySessionId;
                workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey =
                    nextTreeExpansionState.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
                reviewCommentsDraftsBySessionId = remainingReviewDrafts;
                const deletedDraftAddress = normalizeSessionAddress(
                    deletedSession?.serverId ?? sessionLocalStateScope?.serverId,
                    sessionId,
                );
                const deletedDraftAddressKey = deletedDraftAddress ? sessionAddressKey(deletedDraftAddress) : null;
                if (deletedDraftAddressKey) delete remainingActionDrafts[deletedDraftAddressKey];
                sessionActionDraftsByAddressKey = remainingActionDrafts;

                // Clear permission modes and other session-local projections from persistent storage.
                const reviewDrafts = loadSessionReviewCommentsDrafts(sessionLocalStateScope);
                delete reviewDrafts[sessionId];
                saveSessionReviewCommentsDrafts(reviewDrafts, sessionLocalStateScope);

                if (sessionLocalStateScope && deletedDraftAddressKey) {
                    const actionDrafts = loadSessionActionDrafts(sessionLocalStateScope);
                    delete actionDrafts[deletedDraftAddressKey];
                    saveSessionActionDrafts(actionDrafts, sessionLocalStateScope);
                }

                const modes = loadSessionPermissionModes(sessionLocalStateScope);
                delete modes[sessionId];
                saveSessionPermissionModes(modes, sessionLocalStateScope);
                sessionPermissionModes = modes;

                const updatedAts = loadSessionPermissionModeUpdatedAts(sessionLocalStateScope);
                delete updatedAts[sessionId];
                saveSessionPermissionModeUpdatedAts(updatedAts, sessionLocalStateScope);
                sessionPermissionModeUpdatedAts = updatedAts;

                const modelModes = loadSessionModelModes(sessionLocalStateScope);
                delete modelModes[sessionId];
                saveSessionModelModes(modelModes, sessionLocalStateScope);
                sessionModelModes = modelModes;

                const modelUpdatedAts = loadSessionModelModeUpdatedAts(sessionLocalStateScope);
                delete modelUpdatedAts[sessionId];
                saveSessionModelModeUpdatedAts(modelUpdatedAts, sessionLocalStateScope);
                sessionModelModeUpdatedAts = modelUpdatedAts;

                delete sessionLastViewed[sessionId];
                saveSessionLastViewed(sessionLastViewed, sessionLocalStateScope);
            }

            const nextStateBase = {
                ...state,
                sessions: remainingSessions,
                projectAuthoringSessions: retireActiveCarrier
                    ? updateProjectAuthoringSessionInputs(state.projectAuthoringSessions, sessionId, undefined)
                    : state.projectAuthoringSessions,
                sessionListRowsByServerId: remainingRowsByServerId,
                ordinarySessionListMembershipByServerId: remainingOrdinaryMembershipByServerId,
                archivedSessionListMembershipByServerId: remainingArchivedMembershipByServerId,
                sessionListIndexByServerId: remainingIndexByServerId,
                // The only durable record that this id is gone rather than merely uncached.
                // Another Home's deletion cannot tombstone this bare id: its hydrated
                // carrier remains authoritative even when that carrier's list row is evicted.
                // The value is the Home this retirement addressed, so a same-id carrier on
                // another Home is not read as deleted; `true` means no Home was addressed
                // and every Home's row went, which is what the loops above just did.
                ...(retireActiveCarrier
                    ? {
                        deletedSessionIds: {
                            ...state.deletedSessionIds,
                            [sessionId]: targetServerId ?? (true as const),
                        },
                    }
                    : {}),
                sessionMessages: remainingSessionMessages,
                sessionMessagesHistoryStartLoaded: remainingHistoryStartLoaded,
                sessionScmStatus: remainingScmStatus,
                ...(nextTreeExpansionState ?? {}),
                reviewCommentsDraftsBySessionId: remainingReviewDrafts,
                sessionActionDraftsByAddressKey: remainingActionDrafts,
                ...(retireActiveCarrier ? { sessionLastViewed: { ...sessionLastViewed } } : {}),
            };

            return finalizeSessionListIndexUpdate(
                state,
                nextStateBase,
                true,
                true,
                false,
                undefined,
                undefined,
                {
                    changedSessionIds: [],
                    removedSessionIds: didDeleteRenderable || (retireActiveCarrier && deletedSession !== undefined) ? [sessionId] : [],
                },
            );
        }),
    };
}
