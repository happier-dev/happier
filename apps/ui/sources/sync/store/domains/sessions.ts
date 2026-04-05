import type {
    ScmCommitSelectionPatch,
    ScmStatus,
    ScmWorkingSnapshot,
    Machine,
    Session,
} from '../../domains/state/storageTypes';
import type { NormalizedMessage } from '../../typesRaw';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import type { ServerScopedSessionListCache } from '../../domains/session/listing/serverScopedSessionListCache';
import {
    areSessionListRenderablesEqual,
    didSessionListRenderableReachabilityPeerFieldsChange,
    buildSessionListRenderableFromSession,
    didSessionListRenderableProjectGroupingFieldsChange,
    didSessionListRenderableWarmCacheFieldsChange,
    didSessionListRenderableStructuralFieldsChange,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';
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
} from '../../domains/state/persistence';
import {
    resolveWarmCacheAccountScope,
    peekSessionListWarmCacheEntries,
    type SessionListCacheEntryV1,
    saveSessionListWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import { buildSessionListCacheEntriesFromRenderables } from '../../domains/state/warmCacheAdapters';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { isModelMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { parsePermissionIntentAlias, resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import { applyReachableTargetsToSessionListRenderables } from '../buildSessionListViewDataWithServerScope';
import { resolveActiveServerSessionListState } from '../resolveActiveServerSessionListState';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { SessionActionDraftStatus } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import type { StoreGet, StoreSet } from './_shared';
import { areStoredSessionsEqual } from './areStoredSessionsEqual';
import { applyAgentStateUpdateToSessionMessages } from './messages';
import type { SessionMessages } from './messages';
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
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';

type SessionModelMode = NonNullable<Session['modelMode']>;
type ScmOperationLogEntry = import('../../runtime/orchestration/projectManager').ScmProjectOperationLogEntry;
type ScmInFlightOperation = import('../../runtime/orchestration/projectManager').ScmProjectInFlightOperation;
type BeginScmOperationResult = import('../../runtime/orchestration/projectManager').BeginScmProjectOperationResult;
type ProjectScmSnapshotError = import('../../runtime/orchestration/projectManager').ProjectScmSnapshotError;

export type SessionsDomain = {
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: ServerScopedSessionListCache;
    sessionScmStatus: Record<string, ScmStatus | null>;
    sessionLastViewed: Record<string, number>;
    sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]>;
    workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: Record<string, string[]>;
    reviewCommentsDraftsBySessionId: Record<string, ReviewCommentDraft[]>;
    reviewCommentsDraftsByWorkspaceCacheKey: Record<string, ReviewCommentDraft[]>;
    actionDraftsBySessionId: Record<string, SessionActionDraft[]>;
    isDataReady: boolean;

    getActiveSessions: () => Session[];
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    replaceSessionListRenderables: (sessions: SessionListRenderableSession[]) => void;
    applySessionListRenderablePatches: (
        patches: ReadonlyArray<Readonly<{
            sessionId: string;
            patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
        }>>,
    ) => void;
    applyLoaded: () => void;
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
    markSessionViewed: (sessionId: string) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => void;
    upsertSessionReviewCommentDraft: (sessionId: string, draft: ReviewCommentDraft) => void;
    deleteSessionReviewCommentDraft: (sessionId: string, commentId: string) => void;
    clearSessionReviewCommentDrafts: (sessionId: string) => void;
    upsertWorkspaceReviewCommentDraft: (workspaceCacheKey: string, draft: ReviewCommentDraft) => void;
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

let actionDraftIdCounter = 0;
function createActionDraftId(nowMs: number): string {
    actionDraftIdCounter += 1;
    return `action_draft_${nowMs}_${actionDraftIdCounter}`;
}

/**
 * Centralized session online state resolver
 * Returns either "online" (string) or a timestamp (number) for last seen
 */
function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): "online" | number {
    // Session is online if the active flag is true
    return session.active ? "online" : session.activeAt;
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

    return {
        sessions: {},
        sessionListRenderables: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed,
        sessionRepositoryTreeExpandedPathsBySessionId,
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
        reviewCommentsDraftsBySessionId,
        reviewCommentsDraftsByWorkspaceCacheKey,
        actionDraftsBySessionId,
        isDataReady: false,
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
        getSessionRepositoryTreeExpandedPaths: (sessionId: string) => {
            return getSessionRepositoryTreeExpandedPathsForState(get(), sessionId, resolveWorkspaceTargetForSession);
        },
        setSessionRepositoryTreeExpandedPaths: (sessionId: string, paths: string[]) => set((state) => {
            const nextExpansionState = setSessionRepositoryTreeExpandedPathsForState(
                state,
                sessionId,
                paths,
                resolveWorkspaceTargetForSession,
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
                resolveWorkspaceTargetForSession,
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
        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => set((state) => {
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
            let needsSessionListViewDataRebuild = state.sessionListViewData === null;
            let needsProjectManagerUpdate = Object.keys(state.sessions).length === 0;
            let needsReachablePeerReevaluation = false;
            let didAnyWarmCacheRelevantRenderableChange = false;

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Preserve existing draft and permission mode if they exist, or load from saved data
                const hasLoadedSession = state.sessions[session.id] !== undefined;
                const existingDraft = state.sessions[session.id]?.draft;
                const savedDraft = sessionDrafts[session.id];
                const existingPermissionMode = state.sessions[session.id]?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                const existingModelMode = state.sessions[session.id]?.modelMode;
                const savedModelMode = savedModelModes[session.id];
                const existingPermissionModeUpdatedAt = state.sessions[session.id]?.permissionModeUpdatedAt;
                const savedPermissionModeUpdatedAt = savedPermissionModeUpdatedAts[session.id];
                const existingModelModeUpdatedAt = state.sessions[session.id]?.modelModeUpdatedAt;
                const savedModelModeUpdatedAt = savedModelModeUpdatedAts[session.id];
                const existingOptimisticThinkingAt = state.sessions[session.id]?.optimisticThinkingAt ?? null;
                const existingThinkingGraceUntil = state.sessions[session.id]?.thinkingGraceUntil ?? null;

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
                if (presence !== 'online') {
                    mergedThinkingGraceUntil = null;
                    const graceTimeout = thinkingGraceTimeoutBySessionId.get(session.id);
                    if (graceTimeout) {
                        clearTimeout(graceTimeout);
                        thinkingGraceTimeoutBySessionId.delete(session.id);
                    }
                } else if (session.thinking === true) {
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
                    presence,
                    draft: hasLoadedSession
                        ? (existingDraft ?? null)
                        : (savedDraft ?? session.draft ?? null),
                    optimisticThinkingAt: session.thinking === true ? null : existingOptimisticThinkingAt,
                    thinkingGraceUntil: mergedThinkingGraceUntil,
                    permissionMode: mergedPermissionMode,
                    // Preserve local coordination timestamp (not synced to server)
                    permissionModeUpdatedAt: mergedPermissionModeUpdatedAt,
                    modelMode: mergedModelMode,
                    modelModeUpdatedAt: mergedModelModeUpdatedAt,
                };
                const previousSession = state.sessions[session.id];
                const mergedSession = areStoredSessionsEqual(previousSession, nextSession)
                    ? previousSession
                    : nextSession;
                if (mergedSession !== previousSession) {
                    if (mergedSessions === state.sessions) {
                        mergedSessions = { ...state.sessions };
                    }
                    mergedSessions[session.id] = mergedSession;
                }

                const previousRenderable = state.sessionListRenderables?.[session.id];
                const nextRenderableBase = buildSessionListRenderableFromSession(
                    mergedSessions[session.id]!,
                    previousRenderable,
                );
                const nextRenderable = previousRenderable
                    ? preserveSessionListRenderableTransientState(previousRenderable, nextRenderableBase)
                    : nextRenderableBase;
                const mergedRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderable)
                    ? previousRenderable
                    : nextRenderable;
                if (mergedRenderable !== previousRenderable) {
                    if (didSessionListRenderableWarmCacheFieldsChange(previousRenderable, mergedRenderable)) {
                        didAnyWarmCacheRelevantRenderableChange = true;
                    }
                    if (mergedRenderables === state.sessionListRenderables) {
                        mergedRenderables = { ...state.sessionListRenderables };
                    }
                    mergedRenderables[session.id] = mergedRenderable;
                }

                if (!needsSessionListViewDataRebuild) {
                    const nextRenderable = mergedRenderable;
                    if (!previousRenderable || didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable)) {
                        needsSessionListViewDataRebuild = true;
                    }
                }

                if (!needsProjectManagerUpdate) {
                    const nextRenderable = mergedRenderable;
                    if (!previousRenderable || didSessionListRenderableProjectGroupingFieldsChange(previousRenderable, nextRenderable)) {
                        needsProjectManagerUpdate = true;
                    }
                }

                if (!needsReachablePeerReevaluation) {
                    const nextRenderable = mergedRenderable;
                    if (!previousRenderable || didSessionListRenderableReachabilityPeerFieldsChange(previousRenderable, nextRenderable)) {
                        needsReachablePeerReevaluation = true;
                    }
                }
            });

            if (needsReachablePeerReevaluation && (!needsSessionListViewDataRebuild || !needsProjectManagerUpdate)) {
                const previousReachableRenderables = applyReachableTargetsToSessionListRenderables({
                    sessions: state.sessionListRenderables,
                    sessionRecords: state.sessions,
                    machineRecords: state.machines,
                    getProjectForSession: state.getProjectForSession,
                });
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

                    if (
                        !needsSessionListViewDataRebuild
                        && didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable)
                    ) {
                        needsSessionListViewDataRebuild = true;
                    }

                    if (
                        !needsProjectManagerUpdate
                        && didSessionListRenderableProjectGroupingFieldsChange(previousRenderable, nextRenderable)
                    ) {
                        needsProjectManagerUpdate = true;
                    }

                    if (needsSessionListViewDataRebuild && needsProjectManagerUpdate) {
                        break;
                    }
                }
            }

            // Process AgentState updates for sessions that already have messages loaded
            let updatedSessionMessages = state.sessionMessages;

            sessions.forEach(session => {
                const oldSession = state.sessions[session.id];
                const newSession = mergedSessions[session.id];

                // Check if sessionMessages exists AND agentStateVersion is newer
                const existingSessionMessages = updatedSessionMessages[session.id];
                if (existingSessionMessages && newSession.agentState &&
                    (!oldSession || newSession.agentStateVersion > (oldSession.agentStateVersion || 0))) {
                    const updated = applyAgentStateUpdateToSessionMessages({
                        existing: existingSessionMessages,
                        agentState: newSession.agentState,
                    });
                    if (updatedSessionMessages === state.sessionMessages) {
                        updatedSessionMessages = { ...state.sessionMessages };
                    }
                    updatedSessionMessages[session.id] = {
                        ...updated.sessionMessages,
                        isLoaded: existingSessionMessages.isLoaded,
                    };
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

            if (
                mergedSessions === state.sessions
                && mergedRenderables === state.sessionListRenderables
                && updatedSessionMessages === state.sessionMessages
                && !needsSessionListViewDataRebuild
                && !needsProjectManagerUpdate
            ) {
                return state;
            }

            const nextStateBase = {
                ...state,
                sessions: mergedSessions,
                sessionListRenderables: mergedRenderables,
                sessionMessages: updatedSessionMessages,
            };

            if (needsProjectManagerUpdate) {
                const machineMetadataMap = new Map<string, any>();
                Object.values(state.machines).forEach(machine => {
                    if (machine.metadata) {
                        machineMetadataMap.set(machine.id, machine.metadata);
                    }
                });
                const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                projectManager.updateSessions(Object.values(mergedSessions), machineMetadataMap, activeServerId);
            }

            const rebuiltListState = needsSessionListViewDataRebuild
                ? resolveActiveServerSessionListState({
                    state: nextStateBase,
                    shouldRebuild: true,
                })
                : {
                    sessionListViewData: state.sessionListViewData,
                };

            const nextState = {
                ...nextStateBase,
                sessionListViewData: rebuiltListState.sessionListViewData,
            };
            if (didAnyWarmCacheRelevantRenderableChange) {
                saveWarmSessionCacheForState(nextState as SessionsDomain & SessionsDomainDependencies);
            }
            return nextState;
        }),
        replaceSessionListRenderables: (sessions) => set((state) => {
            let nextRenderables = state.sessionListRenderables;
            const incomingIds = new Set<string>();
            const previousRenderableIds = Object.keys(state.sessionListRenderables);
            let didAnyRenderableChange = previousRenderableIds.length !== sessions.length;
            let didAnyWarmCacheRelevantRenderableChange = false;
            let needsSessionListViewDataRebuild = state.sessionListViewData === null;

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

                if (!previousRenderable || nextRenderable !== previousRenderable) {
                    didAnyRenderableChange = true;
                    if (didSessionListRenderableWarmCacheFieldsChange(previousRenderable, nextRenderable)) {
                        didAnyWarmCacheRelevantRenderableChange = true;
                    }
                    if (nextRenderables === state.sessionListRenderables) {
                        nextRenderables = { ...state.sessionListRenderables };
                    }
                    nextRenderables[session.id] = nextRenderable;
                }
            }

            if (!didAnyRenderableChange) {
                return state;
            }

            if (previousRenderableIds.length !== sessions.length) {
                if (nextRenderables === state.sessionListRenderables) {
                    nextRenderables = { ...state.sessionListRenderables };
                }
                for (const sessionId of previousRenderableIds) {
                    if (!incomingIds.has(sessionId)) {
                        delete nextRenderables[sessionId];
                    }
                }
            }

            if (!needsSessionListViewDataRebuild) {
                const nextIds = Object.keys(nextRenderables);
                const previousIds = previousRenderableIds;
                if (previousIds.length !== nextIds.length) {
                    needsSessionListViewDataRebuild = true;
                } else {
                    for (const sessionId of nextIds) {
                        const previousRenderable = state.sessionListRenderables[sessionId];
                        const nextRenderable = nextRenderables[sessionId];
                        if (!previousRenderable || didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable)) {
                            needsSessionListViewDataRebuild = true;
                            break;
                        }
                    }
                }
            }

            const nextStateBase = {
                ...state,
                sessionListRenderables: nextRenderables,
            };
            const rebuiltListState = needsSessionListViewDataRebuild
                ? resolveActiveServerSessionListState({
                    state: nextStateBase as SessionsDomain & SessionsDomainDependencies,
                    shouldRebuild: true,
                })
                : {
                    sessionListViewData: state.sessionListViewData,
                };

            const next = {
                ...nextStateBase,
                sessionListViewData: rebuiltListState.sessionListViewData,
            };
            if (didAnyWarmCacheRelevantRenderableChange) {
                saveWarmSessionCacheForState(next as SessionsDomain & SessionsDomainDependencies);
            }
            return next;
        }),
        applySessionListRenderablePatches: (patches) => set((state) => {
            if (patches.length === 0) {
                return state;
            }

            let nextRenderables = state.sessionListRenderables;
            let needsSessionListViewDataRebuild = state.sessionListViewData === null;
            let didAnyWarmCacheRelevantRenderableChange = false;

            for (const { sessionId, patch } of patches) {
                const previousRenderable = nextRenderables[sessionId];
                if (!previousRenderable) {
                    continue;
                }

                const nextRenderable: SessionListRenderableSession = {
                    ...previousRenderable,
                    ...(patch as Partial<SessionListRenderableSession>),
                    id: previousRenderable.id,
                };

                if (areSessionListRenderablesEqual(previousRenderable, nextRenderable)) {
                    continue;
                }

                if (didSessionListRenderableWarmCacheFieldsChange(previousRenderable, nextRenderable)) {
                    didAnyWarmCacheRelevantRenderableChange = true;
                }

                if (!needsSessionListViewDataRebuild) {
                    if (didSessionListRenderableStructuralFieldsChange(previousRenderable, nextRenderable)) {
                        needsSessionListViewDataRebuild = true;
                    }
                }

                if (nextRenderables === state.sessionListRenderables) {
                    nextRenderables = { ...state.sessionListRenderables };
                }
                nextRenderables[sessionId] = nextRenderable;
            }

            if (nextRenderables === state.sessionListRenderables) {
                return state;
            }

            const nextStateBase = {
                ...state,
                sessionListRenderables: nextRenderables,
            };

            const rebuiltListState = needsSessionListViewDataRebuild
                ? resolveActiveServerSessionListState({
                    state: nextStateBase as SessionsDomain & SessionsDomainDependencies,
                    shouldRebuild: true,
                })
                : {
                    sessionListViewData: state.sessionListViewData,
                };

            const nextState = {
                ...nextStateBase,
                sessionListViewData: rebuiltListState.sessionListViewData,
            };

            if (didAnyWarmCacheRelevantRenderableChange) {
                saveWarmSessionCacheForState(nextState as SessionsDomain & SessionsDomainDependencies);
            }
            return nextState;
        }),
        applyLoaded: () => set((state) => {
            return state;
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

            // Collect all drafts for persistence
            const allDrafts: Record<string, string> = {};
            Object.entries(state.sessions).forEach(([id, sess]) => {
                if (sess.draft) {
                    allDrafts[id] = sess.draft;
                }
            });
            if (normalizedDraft) {
                allDrafts[sessionId] = normalizedDraft;
            } else {
                delete allDrafts[sessionId];
            }

            // Persist drafts
            saveSessionDrafts(allDrafts);
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
            saveSessionReviewCommentsDrafts(merged);
            return { ...state, reviewCommentsDraftsBySessionId: merged };
        }),
        deleteSessionReviewCommentDraft: (sessionId: string, commentId: string) => set((state) => {
            const existing = state.reviewCommentsDraftsBySessionId[sessionId] ?? [];
            const next = existing.filter((d) => d.id !== commentId);
            const merged = { ...state.reviewCommentsDraftsBySessionId };
            if (next.length > 0) merged[sessionId] = next;
            else delete merged[sessionId];
            reviewCommentsDraftsBySessionId = merged;
            saveSessionReviewCommentsDrafts(merged);
            return { ...state, reviewCommentsDraftsBySessionId: merged };
        }),
        clearSessionReviewCommentDrafts: (sessionId: string) => set((state) => {
            if (!(sessionId in state.reviewCommentsDraftsBySessionId)) return state;
            const merged = { ...state.reviewCommentsDraftsBySessionId };
            delete merged[sessionId];
            reviewCommentsDraftsBySessionId = merged;
            saveSessionReviewCommentsDrafts(merged);
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
            saveWorkspaceReviewCommentsDrafts(merged);
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
            saveWorkspaceReviewCommentsDrafts(merged);
            return { ...state, reviewCommentsDraftsByWorkspaceCacheKey: merged };
        }),
        clearWorkspaceReviewCommentDrafts: (workspaceCacheKey: string) => set((state) => {
            const key = String(workspaceCacheKey ?? '').trim();
            if (!key) return state;
            if (!(key in state.reviewCommentsDraftsByWorkspaceCacheKey)) return state;
            const merged = { ...state.reviewCommentsDraftsByWorkspaceCacheKey };
            delete merged[key];
            reviewCommentsDraftsByWorkspaceCacheKey = merged;
            saveWorkspaceReviewCommentsDrafts(merged);
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
                saveSessionActionDrafts(merged);
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
                saveSessionActionDrafts(merged);
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
                saveSessionActionDrafts(merged);
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
                saveSessionActionDrafts(merged);
                return { ...state, actionDraftsBySessionId: merged };
            }),
        clearSessionActionDrafts: (sessionId: string) =>
            set((state) => {
                if (!(sessionId in state.actionDraftsBySessionId)) return state;
                const merged = { ...state.actionDraftsBySessionId };
                delete merged[sessionId];
                actionDraftsBySessionId = merged;
                saveSessionActionDrafts(merged);
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
        markSessionViewed: (sessionId: string) => {
            const now = Date.now();
            sessionLastViewed[sessionId] = now;
            saveSessionLastViewed(sessionLastViewed);
            set((state) => ({
                ...state,
                sessionLastViewed: { ...sessionLastViewed }
            }));
        },
        updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const now = nowServerMs();
            const canonicalMode = (typeof mode === 'string' ? (parsePermissionIntentAlias(mode) as PermissionMode | null) : null) ?? 'default';

            // Update the session with the new permission mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    permissionMode: canonicalMode,
                    // Mark as locally updated so older message-based inference cannot override this selection.
                    // Newer user messages (from any device) will still take over.
                    permissionModeUpdatedAt: now
                }
            };

            const persisted = persistSessionPermissionData(updatedSessions);
            if (persisted) {
                sessionPermissionModes = persisted.modes;
                sessionPermissionModeUpdatedAts = persisted.updatedAts;
            }

            // No need to rebuild sessionListViewData since permission mode doesn't affect the list display
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
	                [sessionId]: {
	                    ...session,
	                    modelMode: effectiveMode,
	                    modelModeUpdatedAt: now,
	                }
	            };

            // Collect all model modes for persistence (only non-default values to save space)
            const allModes: Record<string, SessionModelMode> = {};
            const allUpdatedAts: Record<string, number> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.modelMode && sess.modelMode !== 'default') {
                    allModes[id] = sess.modelMode;
                }
                if (typeof (sess as any).modelModeUpdatedAt === 'number') {
                    allUpdatedAts[id] = (sess as any).modelModeUpdatedAt;
                }
            });

            saveSessionModelModes(allModes);
            saveSessionModelModeUpdatedAts(allUpdatedAts);
            sessionModelModes = allModes as any;
            sessionModelModeUpdatedAts = allUpdatedAts;

            // No need to rebuild sessionListViewData since model mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        // Project management methods
        getProjects: () => projectManager.getProjects(),
        getProject: (projectId: string) => projectManager.getProject(projectId),
        getProjectForSession: (sessionId: string) => projectManager.getProjectForSession(sessionId),
        getProjectSessions: (projectId: string) => projectManager.getProjectSessions(projectId),
        // Project source-control methods
        getProjectScmStatus: (projectId: string) => projectManager.getProjectScmStatus(projectId),
        getSessionProjectScmStatus: (sessionId: string) => projectManager.getSessionProjectScmStatus(sessionId),
        updateSessionProjectScmStatus: (sessionId: string, status: ScmStatus | null) => {
            projectManager.updateSessionProjectScmStatus(sessionId, status);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
        },
        getProjectScmSnapshot: (projectId: string) => projectManager.getProjectScmSnapshot(projectId),
        getProjectScmSnapshotError: (projectId: string) => projectManager.getProjectScmSnapshotError(projectId),
        getSessionProjectScmSnapshot: (sessionId: string) => projectManager.getSessionProjectScmSnapshot(sessionId),
        getSessionProjectScmSnapshotError: (sessionId: string) => projectManager.getSessionProjectScmSnapshotError(sessionId),
        updateSessionProjectScmSnapshot: (sessionId: string, snapshot: ScmWorkingSnapshot | null) => {
            projectManager.updateSessionProjectScmSnapshot(sessionId, snapshot);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
        },
        updateSessionProjectScmSnapshotError: (
            sessionId: string,
            error: import('../../runtime/orchestration/projectManager').ProjectScmSnapshotError | null
        ) => {
            projectManager.updateSessionProjectScmSnapshotError(sessionId, error);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmTouchedPaths: (sessionId: string) => projectManager.getSessionProjectScmTouchedPaths(sessionId),
        markSessionProjectScmTouchedPaths: (sessionId: string, paths: string[]) => {
            projectManager.markSessionProjectScmTouchedPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectScmTouchedPaths: (sessionId: string, activePaths: Set<string>) => {
            projectManager.pruneSessionProjectScmTouchedPaths(sessionId, activePaths);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmCommitSelectionPaths: (sessionId: string) =>
            projectManager.getSessionProjectScmCommitSelectionPaths(sessionId),
        markSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[]) => {
            projectManager.markSessionProjectScmCommitSelectionPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        unmarkSessionProjectScmCommitSelectionPaths: (sessionId: string, paths: string[]) => {
            projectManager.unmarkSessionProjectScmCommitSelectionPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        clearSessionProjectScmCommitSelectionPaths: (sessionId: string) => {
            projectManager.clearSessionProjectScmCommitSelectionPaths(sessionId);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectScmCommitSelectionPaths: (sessionId: string, activePaths: Set<string>) => {
            projectManager.pruneSessionProjectScmCommitSelectionPaths(sessionId, activePaths);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmCommitSelectionPatches: (sessionId: string) =>
            projectManager.getSessionProjectScmCommitSelectionPatches(sessionId),
        upsertSessionProjectScmCommitSelectionPatch: (sessionId: string, patchSelection: ScmCommitSelectionPatch) => {
            projectManager.upsertSessionProjectScmCommitSelectionPatch(sessionId, patchSelection);
            set((state) => ({ ...state }));
        },
        removeSessionProjectScmCommitSelectionPatch: (sessionId: string, path: string) => {
            projectManager.removeSessionProjectScmCommitSelectionPatch(sessionId, path);
            set((state) => ({ ...state }));
        },
        clearSessionProjectScmCommitSelectionPatches: (sessionId: string) => {
            projectManager.clearSessionProjectScmCommitSelectionPatches(sessionId);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectScmCommitSelectionPatches: (sessionId: string, activePaths: Set<string>) => {
            projectManager.pruneSessionProjectScmCommitSelectionPatches(sessionId, activePaths);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmOperationLog: (sessionId: string) => projectManager.getSessionProjectScmOperationLog(sessionId),
        appendSessionProjectScmOperation: (
            sessionId: string,
            entry: Omit<ScmOperationLogEntry, 'id' | 'sessionId'>,
        ) => {
            projectManager.appendSessionProjectScmOperation(sessionId, entry);
            set((state) => ({ ...state }));
        },
        getSessionProjectScmInFlightOperation: (sessionId: string) =>
            projectManager.getSessionProjectScmInFlightOperation(sessionId),
        beginSessionProjectScmOperation: (
            sessionId: string,
            operation: import('../../runtime/orchestration/projectManager').ScmProjectOperationKind,
        ) => {
            const result = projectManager.beginSessionProjectScmOperation(sessionId, operation);
            if (result.started || result.reason === 'operation_in_flight') {
                set((state) => ({ ...state }));
            }
            return result;
        },
        finishSessionProjectScmOperation: (sessionId: string, operationId: string) => {
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
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);
            sessionDrafts = drafts;

            const reviewDrafts = loadSessionReviewCommentsDrafts();
            delete reviewDrafts[sessionId];
            saveSessionReviewCommentsDrafts(reviewDrafts);

            const actionDrafts = loadSessionActionDrafts();
            delete actionDrafts[sessionId];
            saveSessionActionDrafts(actionDrafts);
            
            const modes = loadSessionPermissionModes();
            delete modes[sessionId];
            saveSessionPermissionModes(modes);
            sessionPermissionModes = modes;

            const updatedAts = loadSessionPermissionModeUpdatedAts();
            delete updatedAts[sessionId];
            saveSessionPermissionModeUpdatedAts(updatedAts);
            sessionPermissionModeUpdatedAts = updatedAts;

            const modelModes = loadSessionModelModes();
            delete modelModes[sessionId];
            saveSessionModelModes(modelModes);
            sessionModelModes = modelModes;

            const modelUpdatedAts = loadSessionModelModeUpdatedAts();
            delete modelUpdatedAts[sessionId];
            saveSessionModelModeUpdatedAts(modelUpdatedAts);
            sessionModelModeUpdatedAts = modelUpdatedAts;

            delete sessionLastViewed[sessionId];
            saveSessionLastViewed(sessionLastViewed);
            
            // Rebuild sessionListViewData without the deleted session
            const nextState = {
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
            const rebuiltListState = resolveActiveServerSessionListState({
                state: {
                    ...nextState,
                    sessions: remainingSessions,
                    sessionListRenderables: remainingRenderables,
                } as SessionsDomain & SessionsDomainDependencies,
                shouldRebuild: true,
            });
            const next = {
                ...nextState,
                sessionListViewData: rebuiltListState.sessionListViewData,
            };
            saveWarmSessionCacheForState(next as SessionsDomain & SessionsDomainDependencies);
            return next;
        }),
    };
}
