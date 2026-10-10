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
import type { SessionListQueryMembership } from '../../domains/session/listing/sessionListQueryController';
import { readStoredSessionMessagesFromStateLike } from "@happier-dev/session-core/messages";
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
    peekSessionListWarmCacheEntries,
    type SessionListCacheEntryV1,
    type SessionListQueryMembershipCacheEntryV1,
    loadSessionListQueryMembershipWarmCacheEntries,
    saveSessionListQueryMembershipWarmCacheEntries,
    saveSessionListWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import {
    buildPersistedSessionListCacheEntriesFromRenderables,
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
import { areScmWorkingSnapshotsEquivalentIgnoringFetchedAt } from '@/scm/sync/snapshotDiff';
import { areServerAccountScopesEqual, createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    mutateSessionModelModeField,
    mutateSessionPermissionModeField,
} from '@/sync/state/mutators';

import type { StoreGet, StoreSet } from './_shared';
import { areSessionValuesDeepEqual, areStoredSessionsEqual } from './areStoredSessionsEqual';
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
import { classifySessionTupleApplyCurrentness } from './sessionTupleApplyCurrentness';
import {
    buildMachineDisplaysByIdFromMachineList,
    buildSessionListIndexWithServerScope,
} from '../sessionListIndex/buildSessionListIndexWithServerScope';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
} from '../../domains/server/serverProfiles';
import { normalizeTrimmedString } from '@/sync/domains/session/listing/normalizeTrimmedString';

export {
    classifySessionTupleApplyCurrentness,
    type SessionTupleApplyCurrentness,
} from './sessionTupleApplyCurrentness';

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

function resolveSessionListMachineDisplaysForServer(
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

export type SessionsDomain = {
    sessions: Record<string, Session>;
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

    activateSessionLocalStateScope: (scope: ServerAccountScope) => void;
    clearSessionLocalStateScope: () => void;
    getActiveSessions: () => Session[];
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    applyServerScopedSessionListRows: (
        serverId: string,
        sessions: SessionListRenderableSession[],
        options: Readonly<{ source: 'ordinary' | 'archived' | 'query' | 'rowOnly'; mode: 'replace' | 'append' }>,
    ) => void;
    applyServerScopedSessionListRowPatches: (
        serverId: string,
        patches: ReadonlyArray<Readonly<{
            sessionId: string;
            patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
        }>>,
    ) => void;
    reconcileSessionListRowsForServerScope: (
        serverId: string,
        sessions: SessionListRenderableSession[],
        baseline: Readonly<Record<string, SessionListRenderableSession>>,
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
    deleteSessionReviewCommentDraft: (sessionId: string, commentId: string) => void;
    clearSessionReviewCommentDrafts: (sessionId: string) => void;
    upsertWorkspaceReviewCommentDraft: (workspaceCacheKey: string, draft: ReviewCommentDraft) => void;
    setWorkspaceReviewCommentDraftIncluded: (workspaceCacheKey: string, commentId: string, included: boolean) => void;
    deleteWorkspaceReviewCommentDraft: (workspaceCacheKey: string, commentId: string) => void;
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

    getProjects: () => import('../../runtime/orchestration/projectManager').Project[];
    getProject: (projectId: string) => import('../../runtime/orchestration/projectManager').Project | null;
    getProjectForSession: (sessionId: string, serverId?: string | null) => import('../../runtime/orchestration/projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];

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

function isIncomingOrderingTimestampOlder(incoming: unknown, previous: unknown): boolean {
    const incomingNumber = normalizeSessionOrderingNumber(incoming);
    const previousNumber = normalizeSessionOrderingNumber(previous);
    return incomingNumber !== null && previousNumber !== null && incomingNumber < previousNumber;
}

function resolveOrderedSessionApply(
    previousSession: Session | undefined,
    incomingSession: IncomingSessionApply,
): IncomingSessionApply {
    let nextSession: IncomingSessionApply = reconcileSessionLifecycleProjection(previousSession, incomingSession);
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
    const tupleCurrentness = classifySessionTupleApplyCurrentness(previousSession, incomingSession);

    if (!tupleCurrentness.metadataCurrent) {
        applyPatch({
            metadataLayoutVersion: previousSession.metadataLayoutVersion,
            metadataProjection: previousSession.metadataProjection,
            metadata: previousSession.metadata,
            metadataVersion: previousSession.metadataVersion,
            ownerMetadataView: previousSession.ownerMetadataView,
            composerOptionsInput: previousSession.composerOptionsInput,
        });
    }
    if (!tupleCurrentness.agentStateCurrent) {
        applyPatch({
            agentState: previousSession.agentState,
            agentStateVersion: previousSession.agentStateVersion,
        });
    }

    // Additive-optional presentation projection: an omitted value carries no
    // information (older producer or partial writer), so it preserves the last
    // known server decision instead of asserting a solo Session. An explicit
    // boolean, including `false`, always replaces it.
    if (incomingSession.hasOtherNamedCollaborator === undefined && previousSession.hasOtherNamedCollaborator !== undefined) {
        applyPatch({ hasOtherNamedCollaborator: previousSession.hasOtherNamedCollaborator });
    }

    if (isIncomingOrderingTimestampOlder(incomingSession.pendingRequestObservedAt, previousSession.pendingRequestObservedAt)) {
        applyPatch({
            pendingPermissionRequestCount: previousSession.pendingPermissionRequestCount,
            pendingUserActionRequestCount: previousSession.pendingUserActionRequestCount,
            pendingRequestObservedAt: previousSession.pendingRequestObservedAt,
        });
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

function saveWarmSessionCacheForState(
    state: SessionsDomain & SessionsDomainDependencies,
    previousEntries?: Record<string, SessionListCacheEntryV1>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const accountId = resolveWarmCacheAccountScope(state.profile?.id);
    if (!activeServerId || !accountId) return;
    const activeRows = state.sessionListRowsByServerId[activeServerId] ?? {};
    const ordinaryMembership = state.ordinarySessionListMembershipByServerId[activeServerId] ?? [];
    const ordinaryRows = Object.fromEntries(ordinaryMembership.flatMap((sessionId) => {
        const row = activeRows[sessionId];
        return row ? [[sessionId, row] as const] : [];
    }));
    const previousWarmCacheEntries = previousEntries ?? peekSessionListWarmCacheEntries(activeServerId, accountId) ?? undefined;
    const nextEntries = buildPersistedSessionListCacheEntriesFromRenderables(ordinaryRows, previousWarmCacheEntries);
    if (previousWarmCacheEntries && nextEntries === previousWarmCacheEntries) return;
    saveSessionListWarmCacheEntries(
        activeServerId,
        accountId,
        nextEntries,
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

            const nextSession = { ...session, resumingAt };
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
        const trimmedServerId = serverIdRaw.trim();
        const serverId = activeServerId
            && areServerProfileIdentifiersEquivalent(trimmedServerId, activeServerId)
            ? activeServerId
            : trimmedServerId;
        const retainedQueryMemberships = Object.entries(state.sessionListQueryMembershipByKey)
            .filter(([, membership]) => membership && !areServerProfileIdentifiersEquivalent(membership.serverId, serverId));
        const didRemoveQueryMembership = retainedQueryMemberships.length
            !== Object.keys(state.sessionListQueryMembershipByKey).length;
        if (!serverId || (
            !state.sessionListRowsByServerId[serverId]
            && state.sessionListIndexByServerId[serverId] == null
            && !Object.prototype.hasOwnProperty.call(state.ordinarySessionListMembershipByServerId, serverId)
            && !Object.prototype.hasOwnProperty.call(state.archivedSessionListMembershipByServerId, serverId)
            && !didRemoveQueryMembership
        )) {
            return state;
        }
        const nextRowsByServerId = { ...state.sessionListRowsByServerId };
        const nextOrdinaryMembershipByServerId = { ...state.ordinarySessionListMembershipByServerId };
        const nextArchivedMembershipByServerId = { ...state.archivedSessionListMembershipByServerId };
        const nextIndexByServerId = { ...state.sessionListIndexByServerId };
        delete nextRowsByServerId[serverId];
        delete nextOrdinaryMembershipByServerId[serverId];
        delete nextArchivedMembershipByServerId[serverId];
        delete nextIndexByServerId[serverId];
        const removedSessionIds = state.ordinarySessionListMembershipByServerId[serverId] ?? [];
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
            state.sessionListIndexByServerId[serverId] != null,
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
        sessions: {},
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

                return {
                    ...state,
                    sessions: nextSessions,
                    sessionLastViewed: { ...sessionLastViewed },
                    reviewCommentsDraftsBySessionId: { ...reviewCommentsDraftsBySessionId },
                    reviewCommentsDraftsByWorkspaceCacheKey: { ...reviewCommentsDraftsByWorkspaceCacheKey },
                    sessionActionDraftsByAddressKey: { ...sessionActionDraftsByAddressKey },
                    sessionLocalStateScope: scope,
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
            set({
                sessionLastViewed: {},
                reviewCommentsDraftsBySessionId: {},
                reviewCommentsDraftsByWorkspaceCacheKey: {},
                sessionActionDraftsByAddressKey: {},
                sessionLocalStateScope: null,
            } as Partial<S> as S);
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
                const previousSession = state.sessions[incomingSession.id];
                const orderedSession = resolveOrderedSessionApply(previousSession, incomingSession);
                const declaredOwnerServerId = normalizeTrimmedString(orderedSession.serverId);
                const ownerServerId = declaredOwnerServerId && activeServerId
                    && areServerProfileIdentifiersEquivalent(declaredOwnerServerId, activeServerId)
                    ? activeServerId
                    : declaredOwnerServerId ?? activeServerId;
                const ownerRows = ownerServerId ? mergedRowsByServerId[ownerServerId] ?? {} : {};
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
                const existingLastTurnCompletedAt = state.sessions[session.id]?.lastTurnCompletedAt ?? null;
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
                    metadata: (
                        session.metadataLayoutVersion === undefined
                        || session.metadataLayoutVersion === 0
                    )
                        ? preserveSessionRuntimeLocalMetadata(
                            state.sessions[session.id]?.metadata,
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
                const mergedSession = areStoredSessionsEqual(previousSession, nextSession)
                    ? previousSession
                    : nextSession;
                if (mergedSession !== previousSession) {
                    changedSessionCount += 1;
                    if (mergedSessions === state.sessions) {
                        mergedSessions = { ...state.sessions };
                    }
                    mergedSessions[session.id] = mergedSession;
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
                        mergedRowsByServerId = { ...mergedRowsByServerId, [ownerServerId]: nextOwnerRows };
                        if (isActiveOwner) mergedRenderables = nextOwnerRows;
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
                const previousIndex = mergedSessionListIndexByServerId[serverId] ?? null;
                const nextIndex = buildSessionListIndexWithServerScope({
                    sessions: ordinaryRows,
                    machines: resolveSessionListMachineDisplaysForServer(state, serverId),
                    activeGroupingV1: sessionListIndexSettings.activeGroupingV1,
                    inactiveGroupingV1: sessionListIndexSettings.inactiveGroupingV1,
                    sectionModeV1: sessionListIndexSettings.sectionModeV1,
                    previousIndex,
                    serverScope: {
                        serverId,
                        serverName: getServerProfileById(serverId)?.name ?? null,
                    },
                });
                if (nextIndex === previousIndex) continue;
                mergedSessionListIndexByServerId = {
                    ...mergedSessionListIndexByServerId,
                    [serverId]: nextIndex,
                };
            }

            const nextStateBase = {
                ...state,
                sessions: mergedSessions,
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
        applyServerScopedSessionListRows: (serverIdRaw, sessions, options) => set((state) => {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            const trimmedServerId = serverIdRaw.trim();
            const serverId = activeServerId
                && areServerProfileIdentifiersEquivalent(trimmedServerId, activeServerId)
                ? activeServerId
                : trimmedServerId;
            if (!serverId) return state;
            const previousRowsByServerId = state.sessionListRowsByServerId ?? {};
            const previousRows = previousRowsByServerId[serverId] ?? {};
            let nextRows = previousRows as Record<string, SessionListRenderableSession>;
            const changedSessionIds: string[] = [];
            const changedRows: Array<Readonly<{
                previous: SessionListRenderableSession | undefined;
                next: SessionListRenderableSession;
            }>> = [];
            let staleMetadataPreservedCount = 0;
            let stalePendingFlagsPreservedCount = 0;
            for (const incoming of sessions) {
                const previous = previousRows[incoming.id];
                const withStaleFields = preserveSessionListRenderableStaleFields(previous, incoming);
                const next = preserveSessionListRenderableTransientState(previous, withStaleFields);
                if (didPreserveRenderableMetadata(previous, incoming, next)) staleMetadataPreservedCount += 1;
                if (didPreserveRenderablePendingFlags(previous, incoming, next)) stalePendingFlagsPreservedCount += 1;
                if (previous && areSessionListRenderablesEqual(previous, next)) continue;
                if (nextRows === previousRows) nextRows = { ...previousRows };
                nextRows[incoming.id] = next;
                changedSessionIds.push(incoming.id);
                changedRows.push({ previous, next });
            }

            const previousOrdinaryMembershipValue = state.ordinarySessionListMembershipByServerId?.[serverId];
            const previousOrdinaryMembership = previousOrdinaryMembershipValue ?? [];
            const previousArchivedMembershipValue = state.archivedSessionListMembershipByServerId?.[serverId];
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
            let needsOrdinaryIndexRebuild = nextOrdinaryMembership !== previousOrdinaryMembership;
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
            if (nextRows === previousRows && !didMembershipChange && !needsOrdinaryIndexRebuild) {
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
                    previousIndex: state.sessionListIndexByServerId[serverId] ?? null,
                    serverScope: {
                        serverId,
                        serverName: getServerProfileById(serverId)?.name ?? null,
                    },
                });
            };
            const nextRowsByServerId = nextRows === previousRows
                ? previousRowsByServerId
                : { ...previousRowsByServerId, [serverId]: nextRows };
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
                : state.sessionListIndexByServerId[serverId];
            const nextStateBase = {
                ...state,
                sessionListRowsByServerId: nextRowsByServerId,
                ...(nextOrdinaryMembership !== previousOrdinaryMembership ? {
                    ordinarySessionListMembershipByServerId: {
                        ...state.ordinarySessionListMembershipByServerId,
                        [serverId]: nextOrdinaryMembership,
                    },
                } : {}),
                ...(nextArchivedMembership !== previousArchivedMembership ? {
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
        }),
        applyServerScopedSessionListRowPatches: (serverIdRaw, patches) => set((state) => {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            const trimmedServerId = serverIdRaw.trim();
            const serverId = activeServerId
                && areServerProfileIdentifiersEquivalent(trimmedServerId, activeServerId)
                ? activeServerId
                : trimmedServerId;
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
            let missingCount = 0;
            let noopPatchCount = 0;
            let listViewFieldChangeCount = 0;
            for (const { sessionId, patch } of patches) {
                const previous = nextRows[sessionId];
                if (!previous) {
                    missingCount += 1;
                    continue;
                }
                const next = applySessionListRenderablePatch(
                    previous,
                    patch as SessionListRenderablePatchFields,
                );
                if (areSessionListRenderablesEqual(previous, next)) {
                    noopPatchCount += 1;
                    continue;
                }
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
                if (nextRows === previousRows) nextRows = { ...previousRows };
                nextRows[sessionId] = next;
            }
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
                            serverName: getServerProfileById(serverId)?.name ?? null,
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
        reconcileSessionListRowsForServerScope: (serverIdRaw, sessions, baseline) => set((state) => {
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            const trimmedServerId = serverIdRaw.trim();
            const serverId = activeServerId
                && areServerProfileIdentifiersEquivalent(trimmedServerId, activeServerId)
                ? activeServerId
                : trimmedServerId;
            if (!serverId) return state;
            const previousRowsByServerId = state.sessionListRowsByServerId;
            const previousRows = previousRowsByServerId[serverId] ?? {};
            const previousMembership = state.ordinarySessionListMembershipByServerId?.[serverId] ?? [];
            const previousOrdinaryMembership = new Set(previousMembership);
            const nextRows: Record<string, SessionListRenderableSession> = {};
            const incomingById = new Map(sessions.map((session) => [session.id, session]));
            const sessionIds = new Set([
                ...Object.keys(previousRows),
                ...Object.keys(baseline),
                ...incomingById.keys(),
            ]);
            for (const sessionId of sessionIds) {
                const previous = previousRows[sessionId];
                const atStart = baseline[sessionId];
                // Active Sync and exact-session hydration publish immutable row
                // objects. If the current object differs from the one captured
                // when inventory began, that newer create/update/delete wins
                // over the older paged snapshot.
                if (previous !== atStart) {
                    if (previous) nextRows[sessionId] = previous;
                    continue;
                }
                const incoming = incomingById.get(sessionId);
                if (!incoming) {
                    if (previous && !previousOrdinaryMembership.has(sessionId)) {
                        nextRows[sessionId] = previous;
                    }
                    continue;
                }
                const withStaleFields = preserveSessionListRenderableStaleFields(previous, incoming);
                nextRows[sessionId] = preserveSessionListRenderableTransientState(previous, withStaleFields);
            }
            const incomingMembership = sessions.map((session) => session.id);
            const incomingMembershipSet = new Set(incomingMembership);
            const nextMembership = [
                ...incomingMembership,
                ...(state.ordinarySessionListMembershipByServerId?.[serverId] ?? []).filter((sessionId) => (
                    !incomingMembershipSet.has(sessionId)
                    && previousRows[sessionId] !== baseline[sessionId]
                    && nextRows[sessionId] != null
                )),
            ];
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
                previousIndex: state.sessionListIndexByServerId[serverId] ?? null,
                serverScope: {
                    serverId,
                    serverName: getServerProfileById(serverId)?.name ?? null,
                },
            });
            const nextRowsByServerId = {
                ...previousRowsByServerId,
                [serverId]: nextRows,
            };
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
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    [serverId]: nextMembership,
                },
                sessionListIndexByServerId: {
                    ...state.sessionListIndexByServerId,
                    [serverId]: nextIndex,
                },
            };
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
            const trimmedServerId = serverIdRaw.trim();
            const serverId = activeServerId
                && areServerProfileIdentifiersEquivalent(trimmedServerId, activeServerId)
                ? activeServerId
                : trimmedServerId;
            if (!serverId || sessions.length === 0) return state;
            const previousRowsByServerId = state.sessionListRowsByServerId;
            const previousRows = previousRowsByServerId[serverId] ?? {};
            const nextRows = { ...previousRows };
            for (const incoming of sessions) {
                const previous = previousRows[incoming.id];
                const withStaleFields = preserveSessionListRenderableStaleFields(previous, incoming);
                nextRows[incoming.id] = preserveSessionListRenderableTransientState(previous, withStaleFields);
            }
            const previousMembership = state.ordinarySessionListMembershipByServerId?.[serverId] ?? [];
            const previousMembershipSet = new Set(previousMembership);
            const nextMembership = [...new Set([
                ...previousMembership,
                ...sessions.map((session) => session.id),
            ])];
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
                previousIndex: state.sessionListIndexByServerId[serverId] ?? null,
                serverScope: {
                    serverId,
                    serverName: getServerProfileById(serverId)?.name ?? null,
                },
            });
            const nextRowsByServerId = {
                ...previousRowsByServerId,
                [serverId]: nextRows,
            };
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
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    [serverId]: nextMembership,
                },
                sessionListIndexByServerId: {
                    ...state.sessionListIndexByServerId,
                    [serverId]: nextIndex,
                },
            };
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
        applyReady: () => set((state) => ({
            ...state,
            isDataReady: true
        })),
        applyScmStatus: (sessionId: string, status: ScmStatus | null) => set((state) => {
            // Update project git status as well
            projectManager.updateSessionProjectScmStatus(sessionId, status);

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
            const next = existing.some((d) => d.id === draft.id)
                ? existing.map((d) => (d.id === draft.id ? draft : d))
                : [...existing, draft];

            const merged = { ...state.reviewCommentsDraftsBySessionId, [sessionId]: next };
            reviewCommentsDraftsBySessionId = merged;
            saveSessionReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsBySessionId: merged };
        }),
        setSessionReviewCommentDraftIncluded: (sessionId: string, commentId: string, included: boolean) => set((state) => {
            const existing = state.reviewCommentsDraftsBySessionId[sessionId] ?? [];
            if (existing.length === 0) return state;
            const next = existing.map((draft) => (
                draft.id === commentId ? { ...draft, includeInPrompt: included } : draft
            ));
            const merged = { ...state.reviewCommentsDraftsBySessionId, [sessionId]: next };
            reviewCommentsDraftsBySessionId = merged;
            saveSessionReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsBySessionId: merged };
        }),
        deleteSessionReviewCommentDraft: (sessionId: string, commentId: string) => set((state) => {
            const existing = state.reviewCommentsDraftsBySessionId[sessionId] ?? [];
            const next = existing.filter((d) => d.id !== commentId);
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
            const next = existing.some((d) => d.id === draft.id)
                ? existing.map((d) => (d.id === draft.id ? draft : d))
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
            if (existing.length === 0) return state;
            const next = existing.map((draft) => (
                draft.id === commentId ? { ...draft, includeInPrompt: included } : draft
            ));
            const merged = { ...state.reviewCommentsDraftsByWorkspaceCacheKey, [key]: next };
            reviewCommentsDraftsByWorkspaceCacheKey = merged;
            saveWorkspaceReviewCommentsDrafts(merged, sessionLocalStateScope);
            return { ...state, reviewCommentsDraftsByWorkspaceCacheKey: merged };
        }),
        deleteWorkspaceReviewCommentDraft: (workspaceCacheKey: string, commentId: string) => set((state) => {
            const key = String(workspaceCacheKey ?? '').trim();
            if (!key) return state;
            const existing = state.reviewCommentsDraftsByWorkspaceCacheKey[key] ?? [];
            const next = existing.filter((d) => d.id !== commentId);
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
                    input: { ...(prev.input ?? {}), ...(patch ?? {}) },
                };
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
        getProjects: () => projectManager.getProjects(),
        getProject: (projectId: string) => projectManager.getProject(projectId),
        getProjectForSession: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? projectManager.getProjectForWorkspace(scope) : null;
            }
            ensureProjectManagerSession(sessionId);
            return projectManager.getProjectForSession(sessionId);
        },
        getProjectSessions: (projectId: string) => projectManager.getProjectSessions(projectId),
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
            projectManager.updateSessionProjectScmStatus(sessionId, status);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
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
            const previous = projectManager.getSessionProjectScmSnapshot(sessionId);
            if (areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(previous, snapshot)) {
                return;
            }
            projectManager.updateSessionProjectScmSnapshot(sessionId, snapshot);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
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
            projectManager.updateSessionProjectScmSnapshotError(sessionId, error);
            set((state) => ({ ...state }));
        },
        publishSessionProjectScmSnapshots: (publishes) => {
            // A project SCM refresh publishes to every session sharing the repo. Doing that
            // through the individual snapshot/status/prune actions costs up to six store
            // notifications per session; every notification re-runs all store subscribers,
            // which starves the JS thread on large accounts. All project-manager mutations
            // happen here first, then a single notification covers the whole batch.
            if (publishes.length === 0) return;
            const statusUpdates: Record<string, ScmStatus | null> = {};
            for (const { sessionId, serverId, snapshot, status } of publishes) {
                if (serverId != null) {
                    const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                    if (!scope) continue;
                    const previousSnapshot = projectManager.getWorkspaceScmSnapshot(scope);
                    if (!areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(previousSnapshot, snapshot)) {
                        projectManager.updateWorkspaceScmSnapshot(scope, snapshot);
                    }
                    projectManager.updateWorkspaceScmSnapshotError(scope, null);
                    projectManager.updateWorkspaceScmStatus(scope, status);
                    const activePaths = new Set(snapshot.entries.map((entry) => entry.path));
                    projectManager.pruneWorkspaceScmTouchedPaths(scope, activePaths);
                    projectManager.pruneWorkspaceScmCommitSelectionPaths(scope, activePaths);
                    projectManager.pruneWorkspaceScmCommitSelectionPatches(scope, activePaths);
                    continue;
                }
                ensureProjectManagerSession(sessionId);
                const previousSnapshot = projectManager.getSessionProjectScmSnapshot(sessionId);
                if (!areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(previousSnapshot, snapshot)) {
                    projectManager.updateSessionProjectScmSnapshot(sessionId, snapshot);
                }
                if (projectManager.getSessionProjectScmSnapshotError(sessionId)) {
                    projectManager.updateSessionProjectScmSnapshotError(sessionId, null);
                }
                projectManager.updateSessionProjectScmStatus(sessionId, status);
                const activePaths = new Set(snapshot.entries.map((entry) => entry.path));
                projectManager.pruneWorkspaceScmTouchedPathsForSession(sessionId, activePaths);
                projectManager.pruneSessionProjectScmCommitSelectionPaths(sessionId, activePaths);
                projectManager.pruneSessionProjectScmCommitSelectionPatches(sessionId, activePaths);
                statusUpdates[sessionId] = status;
            }
            set((state) => ({
                ...state,
                sessionScmStatus: {
                    ...state.sessionScmStatus,
                    ...statusUpdates,
                },
            }));
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
            projectManager.markWorkspaceScmTouchedPathsForSession(sessionId, paths);
            set((state) => ({ ...state }));
        },
        pruneWorkspaceScmTouchedPathsForSession: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().pruneWorkspaceScmTouchedPaths(scope, activePaths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            projectManager.pruneWorkspaceScmTouchedPathsForSession(sessionId, activePaths);
            set((state) => ({ ...state }));
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
            projectManager.markSessionProjectScmCommitSelectionPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        unmarkSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[], serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().unmarkWorkspaceScmCommitSelectionPaths(scope, paths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            projectManager.unmarkSessionProjectScmCommitSelectionPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        clearSessionProjectScmCommitSelectionPaths: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().clearWorkspaceScmCommitSelectionPaths(scope) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            projectManager.clearSessionProjectScmCommitSelectionPaths(sessionId);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectScmCommitSelectionPaths: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().pruneWorkspaceScmCommitSelectionPaths(scope, activePaths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            projectManager.pruneSessionProjectScmCommitSelectionPaths(sessionId, activePaths);
            set((state) => ({ ...state }));
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
            projectManager.upsertSessionProjectScmCommitSelectionPatch(sessionId, patchSelection);
            set((state) => ({ ...state }));
        },
        removeSessionProjectScmCommitSelectionPatch: (sessionId: string, path: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().removeWorkspaceScmCommitSelectionPatch(scope, path) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            projectManager.removeSessionProjectScmCommitSelectionPatch(sessionId, path);
            set((state) => ({ ...state }));
        },
        clearSessionProjectScmCommitSelectionPatches: (sessionId: string, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().clearWorkspaceScmCommitSelectionPatches(scope) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            projectManager.clearSessionProjectScmCommitSelectionPatches(sessionId);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectScmCommitSelectionPatches: (sessionId: string, activePaths: Set<string>, serverId?: string | null) => {
            if (serverId != null) {
                const scope = resolveWorkspaceTargetForSessionFromState(get(), { sessionId, serverId });
                return scope ? get().pruneWorkspaceScmCommitSelectionPatches(scope, activePaths) : undefined;
            }
            ensureProjectManagerSession(sessionId);
            projectManager.pruneSessionProjectScmCommitSelectionPatches(sessionId, activePaths);
            set((state) => ({ ...state }));
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
            if (result.started || result.reason === 'operation_in_flight') {
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
            projectManager.updateWorkspaceScmStatus(scope, status);
            set((state) => ({ ...state }));
        },
        getWorkspaceScmSnapshot: (scope) => projectManager.getWorkspaceScmSnapshot(scope),
        getWorkspaceScmSnapshotError: (scope) => projectManager.getWorkspaceScmSnapshotError(scope),
        updateWorkspaceScmSnapshot: (scope, snapshot) => {
            const previous = projectManager.getWorkspaceScmSnapshot(scope);
            if (areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(previous, snapshot)) {
                return;
            }
            projectManager.updateWorkspaceScmSnapshot(scope, snapshot);
            set((state) => ({ ...state }));
        },
        updateWorkspaceScmSnapshotError: (scope, error) => {
            projectManager.updateWorkspaceScmSnapshotError(scope, error);
            set((state) => ({ ...state }));
        },
        getWorkspaceScmTouchedPaths: (scope) => projectManager.getWorkspaceScmTouchedPaths(scope),
        markWorkspaceScmTouchedPaths: (scope, paths, touchedAt) => {
            projectManager.markWorkspaceScmTouchedPaths(scope, paths, touchedAt);
            set((state) => ({ ...state }));
        },
        pruneWorkspaceScmTouchedPaths: (scope, activePaths) => {
            projectManager.pruneWorkspaceScmTouchedPaths(scope, activePaths);
            set((state) => ({ ...state }));
        },
        getWorkspaceScmCommitSelectionPaths: (scope) => projectManager.getWorkspaceScmCommitSelectionPaths(scope),
        markWorkspaceScmCommitSelectionPaths: (scope, paths, selectedAt) => {
            projectManager.markWorkspaceScmCommitSelectionPaths(scope, paths, selectedAt);
            set((state) => ({ ...state }));
        },
        unmarkWorkspaceScmCommitSelectionPaths: (scope, paths) => {
            projectManager.unmarkWorkspaceScmCommitSelectionPaths(scope, paths);
            set((state) => ({ ...state }));
        },
        clearWorkspaceScmCommitSelectionPaths: (scope) => {
            projectManager.clearWorkspaceScmCommitSelectionPaths(scope);
            set((state) => ({ ...state }));
        },
        pruneWorkspaceScmCommitSelectionPaths: (scope, activePaths) => {
            projectManager.pruneWorkspaceScmCommitSelectionPaths(scope, activePaths);
            set((state) => ({ ...state }));
        },
        getWorkspaceScmCommitSelectionPatches: (scope) => projectManager.getWorkspaceScmCommitSelectionPatches(scope),
        upsertWorkspaceScmCommitSelectionPatch: (scope, patchSelection, selectedAt) => {
            projectManager.upsertWorkspaceScmCommitSelectionPatch(scope, patchSelection, selectedAt);
            set((state) => ({ ...state }));
        },
        removeWorkspaceScmCommitSelectionPatch: (scope, path) => {
            projectManager.removeWorkspaceScmCommitSelectionPatch(scope, path);
            set((state) => ({ ...state }));
        },
        clearWorkspaceScmCommitSelectionPatches: (scope) => {
            projectManager.clearWorkspaceScmCommitSelectionPatches(scope);
            set((state) => ({ ...state }));
        },
        pruneWorkspaceScmCommitSelectionPatches: (scope, activePaths) => {
            projectManager.pruneWorkspaceScmCommitSelectionPatches(scope, activePaths);
            set((state) => ({ ...state }));
        },
        getWorkspaceScmOperationLog: (scope) => projectManager.getWorkspaceScmOperationLog(scope),
        appendWorkspaceScmOperation: (scope, entry) => {
            projectManager.appendWorkspaceScmOperation(scope, entry);
            set((state) => ({ ...state }));
        },
        getWorkspaceScmInFlightOperation: (scope) => projectManager.getWorkspaceScmInFlightOperation(scope),
        beginWorkspaceScmOperation: (scope, operation) => {
            const result = projectManager.beginWorkspaceScmOperation(scope, operation);
            if (result.started || result.reason === 'operation_in_flight') {
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
                        serverScope: { serverId, serverName: getServerProfileById(serverId)?.name ?? null },
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
                    removedSessionIds: didDeleteRenderable ? [sessionId] : [],
                },
            );
        }),
    };
}
