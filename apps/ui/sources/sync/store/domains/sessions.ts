import type {
    ScmCommitSelectionPatch,
    ScmStatus,
    ScmWorkingSnapshot,
    Machine,
    Session,
} from '../../domains/state/storageTypes';
import type { NormalizedMessage } from '../../typesRaw';
import type { ConcurrentSessionListCacheByServerId } from '../../domains/session/listing/concurrentSessionListCache';
import { readStoredSessionMessagesFromStateLike } from '../../domains/messages/readStoredSessionMessages';
import {
    areSessionListRenderablesEqual,
    buildSessionListRenderableFromSession,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';
import {
    shouldRebuildSessionListIndexForRenderableChange,
    type SessionListIndexRebuildSettings,
} from '../../domains/session/listing/sessionListIndexRebuildImpact';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import { nowServerMs } from '../../runtime/time';
import {
    loadSessionDrafts,
    loadSessionLastViewed,
    loadSessionModelModeUpdatedAts,
    loadSessionModelModes,
    loadSessionPermissionModeUpdatedAts,
    loadSessionPermissionModes,
    loadSessionActionDrafts,
    loadSessionReviewCommentsDrafts,
    loadWorkspaceReviewCommentsDrafts,
    saveSessionDrafts,
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
    saveSessionListWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import { buildSessionListCacheEntriesFromRenderables } from '../../domains/state/warmCacheAdapters';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { syncPerformanceTelemetry } from '../../runtime/syncPerformanceTelemetry';
import { isModelMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import { applyReachableTargetsToSessionListRenderables } from '../../domains/session/listing/applyReachableTargetsToSessionListRenderables';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { SessionActionDraftStatus } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { areScmWorkingSnapshotsEquivalentIgnoringFetchedAt } from '@/scm/sync/snapshotDiff';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    mutateSessionModelModeField,
    mutateSessionPermissionModeField,
} from '@/sync/state/mutators';

import type { StoreGet, StoreSet } from './_shared';
import { areStoredSessionsEqual } from './areStoredSessionsEqual';
import { applyAgentStateUpdateToSessionMessages } from './messages';
import type { SessionMessages } from './messages';
import { finalizeSessionListIndexUpdate } from './sessionListIndexFinalization';
import { resolveSessionListRenderableChangeImpact } from './sessionListRenderableChange';
import { persistSessionModelData } from './sessionModelPersistence';
import { persistSessionPermissionData } from './sessionPermissionPersistence';
import { resolveMergedSessionPermissionMode } from './resolveMergedSessionPermissionMode';
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
import {
    hasTerminalPrimaryTurnStatus,
    resolveSessionRuntimePresenceFields,
} from '@/sync/domains/session/attention/runtimePresentation';

type SessionModelMode = NonNullable<Session['modelMode']>;
type ScmOperationLogEntry = import('../../runtime/orchestration/projectManager').ScmProjectOperationLogEntry;
type ScmInFlightOperation = import('../../runtime/orchestration/projectManager').ScmProjectInFlightOperation;
type BeginScmOperationResult = import('../../runtime/orchestration/projectManager').BeginScmProjectOperationResult;
type ProjectScmSnapshotError = import('../../runtime/orchestration/projectManager').ProjectScmSnapshotError;

type SessionListIndexSettingsSource = Readonly<{
    groupInactiveSessionsByProject?: boolean;
    sessionListActiveGroupingV1?: 'project' | 'date';
    sessionListInactiveGroupingV1?: 'project' | 'date';
    sessionListSectionModeV1?: 'activity' | 'single';
}>;

function resolveSessionListIndexRebuildSettings(
    settings: SessionListIndexSettingsSource,
): SessionListIndexRebuildSettings {
    return {
        groupInactiveSessionsByProject: settings.groupInactiveSessionsByProject === true,
        activeGroupingV1: settings.sessionListActiveGroupingV1,
        inactiveGroupingV1: settings.sessionListInactiveGroupingV1,
        sectionModeV1: settings.sessionListSectionModeV1,
    };
}

export type SessionsDomain = {
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListRowStateByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    sessionScmStatus: Record<string, ScmStatus | null>;
    sessionLastViewed: Record<string, number>;
    sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]>;
    workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: Record<string, string[]>;
    reviewCommentsDraftsBySessionId: Record<string, ReviewCommentDraft[]>;
    reviewCommentsDraftsByWorkspaceCacheKey: Record<string, ReviewCommentDraft[]>;
    actionDraftsBySessionId: Record<string, SessionActionDraft[]>;
    sessionLocalStateScope: ServerAccountScope | null;
    isDataReady: boolean;

    activateSessionLocalStateScope: (scope: ServerAccountScope) => void;
    clearSessionLocalStateScope: () => void;
    getActiveSessions: () => Session[];
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    replaceSessionListRenderables: (sessions: SessionListRenderableSession[]) => void;
    mergeSessionListRenderables: (sessions: SessionListRenderableSession[]) => void;
    applySessionListRenderablePatches: (
        patches: ReadonlyArray<Readonly<{
            sessionId: string;
            patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
        }>>,
    ) => void;
    applyReady: () => void;

    applyScmStatus: (sessionId: string, status: ScmStatus | null) => void;
    getSessionRepositoryTreeExpandedPaths: (sessionId: string) => string[];
    setSessionRepositoryTreeExpandedPaths: (sessionId: string, paths: string[]) => void;
    clearSessionRepositoryTreeExpandedPaths: (sessionId: string) => void;
    getWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase) => string[];
    setWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase, paths: string[]) => void;
    clearWorkspaceRepositoryTreeExpandedPaths: (scope: WorkspaceScopeBase) => void;
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionThinkingGrace: (sessionId: string) => void;
    applySessionTerminalLifecycle: (sessionId: string, turnCompletedAt: number | null) => void;
    markSessionViewed: (sessionId: string) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => void;
    upsertSessionReviewCommentDraft: (sessionId: string, draft: ReviewCommentDraft) => void;
    setSessionReviewCommentDraftIncluded: (sessionId: string, commentId: string, included: boolean) => void;
    deleteSessionReviewCommentDraft: (sessionId: string, commentId: string) => void;
    clearSessionReviewCommentDrafts: (sessionId: string) => void;
    upsertWorkspaceReviewCommentDraft: (workspaceCacheKey: string, draft: ReviewCommentDraft) => void;
    setWorkspaceReviewCommentDraftIncluded: (workspaceCacheKey: string, commentId: string, included: boolean) => void;
    deleteWorkspaceReviewCommentDraft: (workspaceCacheKey: string, commentId: string) => void;
    clearWorkspaceReviewCommentDrafts: (workspaceCacheKey: string) => void;
    createSessionActionDraft: (
        sessionId: string,
        draft: Readonly<{ actionId: string; input?: Record<string, unknown> }>,
    ) => SessionActionDraft;
    updateSessionActionDraftInput: (sessionId: string, draftId: string, patch: Record<string, unknown>) => void;
    setSessionActionDraftStatus: (sessionId: string, draftId: string, status: SessionActionDraftStatus, error?: string | null) => void;
    deleteSessionActionDraft: (sessionId: string, draftId: string) => void;
    clearSessionActionDrafts: (sessionId: string) => void;

    getProjects: () => import('../../runtime/orchestration/projectManager').Project[];
    getProject: (projectId: string) => import('../../runtime/orchestration/projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('../../runtime/orchestration/projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];

    getProjectScmStatus: (projectId: string) => ScmStatus | null;
    getSessionProjectScmStatus: (sessionId: string) => ScmStatus | null;
    updateSessionProjectScmStatus: (sessionId: string, status: ScmStatus | null) => void;
    getProjectScmSnapshot: (projectId: string) => ScmWorkingSnapshot | null;
    getProjectScmSnapshotError: (projectId: string) => ProjectScmSnapshotError | null;
    getSessionProjectScmSnapshot: (sessionId: string) => ScmWorkingSnapshot | null;
    getSessionProjectScmSnapshotError: (sessionId: string) => ProjectScmSnapshotError | null;
    updateSessionProjectScmSnapshot: (sessionId: string, snapshot: ScmWorkingSnapshot | null) => void;
    updateSessionProjectScmSnapshotError: (sessionId: string, error: ProjectScmSnapshotError | null) => void;
    getSessionProjectScmTouchedPaths: (sessionId: string) => string[];
    markSessionProjectScmTouchedPaths: (sessionId: string, paths: string[]) => void;
    pruneSessionProjectScmTouchedPaths: (sessionId: string, activePaths: Set<string>) => void;
    getSessionProjectScmCommitSelectionPaths: (sessionId: string) => string[];
    markSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[]) => void;
    unmarkSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[]) => void;
    clearSessionProjectScmCommitSelectionPaths: (sessionId: string) => void;
    pruneSessionProjectScmCommitSelectionPaths: (sessionId: string, activePaths: Set<string>) => void;
    getSessionProjectScmCommitSelectionPatches: (sessionId: string) => ScmCommitSelectionPatch[];
    upsertSessionProjectScmCommitSelectionPatch: (sessionId: string, patchSelection: ScmCommitSelectionPatch) => void;
    removeSessionProjectScmCommitSelectionPatch: (sessionId: string, path: string) => void;
    clearSessionProjectScmCommitSelectionPatches: (sessionId: string) => void;
    pruneSessionProjectScmCommitSelectionPatches: (sessionId: string, activePaths: Set<string>) => void;
    getSessionProjectScmOperationLog: (sessionId: string) => ScmOperationLogEntry[];
    appendSessionProjectScmOperation: (
        sessionId: string,
        entry: Omit<ScmOperationLogEntry, 'id' | 'sessionId'>,
    ) => void;
    getSessionProjectScmInFlightOperation: (sessionId: string) => ScmInFlightOperation | null;
    beginSessionProjectScmOperation: (
        sessionId: string,
        operation: import('../../runtime/orchestration/projectManager').ScmProjectOperationKind,
    ) => BeginScmOperationResult;
    finishSessionProjectScmOperation: (sessionId: string, operationId: string) => boolean;

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

    deleteSession: (sessionId: string) => void;
};

type SessionsDomainDependencies = {
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, import('../../domains/machines/machineDisplayRenderable').MachineDisplayRenderable>;
    sessionMessages: Record<string, SessionMessages>;
    profile: { id: string };
    // Keep resilient: older settings payloads (or partial boot states) may not yet include this key.
    settings: {
        groupInactiveSessionsByProject?: boolean;
        sessionListActiveGroupingV1?: 'project' | 'date';
        sessionListInactiveGroupingV1?: 'project' | 'date';
        sessionListSectionModeV1?: 'activity' | 'single';
    };
};

// UI-only "optimistic processing" marker.
// Cleared via timers so components don't need to poll time.
const OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS = 15_000;
const optimisticThinkingTimeoutBySessionId = new Map<string, ReturnType<typeof setTimeout>>();

// UI-only "thinking debounce" marker.
// Kept for a short grace period after the session stops streaming, so the UI doesn't flicker
// between "working" and "online" between output chunks.
const SESSION_THINKING_GRACE_TIMEOUT_MS = 3_000;
const thinkingGraceTimeoutBySessionId = new Map<string, ReturnType<typeof setTimeout>>();
const SESSION_LIST_WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS = 1_000;

let actionDraftIdCounter = 0;
function createActionDraftId(nowMs: number): string {
    actionDraftIdCounter += 1;
    return `action_draft_${nowMs}_${actionDraftIdCounter}`;
}

type IncomingSessionApply = Omit<Session, 'presence'> & { presence?: 'online' | number };

function normalizeSessionOrderingNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
}

function isIncomingOrderingTimestampOlder(incoming: unknown, previous: unknown): boolean {
    const incomingNumber = normalizeSessionOrderingNumber(incoming);
    const previousNumber = normalizeSessionOrderingNumber(previous);
    return incomingNumber !== null && previousNumber !== null && incomingNumber < previousNumber;
}

function resolveNonRegressingNumber<T>(incoming: T, previous: unknown): T | number {
    const incomingNumber = normalizeSessionOrderingNumber(incoming);
    const previousNumber = normalizeSessionOrderingNumber(previous);
    if (previousNumber === null) return incoming;
    if (incomingNumber === null || incomingNumber < previousNumber) return previousNumber;
    return incoming;
}

function shouldPreservePreviousTurnProjection(
    previousSession: Session,
    incomingSession: IncomingSessionApply,
): boolean {
    const incomingObservedAt = normalizeSessionOrderingNumber(incomingSession.latestTurnStatusObservedAt);
    const incomingOrderingAt = incomingObservedAt ?? normalizeSessionOrderingNumber(incomingSession.updatedAt);
    const previousObservedAt = normalizeSessionOrderingNumber(previousSession.latestTurnStatusObservedAt);
    if (incomingOrderingAt !== null && previousObservedAt !== null && incomingOrderingAt < previousObservedAt) {
        return true;
    }
    return incomingOrderingAt !== null
        && previousObservedAt !== null
        && incomingOrderingAt === previousObservedAt
        && hasTerminalPrimaryTurnStatus(previousSession.latestTurnStatus)
        && incomingSession.latestTurnStatus === 'in_progress';
}

function resolveOrderedSessionApply(
    previousSession: Session | undefined,
    incomingSession: IncomingSessionApply,
): IncomingSessionApply {
    if (!previousSession) return incomingSession;

    let nextSession: IncomingSessionApply = incomingSession;
    const applyPatch = (patch: Partial<IncomingSessionApply>): void => {
        nextSession = { ...nextSession, ...patch };
    };

    const mergedSeq = resolveNonRegressingNumber(incomingSession.seq, previousSession.seq);
    if (mergedSeq !== incomingSession.seq) {
        applyPatch({ seq: mergedSeq as number });
    }

    const mergedUpdatedAt = resolveNonRegressingNumber(incomingSession.updatedAt, previousSession.updatedAt);
    if (mergedUpdatedAt !== incomingSession.updatedAt) {
        applyPatch({ updatedAt: mergedUpdatedAt as number });
    }

    const mergedMeaningfulActivityAt = resolveNonRegressingNumber(
        incomingSession.meaningfulActivityAt,
        previousSession.meaningfulActivityAt,
    );
    if (mergedMeaningfulActivityAt !== incomingSession.meaningfulActivityAt) {
        applyPatch({ meaningfulActivityAt: mergedMeaningfulActivityAt as Session['meaningfulActivityAt'] });
    }

    const mergedLastTurnCompletedAt = resolveNonRegressingNumber(
        incomingSession.lastTurnCompletedAt,
        previousSession.lastTurnCompletedAt,
    );
    if (mergedLastTurnCompletedAt !== incomingSession.lastTurnCompletedAt) {
        applyPatch({ lastTurnCompletedAt: mergedLastTurnCompletedAt as Session['lastTurnCompletedAt'] });
    }

    if (isIncomingOrderingTimestampOlder(incomingSession.activeAt, previousSession.activeAt)) {
        applyPatch({
            active: previousSession.active,
            activeAt: previousSession.activeAt,
        });
    }

    if (isIncomingOrderingTimestampOlder(incomingSession.thinkingAt, previousSession.thinkingAt)) {
        applyPatch({
            thinking: previousSession.thinking,
            thinkingAt: previousSession.thinkingAt,
        });
    }

    if (shouldPreservePreviousTurnProjection(previousSession, incomingSession)) {
        applyPatch({
            latestTurnId: previousSession.latestTurnId,
            latestTurnStatus: previousSession.latestTurnStatus,
            latestTurnStatusObservedAt: previousSession.latestTurnStatusObservedAt,
        });
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
        );
}

function saveWarmSessionCacheForState(
    state: SessionsDomain & SessionsDomainDependencies,
    previousEntries?: Record<string, SessionListCacheEntryV1>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const accountId = resolveWarmCacheAccountScope(state.profile?.id);
    if (!activeServerId || !accountId) return;
    const previousWarmCacheEntries = previousEntries ?? peekSessionListWarmCacheEntries(activeServerId, accountId) ?? undefined;
    const nextEntries = buildSessionListCacheEntriesFromRenderables(state.sessionListRenderables, previousWarmCacheEntries);
    if (previousWarmCacheEntries && nextEntries === previousWarmCacheEntries) return;
    saveSessionListWarmCacheEntries(
        activeServerId,
        accountId,
        nextEntries,
    );
}

export function createSessionsDomain<S extends SessionsDomain & SessionsDomainDependencies>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): SessionsDomain {
    let sessionLocalStateScope: ServerAccountScope | null = null;
    let sessionDrafts = loadSessionDrafts();
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    let sessionPermissionModeUpdatedAts = loadSessionPermissionModeUpdatedAts();
    let sessionModelModeUpdatedAts = loadSessionModelModeUpdatedAts();
    let sessionLastViewed = loadSessionLastViewed();
    let reviewCommentsDraftsBySessionId = loadSessionReviewCommentsDrafts();
    let reviewCommentsDraftsByWorkspaceCacheKey = loadWorkspaceReviewCommentsDrafts();
    let sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]> = {};
    let workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: Record<string, string[]> = {};
    let actionDraftsBySessionId: Record<string, SessionActionDraft[]> = loadSessionActionDrafts();
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

    const scheduleWarmSessionCacheSave = (): void => {
        if (deferredWarmCacheSaveTimeout) return;
        deferredWarmCacheSaveTimeout = setTimeout(() => {
            deferredWarmCacheSaveTimeout = null;
            saveWarmSessionCacheForState(get());
        }, SESSION_LIST_WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS);
    };
    const hydrateSessionLocalStateScope = (scope: ServerAccountScope) => {
        sessionLocalStateScope = scope;
        sessionDrafts = loadSessionDrafts(scope);
        sessionPermissionModes = loadSessionPermissionModes(scope);
        sessionModelModes = loadSessionModelModes(scope);
        sessionPermissionModeUpdatedAts = loadSessionPermissionModeUpdatedAts(scope);
        sessionModelModeUpdatedAts = loadSessionModelModeUpdatedAts(scope);
        sessionLastViewed = loadSessionLastViewed(scope);
        reviewCommentsDraftsBySessionId = loadSessionReviewCommentsDrafts(scope);
        reviewCommentsDraftsByWorkspaceCacheKey = loadWorkspaceReviewCommentsDrafts(scope);
        actionDraftsBySessionId = loadSessionActionDrafts(scope);
    };
    const resolveWorkspaceTargetForSessionInStore = (sessionId: string) =>
        resolveWorkspaceTargetForSessionFromState(get(), sessionId);
    const ensureProjectManagerSession = (sessionId: string): void => {
        const state = get();
        const session = state.sessions[sessionId];
        if (!session?.metadata?.path) return;

        const machineId = typeof session.metadata.machineId === 'string' ? session.metadata.machineId : '';
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

    return {
        sessions: {},
        sessionListRenderables: {},
        sessionListRowStateByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed,
        sessionRepositoryTreeExpandedPathsBySessionId,
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
        reviewCommentsDraftsBySessionId,
        reviewCommentsDraftsByWorkspaceCacheKey,
        actionDraftsBySessionId,
        sessionLocalStateScope,
        isDataReady: false,
        activateSessionLocalStateScope: (scope) => {
            clearDeferredWarmCacheSave();
            prepareSessionLocalStateScopeForActivation(scope);
            hydrateSessionLocalStateScope(scope);
            set((state) => {
                let nextSessions = state.sessions;
                for (const [sessionId, session] of Object.entries(state.sessions)) {
                    const scopedDraft = sessionDrafts[sessionId] ?? null;
                    const scopedPermissionMode = sessionPermissionModes[sessionId] ?? 'default';
                    const scopedPermissionModeUpdatedAt = sessionPermissionModeUpdatedAts[sessionId] ?? null;
                    const scopedModelMode = sessionModelModes[sessionId] ?? 'default';
                    const scopedModelModeUpdatedAt = sessionModelModeUpdatedAts[sessionId] ?? null;
                    if (
                        session.draft === scopedDraft
                        && session.permissionMode === scopedPermissionMode
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
                        draft: scopedDraft,
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
                    actionDraftsBySessionId: { ...actionDraftsBySessionId },
                    sessionLocalStateScope: scope,
                };
            });
        },
        clearSessionLocalStateScope: () => {
            clearDeferredWarmCacheSave();
            sessionLocalStateScope = null;
            sessionDrafts = {};
            sessionPermissionModes = {};
            sessionModelModes = {};
            sessionPermissionModeUpdatedAts = {};
            sessionModelModeUpdatedAts = {};
            sessionLastViewed = {};
            reviewCommentsDraftsBySessionId = {};
            reviewCommentsDraftsByWorkspaceCacheKey = {};
            actionDraftsBySessionId = {};
            set({
                sessionLastViewed: {},
                reviewCommentsDraftsBySessionId: {},
                reviewCommentsDraftsByWorkspaceCacheKey: {},
                actionDraftsBySessionId: {},
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
            let mergedSessions: Record<string, Session> = state.sessions;
            let mergedRenderables: Record<string, SessionListRenderableSession> = state.sessionListRenderables;
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            let needsSessionListIndexRebuild = Boolean(activeServerId) && (state.sessionListIndexByServerId?.[activeServerId] == null);
            const sessionListIndexSettings = resolveSessionListIndexRebuildSettings(state.settings);
            let needsProjectManagerUpdate = Object.keys(state.sessions).length === 0;
            let needsReachablePeerReevaluation = false;
            let didAnyImmediateWarmCacheRelevantRenderableChange = false;
            let didAnyDeferredWarmCacheRelevantRenderableChange = false;
            let changedSessionCount = 0;
            let changedRenderableCount = 0;
            let reconciledSessionMessageCount = 0;
            let listViewFieldChangeCount = 0;
            let didReachablePeerReevaluation = false;

            measureSessionApplyPhase(
                'sync.store.sessions.apply.merge',
                () => ({ sessions: sessions.length }),
                () => {
            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(incomingSession => {
                const previousSession = state.sessions[incomingSession.id];
                const session = resolveOrderedSessionApply(previousSession, incomingSession);
                // Use centralized resolver for consistent state management
                const presence = session.active ? 'online' : session.activeAt;

                // Preserve existing draft and permission mode if they exist, or load from saved data
                const hasLoadedSession = previousSession !== undefined;
                const existingDraft = previousSession?.draft;
                const savedDraft = sessionDrafts[session.id];
                const existingPermissionMode = previousSession?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                const existingModelMode = previousSession?.modelMode;
                const savedModelMode = savedModelModes[session.id];
                const existingPermissionModeUpdatedAt = previousSession?.permissionModeUpdatedAt;
                const savedPermissionModeUpdatedAt = savedPermissionModeUpdatedAts[session.id];
                const existingModelModeUpdatedAt = previousSession?.modelModeUpdatedAt;
                const savedModelModeUpdatedAt = savedModelModeUpdatedAts[session.id];
                const existingOptimisticThinkingAt = previousSession?.optimisticThinkingAt ?? null;
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
                const incomingLatestReadyEventSeq = typeof session.latestReadyEventSeq === 'number'
                    && Number.isFinite(session.latestReadyEventSeq)
                    ? Math.max(0, Math.trunc(session.latestReadyEventSeq))
                    : null;
                const incomingLatestReadyEventAt = typeof session.latestReadyEventAt === 'number'
                    && Number.isFinite(session.latestReadyEventAt)
                    ? session.latestReadyEventAt
                    : null;

                // CLI may publish a session permission mode in encrypted metadata for local-only starts.
                // This is a fallback signal for when there are no app-sent user messages carrying meta.permissionMode yet.
                const metadataPermission = resolvePermissionIntentFromSessionMetadata(session.metadata);
                const metadataCanonicalPermissionMode = metadataPermission?.intent ?? null;
                const metadataPermissionModeUpdatedAt = metadataPermission?.updatedAt ?? null;

                const basePermissionMode: PermissionMode =
                    (session.permissionMode as any) ||
                    'default';
                const basePermissionModeUpdatedAt =
                    typeof (session as any).permissionModeUpdatedAt === 'number'
                        ? (session as any).permissionModeUpdatedAt
                        : null;

                const mergedPermission = resolveMergedSessionPermissionMode({
                    baseMode: basePermissionMode,
                    baseUpdatedAt: basePermissionModeUpdatedAt,
                    candidates: [
                        { mode: savedPermissionMode, updatedAt: savedPermissionModeUpdatedAt },
                        { mode: existingPermissionMode, updatedAt: existingPermissionModeUpdatedAt },
                        { mode: metadataCanonicalPermissionMode, updatedAt: metadataPermissionModeUpdatedAt },
                    ],
                });

                const mergedPermissionMode = mergedPermission.mode;
                const mergedPermissionModeUpdatedAt = mergedPermission.updatedAt;

                const modelOverride = resolveMetadataStringOverrideV1(session.metadata, 'modelOverrideV1', 'modelId');
                const metadataModelId = modelOverride?.value ?? null;
                const metadataModelUpdatedAt = modelOverride?.updatedAt ?? null;

                let mergedModelMode =
                    existingModelMode ||
                    savedModelMode ||
                    session.modelMode ||
                    'default';

                let mergedModelModeUpdatedAt: number | null =
                    existingModelModeUpdatedAt ??
                    savedModelModeUpdatedAt ??
                    null;

                if (typeof metadataModelId === 'string' && isModelMode(metadataModelId) && typeof metadataModelUpdatedAt === 'number') {
                    const localUpdatedAt = mergedModelModeUpdatedAt ?? 0;
                    if (metadataModelUpdatedAt > localUpdatedAt) {
                        mergedModelMode = metadataModelId as any;
                        mergedModelModeUpdatedAt = metadataModelUpdatedAt;
                    }
                }

                const resolvedAgentId = resolveAgentIdFromFlavor(session.metadata?.flavor);
                if (
                    resolvedAgentId &&
                    mergedModelMode !== 'default' &&
                    !isModelSelectableForSession(resolvedAgentId, session.metadata, mergedModelMode)
                ) {
                    mergedModelMode = 'default';
                    if (typeof mergedModelModeUpdatedAt !== 'number' || !Number.isFinite(mergedModelModeUpdatedAt)) {
                        if (typeof metadataModelUpdatedAt === 'number' && Number.isFinite(metadataModelUpdatedAt)) {
                            mergedModelModeUpdatedAt = metadataModelUpdatedAt;
                        } else {
                            mergedModelModeUpdatedAt = nowServerMs();
                        }
                    }
                }

                let mergedThinkingGraceUntil = existingThinkingGraceUntil;
                if (hasTerminalPrimaryTurnProjection) {
                    mergedThinkingGraceUntil = null;
                    const optimisticTimeout = optimisticThinkingTimeoutBySessionId.get(session.id);
                    if (optimisticTimeout) {
                        clearTimeout(optimisticTimeout);
                        optimisticThinkingTimeoutBySessionId.delete(session.id);
                    }
                    const graceTimeout = thinkingGraceTimeoutBySessionId.get(session.id);
                    if (graceTimeout) {
                        clearTimeout(graceTimeout);
                        thinkingGraceTimeoutBySessionId.delete(session.id);
                    }
                } else if (presence !== 'online') {
                    mergedThinkingGraceUntil = null;
                    const graceTimeout = thinkingGraceTimeoutBySessionId.get(session.id);
                    if (graceTimeout) {
                        clearTimeout(graceTimeout);
                        thinkingGraceTimeoutBySessionId.delete(session.id);
                    }
                } else if (runtimePresence.thinking === true) {
                    mergedThinkingGraceUntil = null;
                    const graceTimeout = thinkingGraceTimeoutBySessionId.get(session.id);
                    if (graceTimeout) {
                        clearTimeout(graceTimeout);
                        thinkingGraceTimeoutBySessionId.delete(session.id);
                    }
                } else if (wasThinking) {
                    mergedThinkingGraceUntil = localNowMs + SESSION_THINKING_GRACE_TIMEOUT_MS;

                    const existingTimeout = thinkingGraceTimeoutBySessionId.get(session.id);
                    if (existingTimeout) {
                        clearTimeout(existingTimeout);
                    }

                    const sessionId = session.id;
                    const expectedThinkingGraceUntil = mergedThinkingGraceUntil;
                    const timeout = setTimeout(() => {
                        thinkingGraceTimeoutBySessionId.delete(sessionId);
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
                    }, SESSION_THINKING_GRACE_TIMEOUT_MS);
                    thinkingGraceTimeoutBySessionId.set(session.id, timeout);
                } else if (typeof mergedThinkingGraceUntil === 'number' && mergedThinkingGraceUntil <= localNowMs) {
                    mergedThinkingGraceUntil = null;
                    const graceTimeout = thinkingGraceTimeoutBySessionId.get(session.id);
                    if (graceTimeout) {
                        clearTimeout(graceTimeout);
                        thinkingGraceTimeoutBySessionId.delete(session.id);
                    }
                }

                const nextSession: Session = {
                    ...session,
                    metadata: preserveSessionRuntimeLocalMetadata(
                        state.sessions[session.id]?.metadata,
                        session.metadata,
                    ),
                    thinking: runtimePresence.thinking,
                    thinkingAt: runtimePresence.thinkingAt,
                    presence,
                    latestReadyEventSeq: incomingLatestReadyEventSeq ?? previousSession?.latestReadyEventSeq ?? null,
                    latestReadyEventAt: incomingLatestReadyEventAt ?? previousSession?.latestReadyEventAt ?? null,
                    draft: hasLoadedSession
                        ? (existingDraft ?? null)
                        : (savedDraft ?? session.draft ?? null),
                    optimisticThinkingAt: runtimePresence.thinking || hasTerminalPrimaryTurnProjection ? null : existingOptimisticThinkingAt,
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

                const previousRenderable = state.sessionListRenderables?.[session.id];
                const nextRenderableBase = buildSessionListRenderableFromSession(
                    mergedSessions[session.id]!,
                    previousRenderable,
                    readStoredSessionMessagesFromStateLike(state.sessionMessages[session.id]),
                );
                const nextRenderable = previousRenderable
                    ? preserveSessionListRenderableTransientState(previousRenderable, nextRenderableBase)
                    : nextRenderableBase;
                const mergedRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderable)
                    ? previousRenderable
                    : nextRenderable;
                const renderableChangeImpact = resolveSessionListRenderableChangeImpact(previousRenderable, mergedRenderable, {
                    sessionListIndexSettings,
                });
                if (mergedRenderable !== previousRenderable) {
                    changedRenderableCount += 1;
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
                    if (mergedRenderables === state.sessionListRenderables) {
                        mergedRenderables = { ...state.sessionListRenderables };
                    }
                    mergedRenderables[session.id] = mergedRenderable;
                }

                if (!needsSessionListIndexRebuild) {
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
                        const previousReachableRenderables = state.sessionListRenderables;
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
                    if (updated.sessionLatestUsage !== undefined) {
                        if (mergedSessions === state.sessions) {
                            mergedSessions = { ...state.sessions };
                        }
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            latestUsage: updated.sessionLatestUsage,
                        };
                    }
                    if (updated.sessionTodos !== undefined) {
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

                    const nextRenderableBase = buildSessionListRenderableFromSession(
                        mergedSessions[session.id]!,
                        currentRenderable,
                        readStoredSessionMessagesFromStateLike(updatedSessionMessages[session.id]),
                    );
                    const nextRenderable = preserveSessionListRenderableTransientState(currentRenderable, nextRenderableBase);
                    const mergedRenderable = areSessionListRenderablesEqual(currentRenderable, nextRenderable)
                        ? currentRenderable
                        : nextRenderable;
                    const renderableChangeImpact = resolveSessionListRenderableChangeImpact(currentRenderable, mergedRenderable, {
                        sessionListIndexSettings,
                    });

                    if (mergedRenderable !== currentRenderable) {
                        changedRenderableCount += 1;
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
                        if (mergedRenderables === state.sessionListRenderables) {
                            mergedRenderables = { ...state.sessionListRenderables };
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

            if (
                mergedSessions === state.sessions
                && mergedRenderables === state.sessionListRenderables
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

            const nextStateBase = {
                ...state,
                sessions: mergedSessions,
                sessionListRenderables: mergedRenderables,
                sessionMessages: updatedSessionMessages,
            };

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
            );
            }),
        ),
        replaceSessionListRenderables: (sessions) => set((state) => {
            let nextRenderables = state.sessionListRenderables;
            const incomingIds = new Set<string>();
            const previousRenderableIds = Object.keys(state.sessionListRenderables);
            let didAnyRenderableChange = previousRenderableIds.length !== sessions.length;
            let changedCount = 0;
            let removedCount = 0;
            let listViewFieldChangeCount = 0;
            let staleMetadataPreservedCount = 0;
            let stalePendingFlagsPreservedCount = 0;
            let didAnyImmediateWarmCacheRelevantRenderableChange = false;
            let didAnyDeferredWarmCacheRelevantRenderableChange = false;
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            let needsSessionListIndexRebuild = Boolean(activeServerId) && (state.sessionListIndexByServerId?.[activeServerId] == null);
            const sessionListIndexSettings = resolveSessionListIndexRebuildSettings(state.settings);

            for (const session of sessions) {
                incomingIds.add(session.id);
                const previousRenderable = state.sessionListRenderables[session.id];
                const nextRenderableWithFallbacks = preserveSessionListRenderableStaleFields(previousRenderable, session);
                const nextRenderableBase = preserveSessionListRenderableTransientState(
                    previousRenderable,
                    nextRenderableWithFallbacks,
                );
                const nextRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderableBase)
                    ? previousRenderable
                    : nextRenderableBase;
                const renderableChangeImpact = resolveSessionListRenderableChangeImpact(previousRenderable, nextRenderable, {
                    sessionListIndexSettings,
                });

                if (didPreserveRenderableMetadata(previousRenderable, session, nextRenderable)) {
                    staleMetadataPreservedCount += 1;
                }
                if (didPreserveRenderablePendingFlags(previousRenderable, session, nextRenderable)) {
                    stalePendingFlagsPreservedCount += 1;
                }

                if (!previousRenderable || nextRenderable !== previousRenderable) {
                    didAnyRenderableChange = true;
                    changedCount += 1;
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
                    if (nextRenderables === state.sessionListRenderables) {
                        nextRenderables = { ...state.sessionListRenderables };
                    }
                    nextRenderables[session.id] = nextRenderable;
                }
            }

            if (!didAnyRenderableChange) {
                // Even if the snapshot returned the same renderables (including the empty list),
                // we still need to build the derived sessionListIndex the first time for the active server.
                // Otherwise the UI can remain stuck in "loading" forever with `sessionListIndexByServerId[active] == null`.
                if (!needsSessionListIndexRebuild) {
                    syncPerformanceTelemetry.count('sync.store.sessions.renderables.replace', {
                        incoming: sessions.length,
                        previous: previousRenderableIds.length,
                        changed: changedCount,
                        removed: removedCount,
                        noop: 1,
                        listRebuild: 0,
                        listViewFieldChanges: 0,
                        staleMetadataPreserved: staleMetadataPreservedCount,
                        stalePendingFlagsPreserved: stalePendingFlagsPreservedCount,
                        warmCacheRelevant: 0,
                    });
                    return state;
                }
            }

            for (const sessionId of previousRenderableIds) {
                if (incomingIds.has(sessionId)) {
                    continue;
                }
                if (nextRenderables === state.sessionListRenderables) {
                    nextRenderables = { ...state.sessionListRenderables };
                }
                delete nextRenderables[sessionId];
                removedCount += 1;
                didAnyImmediateWarmCacheRelevantRenderableChange = true;
            }

            if (!needsSessionListIndexRebuild) {
                const nextIds = Object.keys(nextRenderables);
                const previousIds = previousRenderableIds;
                if (previousIds.length !== nextIds.length) {
                    needsSessionListIndexRebuild = true;
                } else {
                    for (const sessionId of nextIds) {
                        const previousRenderable = state.sessionListRenderables[sessionId];
                        const nextRenderable = nextRenderables[sessionId];
                        if (
                            shouldRebuildSessionListIndexForRenderableChange(
                                previousRenderable,
                                nextRenderable,
                                sessionListIndexSettings,
                            )
                        ) {
                            needsSessionListIndexRebuild = true;
                            break;
                        }
                    }
                }
            }

            syncPerformanceTelemetry.count('sync.store.sessions.renderables.replace', {
                incoming: sessions.length,
                previous: previousRenderableIds.length,
                changed: changedCount,
                removed: removedCount,
                noop: !didAnyRenderableChange && !needsSessionListIndexRebuild ? 1 : 0,
                listRebuild: needsSessionListIndexRebuild ? 1 : 0,
                listViewFieldChanges: listViewFieldChangeCount,
                staleMetadataPreserved: staleMetadataPreservedCount,
                stalePendingFlagsPreserved: stalePendingFlagsPreservedCount,
                warmCacheRelevant: (didAnyImmediateWarmCacheRelevantRenderableChange || didAnyDeferredWarmCacheRelevantRenderableChange) ? 1 : 0,
            });

            const nextStateBase = {
                ...state,
                sessionListRenderables: nextRenderables,
            };

            return finalizeSessionListIndexUpdate(
                state,
                nextStateBase,
                needsSessionListIndexRebuild,
                didAnyImmediateWarmCacheRelevantRenderableChange,
                didAnyDeferredWarmCacheRelevantRenderableChange,
                {
                    indexRebuildEventName: 'sync.store.sessions.renderables.replace.indexRebuild',
                    warmCacheEventName: 'sync.store.sessions.renderables.replace.warmCache',
                    fields: () => ({
                        incoming: sessions.length,
                        changed: changedCount,
                        removed: removedCount,
                        listViewFieldChanges: listViewFieldChangeCount,
                    }),
                },
                {
                    saveImmediately: saveWarmSessionCacheImmediately,
                    scheduleDeferredSave: scheduleWarmSessionCacheSave,
                },
            );
        }),
        mergeSessionListRenderables: (sessions) => set((state) => {
            if (sessions.length === 0) {
                return state;
            }

            let nextRenderables = state.sessionListRenderables;
            const previousRenderableIds = Object.keys(state.sessionListRenderables);
            let didAnyRenderableChange = false;
            let changedCount = 0;
            let listViewFieldChangeCount = 0;
            let staleMetadataPreservedCount = 0;
            let stalePendingFlagsPreservedCount = 0;
            let didAnyImmediateWarmCacheRelevantRenderableChange = false;
            let didAnyDeferredWarmCacheRelevantRenderableChange = false;
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            let needsSessionListIndexRebuild = Boolean(activeServerId) && (state.sessionListIndexByServerId?.[activeServerId] == null);
            const sessionListIndexSettings = resolveSessionListIndexRebuildSettings(state.settings);

            for (const session of sessions) {
                const previousRenderable = state.sessionListRenderables[session.id];
                const nextRenderableWithFallbacks = preserveSessionListRenderableStaleFields(previousRenderable, session);
                const nextRenderableBase = preserveSessionListRenderableTransientState(
                    previousRenderable,
                    nextRenderableWithFallbacks,
                );
                const nextRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderableBase)
                    ? previousRenderable
                    : nextRenderableBase;
                const renderableChangeImpact = resolveSessionListRenderableChangeImpact(previousRenderable, nextRenderable, {
                    sessionListIndexSettings,
                });

                if (didPreserveRenderableMetadata(previousRenderable, session, nextRenderable)) {
                    staleMetadataPreservedCount += 1;
                }
                if (didPreserveRenderablePendingFlags(previousRenderable, session, nextRenderable)) {
                    stalePendingFlagsPreservedCount += 1;
                }

                if (!previousRenderable || nextRenderable !== previousRenderable) {
                    didAnyRenderableChange = true;
                    changedCount += 1;
                    if (renderableChangeImpact.needsSessionListIndexRebuild) {
                        listViewFieldChangeCount += 1;
                        needsSessionListIndexRebuild = true;
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
                    if (nextRenderables === state.sessionListRenderables) {
                        nextRenderables = { ...state.sessionListRenderables };
                    }
                    nextRenderables[session.id] = nextRenderable;
                }
            }

            if (!didAnyRenderableChange && !needsSessionListIndexRebuild) {
                syncPerformanceTelemetry.count('sync.store.sessions.renderables.merge', {
                    incoming: sessions.length,
                    previous: previousRenderableIds.length,
                    changed: changedCount,
                    removed: 0,
                    noop: 1,
                    indexRebuild: 0,
                    listRebuild: 0,
                    listViewFieldChanges: 0,
                    staleMetadataPreserved: staleMetadataPreservedCount,
                    stalePendingFlagsPreserved: stalePendingFlagsPreservedCount,
                    warmCacheRelevant: 0,
                });
                return state;
            }

            syncPerformanceTelemetry.count('sync.store.sessions.renderables.merge', {
                incoming: sessions.length,
                previous: previousRenderableIds.length,
                changed: changedCount,
                removed: 0,
                noop: !didAnyRenderableChange && !needsSessionListIndexRebuild ? 1 : 0,
                indexRebuild: needsSessionListIndexRebuild ? 1 : 0,
                listRebuild: needsSessionListIndexRebuild ? 1 : 0,
                listViewFieldChanges: listViewFieldChangeCount,
                staleMetadataPreserved: staleMetadataPreservedCount,
                stalePendingFlagsPreserved: stalePendingFlagsPreservedCount,
                warmCacheRelevant: (didAnyImmediateWarmCacheRelevantRenderableChange || didAnyDeferredWarmCacheRelevantRenderableChange) ? 1 : 0,
            });

            const nextStateBase = {
                ...state,
                sessionListRenderables: nextRenderables,
            };

            return finalizeSessionListIndexUpdate(
                state,
                nextStateBase,
                needsSessionListIndexRebuild,
                didAnyImmediateWarmCacheRelevantRenderableChange,
                didAnyDeferredWarmCacheRelevantRenderableChange,
                {
                    indexRebuildEventName: 'sync.store.sessions.renderables.merge.indexRebuild',
                    warmCacheEventName: 'sync.store.sessions.renderables.merge.warmCache',
                    fields: () => ({
                        incoming: sessions.length,
                        changed: changedCount,
                        removed: 0,
                        listViewFieldChanges: listViewFieldChangeCount,
                    }),
                },
                {
                    saveImmediately: saveWarmSessionCacheImmediately,
                    scheduleDeferredSave: scheduleWarmSessionCacheSave,
                },
            );
        }),
        applySessionListRenderablePatches: (patches) => set((state) => {
            if (patches.length === 0) {
                return state;
            }

            let nextRenderables = state.sessionListRenderables;
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            let needsSessionListIndexRebuild = Boolean(activeServerId) && (state.sessionListIndexByServerId?.[activeServerId] == null);
            const sessionListIndexSettings = resolveSessionListIndexRebuildSettings(state.settings);
            let didAnyImmediateWarmCacheRelevantRenderableChange = false;
            let didAnyDeferredWarmCacheRelevantRenderableChange = false;
            let changedCount = 0;
            let missingCount = 0;
            let noopPatchCount = 0;
            let listViewFieldChangeCount = 0;

            for (const { sessionId, patch } of patches) {
                const previousRenderable = nextRenderables[sessionId];
                if (!previousRenderable) {
                    missingCount += 1;
                    continue;
                }

                const nextRenderable: SessionListRenderableSession = {
                    ...previousRenderable,
                    ...(patch as Partial<SessionListRenderableSession>),
                    id: previousRenderable.id,
                };

                if (areSessionListRenderablesEqual(previousRenderable, nextRenderable)) {
                    noopPatchCount += 1;
                    continue;
                }

                changedCount += 1;
                const renderableChangeImpact = resolveSessionListRenderableChangeImpact(previousRenderable, nextRenderable, {
                    sessionListIndexSettings,
                });
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

                if (!needsSessionListIndexRebuild) {
                    if (renderableChangeImpact.needsSessionListIndexRebuild) {
                        needsSessionListIndexRebuild = true;
                    }
                }

                if (nextRenderables === state.sessionListRenderables) {
                    nextRenderables = { ...state.sessionListRenderables };
                }
                nextRenderables[sessionId] = nextRenderable;
            }

            syncPerformanceTelemetry.count('sync.store.sessions.renderables.patch', {
                patches: patches.length,
                changed: changedCount,
                noopPatches: noopPatchCount,
                missing: missingCount,
                listRebuild: needsSessionListIndexRebuild ? 1 : 0,
                listViewFieldChanges: listViewFieldChangeCount,
                warmCacheRelevant: (didAnyImmediateWarmCacheRelevantRenderableChange || didAnyDeferredWarmCacheRelevantRenderableChange) ? 1 : 0,
            });

            if (nextRenderables === state.sessionListRenderables) {
                if (!needsSessionListIndexRebuild) {
                    return state;
                }
            }

            const nextStateBase = {
                ...state,
                sessionListRenderables: nextRenderables,
            };

            return finalizeSessionListIndexUpdate(
                state,
                nextStateBase,
                needsSessionListIndexRebuild,
                false,
                didAnyImmediateWarmCacheRelevantRenderableChange || didAnyDeferredWarmCacheRelevantRenderableChange,
                {
                    indexRebuildEventName: 'sync.store.sessions.renderables.patch.indexRebuild',
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
            );
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
        updateSessionDraft: (sessionId: string, draft: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            // Don't store empty strings, convert to null
            const normalizedDraft = draft?.trim() ? draft : null;

            // Preserve drafts for sessions that have not been materialized into this store slice yet.
            const allDrafts: Record<string, string> = { ...sessionDrafts };
            Object.entries(state.sessions).forEach(([id, sess]) => {
                if (sess.draft?.trim()) {
                    allDrafts[id] = sess.draft;
                } else {
                    delete allDrafts[id];
                }
            });
            if (normalizedDraft) {
                allDrafts[sessionId] = normalizedDraft;
            } else {
                delete allDrafts[sessionId];
            }

            // Persist drafts
            saveSessionDrafts(allDrafts, sessionLocalStateScope);
            sessionDrafts = allDrafts;

            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    draft: normalizedDraft
                }
            };

            return {
                ...state,
                sessions: updatedSessions,
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

        createSessionActionDraft: (sessionId: string, draft) => {
            const nowMs = nowServerMs();
            const created: SessionActionDraft = {
                id: createActionDraftId(nowMs),
                sessionId,
                actionId: String(draft.actionId),
                createdAt: nowMs,
                status: 'editing',
                input: { ...(draft.input ?? {}) },
                error: null,
            };
            set((state) => {
                const existing = state.actionDraftsBySessionId[sessionId] ?? [];
                const next = [...existing, created];
                const merged = { ...state.actionDraftsBySessionId, [sessionId]: next };
                actionDraftsBySessionId = merged;
                saveSessionActionDrafts(merged, sessionLocalStateScope);
                return { ...state, actionDraftsBySessionId: merged };
            });
            return created;
        },
        updateSessionActionDraftInput: (sessionId: string, draftId: string, patch: Record<string, unknown>) =>
            set((state) => {
                const existing = state.actionDraftsBySessionId[sessionId] ?? [];
                const idx = existing.findIndex((d) => d.id === draftId);
                if (idx < 0) return state;
                const prev = existing[idx]!;
                const updated: SessionActionDraft = {
                    ...prev,
                    input: { ...(prev.input ?? {}), ...(patch ?? {}) },
                };
                const next = [...existing.slice(0, idx), updated, ...existing.slice(idx + 1)];
                const merged = { ...state.actionDraftsBySessionId, [sessionId]: next };
                actionDraftsBySessionId = merged;
                saveSessionActionDrafts(merged, sessionLocalStateScope);
                return { ...state, actionDraftsBySessionId: merged };
            }),
        setSessionActionDraftStatus: (sessionId: string, draftId: string, status: SessionActionDraftStatus, error?: string | null) =>
            set((state) => {
                const existing = state.actionDraftsBySessionId[sessionId] ?? [];
                const idx = existing.findIndex((d) => d.id === draftId);
                if (idx < 0) return state;
                const prev = existing[idx]!;
                const updated: SessionActionDraft = {
                    ...prev,
                    status,
                    ...(typeof error !== 'undefined' ? { error: error ?? null } : {}),
                };
                const next = [...existing.slice(0, idx), updated, ...existing.slice(idx + 1)];
                const merged = { ...state.actionDraftsBySessionId, [sessionId]: next };
                actionDraftsBySessionId = merged;
                saveSessionActionDrafts(merged, sessionLocalStateScope);
                return { ...state, actionDraftsBySessionId: merged };
            }),
        deleteSessionActionDraft: (sessionId: string, draftId: string) =>
            set((state) => {
                const existing = state.actionDraftsBySessionId[sessionId] ?? [];
                const next = existing.filter((d) => d.id !== draftId);
                const merged = { ...state.actionDraftsBySessionId };
                if (next.length > 0) merged[sessionId] = next;
                else delete merged[sessionId];
                actionDraftsBySessionId = merged;
                saveSessionActionDrafts(merged, sessionLocalStateScope);
                return { ...state, actionDraftsBySessionId: merged };
            }),
        clearSessionActionDrafts: (sessionId: string) =>
            set((state) => {
                if (!(sessionId in state.actionDraftsBySessionId)) return state;
                const merged = { ...state.actionDraftsBySessionId };
                delete merged[sessionId];
                actionDraftsBySessionId = merged;
                saveSessionActionDrafts(merged, sessionLocalStateScope);
                return { ...state, actionDraftsBySessionId: merged };
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

            const existingTimeout = optimisticThinkingTimeoutBySessionId.get(sessionId);
            if (existingTimeout) {
                clearTimeout(existingTimeout);
            }
            const timeout = setTimeout(() => {
                optimisticThinkingTimeoutBySessionId.delete(sessionId);
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
            }, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS);
            optimisticThinkingTimeoutBySessionId.set(sessionId, timeout);

            return {
                ...state,
                sessions: nextSessions,
            };
        }),
        clearSessionOptimisticThinking: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            if (!session.optimisticThinkingAt) return state;

            const existingTimeout = optimisticThinkingTimeoutBySessionId.get(sessionId);
            if (existingTimeout) {
                clearTimeout(existingTimeout);
                optimisticThinkingTimeoutBySessionId.delete(sessionId);
            }

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
        clearSessionThinkingGrace: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            if ((session.thinkingGraceUntil ?? null) === null) return state;

            const existingTimeout = thinkingGraceTimeoutBySessionId.get(sessionId);
            if (existingTimeout) {
                clearTimeout(existingTimeout);
                thinkingGraceTimeoutBySessionId.delete(sessionId);
            }

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
        applySessionTerminalLifecycle: (sessionId: string, turnCompletedAt: number | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const existingOptimisticTimeout = optimisticThinkingTimeoutBySessionId.get(sessionId);
            if (existingOptimisticTimeout) {
                clearTimeout(existingOptimisticTimeout);
                optimisticThinkingTimeoutBySessionId.delete(sessionId);
            }

            const existingGraceTimeout = thinkingGraceTimeoutBySessionId.get(sessionId);
            if (existingGraceTimeout) {
                clearTimeout(existingGraceTimeout);
                thinkingGraceTimeoutBySessionId.delete(sessionId);
            }

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
	        updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => set((state) => {
	            const session = state.sessions[sessionId];
	            if (!session) return state;
	
	            const now = nowServerMs();
                const normalized = typeof mode === 'string' ? mode.trim() : '';
                const candidate: SessionModelMode = (normalized || 'default') as any;
                const resolvedAgentId = resolveAgentIdFromFlavor(session.metadata?.flavor);
                const effectiveMode: SessionModelMode =
                    resolvedAgentId && candidate !== 'default' && !isModelSelectableForSession(resolvedAgentId, session.metadata, candidate)
                        ? 'default'
                        : candidate;
	
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
        getProjectForSession: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getProjectForSession(sessionId);
        },
        getProjectSessions: (projectId: string) => projectManager.getProjectSessions(projectId),
        // Project source-control methods
        getProjectScmStatus: (projectId: string) => projectManager.getProjectScmStatus(projectId),
        getSessionProjectScmStatus: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmStatus(sessionId);
        },
        updateSessionProjectScmStatus: (sessionId: string, status: ScmStatus | null) => {
            ensureProjectManagerSession(sessionId);
            projectManager.updateSessionProjectScmStatus(sessionId, status);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
        },
        getProjectScmSnapshot: (projectId: string) => projectManager.getProjectScmSnapshot(projectId),
        getProjectScmSnapshotError: (projectId: string) => projectManager.getProjectScmSnapshotError(projectId),
        getSessionProjectScmSnapshot: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmSnapshot(sessionId);
        },
        getSessionProjectScmSnapshotError: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmSnapshotError(sessionId);
        },
        updateSessionProjectScmSnapshot: (sessionId: string, snapshot: ScmWorkingSnapshot | null) => {
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
            error: import('../../runtime/orchestration/projectManager').ProjectScmSnapshotError | null
        ) => {
            ensureProjectManagerSession(sessionId);
            projectManager.updateSessionProjectScmSnapshotError(sessionId, error);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmTouchedPaths: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmTouchedPaths(sessionId);
        },
        markSessionProjectScmTouchedPaths: (sessionId: string, paths: string[]) => {
            ensureProjectManagerSession(sessionId);
            projectManager.markSessionProjectScmTouchedPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectScmTouchedPaths: (sessionId: string, activePaths: Set<string>) => {
            ensureProjectManagerSession(sessionId);
            projectManager.pruneSessionProjectScmTouchedPaths(sessionId, activePaths);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmCommitSelectionPaths: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmCommitSelectionPaths(sessionId);
        },
        markSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[]) => {
            ensureProjectManagerSession(sessionId);
            projectManager.markSessionProjectScmCommitSelectionPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        unmarkSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[]) => {
            ensureProjectManagerSession(sessionId);
            projectManager.unmarkSessionProjectScmCommitSelectionPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        clearSessionProjectScmCommitSelectionPaths: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            projectManager.clearSessionProjectScmCommitSelectionPaths(sessionId);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectScmCommitSelectionPaths: (sessionId: string, activePaths: Set<string>) => {
            ensureProjectManagerSession(sessionId);
            projectManager.pruneSessionProjectScmCommitSelectionPaths(sessionId, activePaths);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmCommitSelectionPatches: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmCommitSelectionPatches(sessionId);
        },
        upsertSessionProjectScmCommitSelectionPatch: (sessionId: string, patchSelection: ScmCommitSelectionPatch) => {
            ensureProjectManagerSession(sessionId);
            projectManager.upsertSessionProjectScmCommitSelectionPatch(sessionId, patchSelection);
            set((state) => ({ ...state }));
        },
        removeSessionProjectScmCommitSelectionPatch: (sessionId: string, path: string) => {
            ensureProjectManagerSession(sessionId);
            projectManager.removeSessionProjectScmCommitSelectionPatch(sessionId, path);
            set((state) => ({ ...state }));
        },
        clearSessionProjectScmCommitSelectionPatches: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            projectManager.clearSessionProjectScmCommitSelectionPatches(sessionId);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectScmCommitSelectionPatches: (sessionId: string, activePaths: Set<string>) => {
            ensureProjectManagerSession(sessionId);
            projectManager.pruneSessionProjectScmCommitSelectionPatches(sessionId, activePaths);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmOperationLog: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmOperationLog(sessionId);
        },
        appendSessionProjectScmOperation: (
            sessionId: string,
            entry: Omit<ScmOperationLogEntry, 'id' | 'sessionId'>,
        ) => {
            ensureProjectManagerSession(sessionId);
            projectManager.appendSessionProjectScmOperation(sessionId, entry);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmInFlightOperation: (sessionId: string) => {
            ensureProjectManagerSession(sessionId);
            return projectManager.getSessionProjectScmInFlightOperation(sessionId);
        },
        beginSessionProjectScmOperation: (
            sessionId: string,
            operation: import('../../runtime/orchestration/projectManager').ScmProjectOperationKind,
        ) => {
            ensureProjectManagerSession(sessionId);
            const result = projectManager.beginSessionProjectScmOperation(sessionId, operation);
            if (result.started || result.reason === 'operation_in_flight') {
                set((state) => ({ ...state }));
            }
            return result;
        },
        finishSessionProjectScmOperation: (sessionId: string, operationId: string) => {
            ensureProjectManagerSession(sessionId);
            const finished = projectManager.finishSessionProjectScmOperation(sessionId, operationId);
            if (finished) {
                set((state) => ({ ...state }));
            }
            return finished;
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
        deleteSession: (sessionId: string) => set((state) => {
            const optimisticTimeout = optimisticThinkingTimeoutBySessionId.get(sessionId);
            if (optimisticTimeout) {
                clearTimeout(optimisticTimeout);
                optimisticThinkingTimeoutBySessionId.delete(sessionId);
            }

            const graceTimeout = thinkingGraceTimeoutBySessionId.get(sessionId);
            if (graceTimeout) {
                clearTimeout(graceTimeout);
                thinkingGraceTimeoutBySessionId.delete(sessionId);
            }

            // Remove session from sessions
            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;
            const { [sessionId]: _deletedRenderable, ...remainingRenderables } = state.sessionListRenderables;

            // Remove session messages if they exist
            const { [sessionId]: deletedMessages, ...remainingSessionMessages } = state.sessionMessages;

            // Remove session source-control status if it exists
            const { [sessionId]: _deletedScmStatus, ...remainingScmStatus } = state.sessionScmStatus;
            const nextTreeExpansionState = deleteSessionRepositoryTreeExpansionForState(state, sessionId);
            sessionRepositoryTreeExpandedPathsBySessionId =
                nextTreeExpansionState.sessionRepositoryTreeExpandedPathsBySessionId;
            workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey =
                nextTreeExpansionState.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
            const { [sessionId]: _deletedReviewDrafts, ...remainingReviewDrafts } = state.reviewCommentsDraftsBySessionId;
            reviewCommentsDraftsBySessionId = remainingReviewDrafts;
            const { [sessionId]: _deletedActionDrafts, ...remainingActionDrafts } = state.actionDraftsBySessionId;
            actionDraftsBySessionId = remainingActionDrafts;

            // Clear drafts and permission modes from persistent storage
            const drafts = loadSessionDrafts(sessionLocalStateScope);
            delete drafts[sessionId];
            saveSessionDrafts(drafts, sessionLocalStateScope);
            sessionDrafts = drafts;

            const reviewDrafts = loadSessionReviewCommentsDrafts(sessionLocalStateScope);
            delete reviewDrafts[sessionId];
            saveSessionReviewCommentsDrafts(reviewDrafts, sessionLocalStateScope);

            const actionDrafts = loadSessionActionDrafts(sessionLocalStateScope);
            delete actionDrafts[sessionId];
            saveSessionActionDrafts(actionDrafts, sessionLocalStateScope);
            
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

            const nextStateBase = {
                ...state,
                sessions: remainingSessions,
                sessionListRenderables: remainingRenderables,
                sessionMessages: remainingSessionMessages,
                sessionScmStatus: remainingScmStatus,
                ...nextTreeExpansionState,
                reviewCommentsDraftsBySessionId: remainingReviewDrafts,
                actionDraftsBySessionId: remainingActionDrafts,
                sessionLastViewed: { ...sessionLastViewed },
            };

            return finalizeSessionListIndexUpdate(
                state,
                nextStateBase,
                true,
                true,
                false,
            );
        }),
    };
}
