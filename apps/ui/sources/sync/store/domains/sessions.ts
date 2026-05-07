import type {
    ScmCommitSelectionPatch,
    ScmStatus,
    ScmWorkingSnapshot,
    Machine,
    Session,
} from '../../domains/state/storageTypes';
import type { NormalizedMessage } from '../../typesRaw';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import { readStoredSessionMessagesFromStateLike } from '../../domains/messages/readStoredSessionMessages';
import {
    areSessionListRenderablesEqual,
    buildSessionListRenderableFromSession,
    didSessionListRenderableProjectGroupingFieldsChange,
    didSessionListRenderableReachabilityPeerFieldsChange,
    didSessionListRenderableStructuralFieldsChange,
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
    prepareSessionLocalStateScopeForActivation,
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
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    resolveWarmCacheAccountScope,
    type SessionListCacheEntryV1,
    saveSessionListWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import {
    buildSessionListCacheEntryFromRenderable,
    buildSessionListCacheEntriesFromRenderables,
} from '../../domains/state/warmCacheAdapters';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { syncPerformanceTelemetry } from '../../runtime/syncPerformanceTelemetry';
import { isModelMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { parsePermissionIntentAlias, resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import {
    applyReachableTargetsToSessionListRenderables,
    buildSessionListViewDataWithServerScope,
} from '../buildSessionListViewDataWithServerScope';
import { setActiveServerSessionListCache } from '../sessionListCache';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { SessionActionDraftStatus } from '@/sync/domains/sessionActions/sessionActionDraftTypes';

import type { StoreGet, StoreSet } from './_shared';
import { areStoredSessionsEqual } from './areStoredSessionsEqual';
import { applyAgentStateUpdateToSessionMessages } from './messages';
import type { SessionMessages } from './messages';
import { persistSessionPermissionData } from './sessionPermissionPersistence';
import { resolveMergedSessionPermissionMode } from './resolveMergedSessionPermissionMode';
import {
    planSessionListRenderablePatches,
    planSessionListRenderableReplacement,
} from './sessionListRenderableStoreUpdate';

type SessionModelMode = NonNullable<Session['modelMode']>;
type ScmOperationLogEntry = import('../../runtime/orchestration/projectManager').ScmProjectOperationLogEntry;
type ScmInFlightOperation = import('../../runtime/orchestration/projectManager').ScmProjectInFlightOperation;
type BeginScmOperationResult = import('../../runtime/orchestration/projectManager').BeginScmProjectOperationResult;
type ProjectScmSnapshotError = import('../../runtime/orchestration/projectManager').ProjectScmSnapshotError;

function applyReachableSessionListRenderablesForState(input: Readonly<{
    sessions: Record<string, SessionListRenderableSession>;
    sessionRecords: Record<string, Session>;
    machineDisplays: SessionsDomainDependencies['machineDisplayById'];
    machineRecords: SessionsDomainDependencies['machines'];
    getProjectForSession?: SessionsDomain['getProjectForSession'];
}>): Record<string, SessionListRenderableSession> {
    return applyReachableTargetsToSessionListRenderables({
        sessions: input.sessions,
        sessionRecords: input.sessionRecords,
        machines: input.machineDisplays,
        machineRecords: input.machineRecords,
        getProjectForSession: input.getProjectForSession,
    });
}

export type SessionsDomain = {
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionsData: (string | Session)[] | null;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
    sessionScmStatus: Record<string, ScmStatus | null>;
    sessionLastViewed: Record<string, number>;
    sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]>;
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
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionThinkingGrace: (sessionId: string) => void;
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

function measureSessionApplyPhase<T>(
    name: string,
    fields: () => Record<string, number>,
    fn: () => T,
): T {
    if (!syncPerformanceTelemetry.isEnabled()) return fn();
    return syncPerformanceTelemetry.measure(name, fields(), fn);
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
    const nextEntries = buildSessionListCacheEntriesFromRenderables(state.sessionListRenderables ?? {}, previousEntries);
    if (previousEntries && nextEntries === previousEntries) return;
    saveSessionListWarmCacheEntries(
        activeServerId,
        accountId,
        nextEntries,
    );
}

function buildSessionListViewDataForState(state: SessionsDomain & SessionsDomainDependencies): SessionListViewItem[] {
    return buildSessionListViewDataWithServerScope({
        sessions: state.sessionListRenderables ?? {},
        sessionRecords: state.sessions ?? {},
        machines: state.machineDisplayById ?? {},
        machineRecords: state.machines ?? {},
        groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
        activeGroupingV1: state.settings.sessionListActiveGroupingV1,
        inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
        getProjectForSession: state.getProjectForSession,
    });
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
    let actionDraftsBySessionId: Record<string, SessionActionDraft[]> = loadSessionActionDrafts();

    const stripLocalSessionFields = (session: Session): Session => ({
        ...session,
        draft: null,
        permissionMode: null,
        permissionModeUpdatedAt: undefined,
        modelMode: undefined,
        modelModeUpdatedAt: undefined,
    });

    const applyLocalSessionFields = (session: Session): Session => ({
        ...stripLocalSessionFields(session),
        draft: sessionDrafts[session.id] ?? null,
        ...(sessionPermissionModes[session.id]
            ? {
                permissionMode: sessionPermissionModes[session.id],
                permissionModeUpdatedAt: sessionPermissionModeUpdatedAts[session.id],
            }
            : {}),
        ...(sessionModelModes[session.id]
            ? {
                modelMode: sessionModelModes[session.id],
                modelModeUpdatedAt: sessionModelModeUpdatedAts[session.id],
            }
            : {}),
    });

    const rebuildSessionsForActiveLocalState = (sessions: Record<string, Session>): Record<string, Session> => {
        let changed = false;
        const next: Record<string, Session> = {};
        Object.entries(sessions).forEach(([id, session]) => {
            const updated = applyLocalSessionFields(session);
            next[id] = updated;
            if (updated !== session) changed = true;
        });
        return changed ? next : sessions;
    };

    const hydrateSessionLocalState = (scope: ServerAccountScope | null): void => {
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

    const ensureProjectManagerSession = (sessionId: string): void => {
        const state = get();
        const session = state.sessions[sessionId];
        if (!session?.metadata?.path) return;

        const machineId = typeof session.metadata.machineId === 'string' ? session.metadata.machineId : '';
        const machineMetadata = machineId ? state.machines[machineId]?.metadata ?? null : undefined;
        projectManager.addSession(session, machineMetadata);
    };

    return {
        sessions: {},
        sessionListRenderables: {},
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed,
        sessionRepositoryTreeExpandedPathsBySessionId,
        reviewCommentsDraftsBySessionId,
        reviewCommentsDraftsByWorkspaceCacheKey,
        actionDraftsBySessionId,
        sessionLocalStateScope,
        isDataReady: false,
        activateSessionLocalStateScope: (scope) => {
            prepareSessionLocalStateScopeForActivation(scope);
            hydrateSessionLocalState(scope);
            set((state) => ({
                ...state,
                sessionLocalStateScope: scope,
                sessions: rebuildSessionsForActiveLocalState(state.sessions),
                sessionLastViewed: { ...sessionLastViewed },
                reviewCommentsDraftsBySessionId: { ...reviewCommentsDraftsBySessionId },
                reviewCommentsDraftsByWorkspaceCacheKey: { ...reviewCommentsDraftsByWorkspaceCacheKey },
                actionDraftsBySessionId: { ...actionDraftsBySessionId },
            }));
        },
        clearSessionLocalStateScope: () => {
            hydrateSessionLocalState(null);
            sessionDrafts = {};
            sessionPermissionModes = {};
            sessionModelModes = {};
            sessionPermissionModeUpdatedAts = {};
            sessionModelModeUpdatedAts = {};
            sessionLastViewed = {};
            reviewCommentsDraftsBySessionId = {};
            reviewCommentsDraftsByWorkspaceCacheKey = {};
            actionDraftsBySessionId = {};
            set((state) => {
                const strippedSessions: Record<string, Session> = {};
                Object.entries(state.sessions).forEach(([id, session]) => {
                    strippedSessions[id] = stripLocalSessionFields(session);
                });
                return {
                    ...state,
                    sessionLocalStateScope: null,
                    sessions: strippedSessions,
                    sessionLastViewed: {},
                    reviewCommentsDraftsBySessionId: {},
                    reviewCommentsDraftsByWorkspaceCacheKey: {},
                    actionDraftsBySessionId: {},
                };
            });
        },
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
        getSessionRepositoryTreeExpandedPaths: (sessionId: string) => {
            const state = get();
            return state.sessionRepositoryTreeExpandedPathsBySessionId[sessionId] ?? [];
        },
        setSessionRepositoryTreeExpandedPaths: (sessionId: string, paths: string[]) => set((state) => {
            const next = {
                ...state.sessionRepositoryTreeExpandedPathsBySessionId,
                [sessionId]: paths,
            };
            sessionRepositoryTreeExpandedPathsBySessionId = next;
            return { ...state, sessionRepositoryTreeExpandedPathsBySessionId: next };
        }),
        clearSessionRepositoryTreeExpandedPaths: (sessionId: string) => set((state) => {
            if (!(sessionId in state.sessionRepositoryTreeExpandedPathsBySessionId)) return state;
            const { [sessionId]: _removed, ...rest } = state.sessionRepositoryTreeExpandedPathsBySessionId;
            sessionRepositoryTreeExpandedPathsBySessionId = rest;
            return { ...state, sessionRepositoryTreeExpandedPathsBySessionId: rest };
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
            let updatedSessionMessages = state.sessionMessages;
            let needsSessionListViewDataRebuild = state.sessionListViewData === null;
            let needsProjectManagerUpdate = Object.keys(state.sessions).length === 0;
            let changedSessionCount = 0;
            let changedRenderableCount = 0;
            let reconciledSessionMessageCount = 0;
            let needsReachablePeerReevaluation = false;
            let didReachablePeerReevaluation = false;
            let didWarmCacheRelevantRenderableChange = false;
            let listViewFieldChangeCount = 0;

            measureSessionApplyPhase(
                'sync.store.sessions.apply.merge',
                () => ({ sessions: sessions.length }),
                () => {
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
                    changedSessionCount += 1;
                    if (mergedSessions === state.sessions) {
                        mergedSessions = { ...state.sessions };
                    }
                    mergedSessions[session.id] = mergedSession;
                }

                const existingSessionMessages = updatedSessionMessages[session.id];
                let renderableMessages = existingSessionMessages
                    ? readStoredSessionMessagesFromStateLike(existingSessionMessages)
                    : undefined;

                if (existingSessionMessages && mergedSessions[session.id]!.agentState) {
                    // Session message cache can outlive a page reload and keep locally synthesized
                    // "Request interrupted" placeholders even when the backend request is still live.
                    // Reconcile loaded transcript state from AgentState on every snapshot so the cache
                    // stays aligned even when agentStateVersion is unchanged across reload.
                    const updated = applyAgentStateUpdateToSessionMessages({
                        existing: existingSessionMessages,
                        agentState: mergedSessions[session.id]!.agentState,
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
                        renderableMessages = readStoredSessionMessagesFromStateLike(updatedSessionMessages[session.id]);
                    }
                    if (updated.sessionLatestUsage !== undefined) {
                        if (mergedSessions === state.sessions) {
                            mergedSessions = { ...state.sessions };
                        }
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id]!,
                            latestUsage: updated.sessionLatestUsage,
                        };
                    }
                    if (updated.sessionTodos !== undefined) {
                        if (mergedSessions === state.sessions) {
                            mergedSessions = { ...state.sessions };
                        }
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id]!,
                            todos: updated.sessionTodos,
                        };
                    }
                }

                const nextRenderableBase = buildSessionListRenderableFromSession(
                    mergedSessions[session.id]!,
                    renderableMessages,
                );
                const previousRenderable = state.sessionListRenderables?.[session.id];
                const nextRenderable = previousRenderable
                    ? preserveSessionListRenderableTransientState(previousRenderable, nextRenderableBase)
                    : nextRenderableBase;
                const mergedRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderable)
                    ? previousRenderable
                    : nextRenderable;
                const didListViewFieldsChange = didSessionListRenderableStructuralFieldsChange(
                    previousRenderable,
                    mergedRenderable,
                );
                if (mergedRenderable !== previousRenderable) {
                    changedRenderableCount += 1;
                    if (didListViewFieldsChange) {
                        listViewFieldChangeCount += 1;
                    }
                    if (!didWarmCacheRelevantRenderableChange) {
                        const previousWarmCacheEntry = previousRenderable
                            ? buildSessionListCacheEntryFromRenderable(previousRenderable)
                            : undefined;
                        const nextWarmCacheEntry = buildSessionListCacheEntryFromRenderable(
                            mergedRenderable,
                            previousWarmCacheEntry,
                        );
                        didWarmCacheRelevantRenderableChange = nextWarmCacheEntry !== previousWarmCacheEntry;
                    }
                    if (mergedRenderables === state.sessionListRenderables) {
                        mergedRenderables = { ...state.sessionListRenderables };
                    }
                    mergedRenderables[session.id] = mergedRenderable;
                }

                if (!needsSessionListViewDataRebuild) {
                    if (didListViewFieldsChange) {
                        needsSessionListViewDataRebuild = true;
                    }
                }

                if (!needsProjectManagerUpdate) {
                    if (didSessionListRenderableProjectGroupingFieldsChange(previousRenderable, mergedRenderable)) {
                        needsProjectManagerUpdate = true;
                    }
                }

                if (!needsReachablePeerReevaluation) {
                    if (didSessionListRenderableReachabilityPeerFieldsChange(previousRenderable, mergedRenderable)) {
                        needsReachablePeerReevaluation = true;
                    }
                }
            });
                },
            );

            syncPerformanceTelemetry.count('sync.store.sessions.apply.merge.outcome', {
                sessions: sessions.length,
                changedSessions: changedSessionCount,
                changedRenderables: changedRenderableCount,
                reconciledSessionMessages: reconciledSessionMessageCount,
                listRebuild: needsSessionListViewDataRebuild ? 1 : 0,
                listViewFieldChanges: listViewFieldChangeCount,
                projectManagerUpdate: needsProjectManagerUpdate ? 1 : 0,
                reachablePeerReevaluation: needsReachablePeerReevaluation ? 1 : 0,
                warmCacheRelevant: didWarmCacheRelevantRenderableChange ? 1 : 0,
            });

            if (
                mergedSessions === state.sessions
                && mergedRenderables === state.sessionListRenderables
                && updatedSessionMessages === state.sessionMessages
                && !needsSessionListViewDataRebuild
                && !needsProjectManagerUpdate
            ) {
                syncPerformanceTelemetry.count('sync.store.sessions.apply.noop', {
                    sessions: sessions.length,
                });
                return state;
            }

            if (needsReachablePeerReevaluation && (!needsSessionListViewDataRebuild || !needsProjectManagerUpdate)) {
                measureSessionApplyPhase(
                    'sync.store.sessions.apply.reachablePeers',
                    () => ({ renderables: Object.keys(mergedRenderables).length }),
                    () => {
                        didReachablePeerReevaluation = true;
                        const previousReachableRenderables = applyReachableSessionListRenderablesForState({
                            sessions: state.sessionListRenderables ?? {},
                            sessionRecords: state.sessions ?? {},
                            machineDisplays: state.machineDisplayById ?? {},
                            machineRecords: state.machines ?? {},
                            getProjectForSession: state.getProjectForSession ?? undefined,
                        });
                        const nextReachableRenderables = applyReachableSessionListRenderablesForState({
                            sessions: mergedRenderables,
                            sessionRecords: mergedSessions,
                            machineDisplays: state.machineDisplayById ?? {},
                            machineRecords: state.machines ?? {},
                            getProjectForSession: state.getProjectForSession ?? undefined,
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
                    },
                );
            }

            const nextStateBase = {
                ...state,
                sessions: mergedSessions,
                sessionListRenderables: mergedRenderables,
                sessionMessages: updatedSessionMessages,
            };

            const sessionListViewData = needsSessionListViewDataRebuild
                ? measureSessionApplyPhase(
                    'sync.store.sessions.apply.listRebuild',
                    () => ({ renderables: Object.keys(mergedRenderables).length }),
                    () => buildSessionListViewDataForState(nextStateBase),
                )
                : state.sessionListViewData;

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
                        projectManager.updateSessions(Object.values(mergedSessions), machineMetadataMap);
                    },
                );
            }

            syncPerformanceTelemetry.count('sync.store.sessions.apply.changed', {
                sessions: sessions.length,
                changedSessions: changedSessionCount,
                changedRenderables: changedRenderableCount,
                reconciledSessionMessages: reconciledSessionMessageCount,
                listRebuild: needsSessionListViewDataRebuild ? 1 : 0,
                listViewFieldChanges: listViewFieldChangeCount,
                projectManagerUpdate: needsProjectManagerUpdate ? 1 : 0,
                reachablePeerReevaluation: didReachablePeerReevaluation ? 1 : 0,
            });

            const nextState = {
                ...nextStateBase,
                sessionsData: null,
                sessionListViewData,
                sessionListViewDataByServerId: needsSessionListViewDataRebuild && sessionListViewData
                    ? setActiveServerSessionListCache(
                        state.sessionListViewDataByServerId,
                        sessionListViewData,
                    )
                    : state.sessionListViewDataByServerId,
            };
            if (didWarmCacheRelevantRenderableChange) {
                measureSessionApplyPhase(
                    'sync.store.sessions.apply.warmCache',
                    () => ({ renderables: Object.keys(nextState.sessionListRenderables ?? {}).length }),
                    () => saveWarmSessionCacheForState(nextState as SessionsDomain & SessionsDomainDependencies),
                );
            }
                return nextState;
            }),
        ),
        replaceSessionListRenderables: (sessions) => set((state) => {
            const plan = planSessionListRenderableReplacement({
                previousRenderables: state.sessionListRenderables ?? {},
                incomingRenderables: sessions,
                isSessionListViewDataUninitialized: state.sessionListViewData === null,
            });
            syncPerformanceTelemetry.count('sync.store.sessions.renderables.replace', {
                incoming: sessions.length,
                previous: Object.keys(state.sessionListRenderables ?? {}).length,
                changed: plan.changedCount,
                removed: plan.removedCount,
                noop: plan.noop ? 1 : 0,
                listRebuild: plan.needsSessionListViewDataRebuild ? 1 : 0,
                listViewFieldChanges: plan.listViewFieldChangeCount,
                staleMetadataPreserved: plan.staleMetadataPreservedCount,
                stalePendingFlagsPreserved: plan.stalePendingFlagsPreservedCount,
                warmCacheRelevant: plan.didWarmCacheRelevantRenderableChange ? 1 : 0,
            });

            if (plan.noop) {
                return state;
            }

            const nextStateBase = {
                ...state,
                sessionListRenderables: plan.nextRenderables,
            };

            const sessionListViewData = plan.needsSessionListViewDataRebuild
                ? measureSessionApplyPhase(
                    'sync.store.sessions.renderables.replace.listRebuild',
                    () => ({
                        renderables: Object.keys(plan.nextRenderables).length,
                        incoming: sessions.length,
                        changed: plan.changedCount,
                        removed: plan.removedCount,
                        listViewFieldChanges: plan.listViewFieldChangeCount,
                    }),
                    () => buildSessionListViewDataForState(nextStateBase as SessionsDomain & SessionsDomainDependencies),
                )
                : state.sessionListViewData;

            const next = {
                ...nextStateBase,
                sessionListViewData,
                sessionListViewDataByServerId: plan.needsSessionListViewDataRebuild && sessionListViewData
                    ? setActiveServerSessionListCache(
                        state.sessionListViewDataByServerId,
                        sessionListViewData,
                    )
                    : state.sessionListViewDataByServerId,
            };
            if (plan.didWarmCacheRelevantRenderableChange) {
                measureSessionApplyPhase(
                    'sync.store.sessions.renderables.replace.warmCache',
                    () => ({
                        renderables: Object.keys(next.sessionListRenderables ?? {}).length,
                        incoming: sessions.length,
                        changed: plan.changedCount,
                        removed: plan.removedCount,
                    }),
                    () => {
                        const previousEntries = buildSessionListCacheEntriesFromRenderables(state.sessionListRenderables ?? {});
                        saveWarmSessionCacheForState(next as SessionsDomain & SessionsDomainDependencies, previousEntries);
                    },
                );
            }
            return next;
        }),
        applySessionListRenderablePatches: (patches) => set((state) => {
            if (patches.length === 0) {
                return state;
            }

            const plan = planSessionListRenderablePatches({
                previousRenderables: state.sessionListRenderables ?? {},
                patches,
                isSessionListViewDataUninitialized: state.sessionListViewData === null,
            });
            syncPerformanceTelemetry.count('sync.store.sessions.renderables.patch', {
                patches: patches.length,
                changed: plan.changedCount,
                noopPatches: plan.noopPatchCount,
                missing: plan.missingCount,
                listRebuild: plan.needsSessionListViewDataRebuild ? 1 : 0,
                listViewFieldChanges: plan.listViewFieldChangeCount,
                warmCacheRelevant: plan.didWarmCacheRelevantRenderableChange ? 1 : 0,
            });

            if (plan.noop) {
                return state;
            }

            const nextStateBase = {
                ...state,
                sessionListRenderables: plan.nextRenderables,
            };

            const sessionListViewData = plan.needsSessionListViewDataRebuild
                ? measureSessionApplyPhase(
                    'sync.store.sessions.renderables.patch.listRebuild',
                    () => ({
                        renderables: Object.keys(plan.nextRenderables).length,
                        patches: patches.length,
                        changed: plan.changedCount,
                        missing: plan.missingCount,
                        listViewFieldChanges: plan.listViewFieldChangeCount,
                    }),
                    () => buildSessionListViewDataForState(nextStateBase as SessionsDomain & SessionsDomainDependencies),
                )
                : state.sessionListViewData;

            const nextState = {
                ...nextStateBase,
                sessionListViewData,
                sessionListViewDataByServerId: plan.needsSessionListViewDataRebuild && sessionListViewData
                    ? setActiveServerSessionListCache(
                        state.sessionListViewDataByServerId,
                        sessionListViewData,
                    )
                    : state.sessionListViewDataByServerId,
            };

            if (plan.didWarmCacheRelevantRenderableChange) {
                measureSessionApplyPhase(
                    'sync.store.sessions.renderables.patch.warmCache',
                    () => ({
                        renderables: Object.keys(nextState.sessionListRenderables ?? {}).length,
                        patches: patches.length,
                        changed: plan.changedCount,
                        missing: plan.missingCount,
                    }),
                    () => {
                        const previousEntries = buildSessionListCacheEntriesFromRenderables(state.sessionListRenderables ?? {});
                        saveWarmSessionCacheForState(nextState as SessionsDomain & SessionsDomainDependencies, previousEntries);
                    },
                );
            }
            return nextState;
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsData: null
            };
            return result;
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

            const persisted = persistSessionPermissionData(updatedSessions, sessionLocalStateScope);
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

            saveSessionModelModes(allModes, sessionLocalStateScope);
            saveSessionModelModeUpdatedAts(allUpdatedAts, sessionLocalStateScope);
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
            const { [sessionId]: _deletedTreeState, ...remainingTreeState } = state.sessionRepositoryTreeExpandedPathsBySessionId;
            sessionRepositoryTreeExpandedPathsBySessionId = remainingTreeState;
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
            
            // Rebuild sessionListViewData without the deleted session
            const nextState = {
                ...state,
                sessions: remainingSessions,
                sessionListRenderables: remainingRenderables,
                sessionMessages: remainingSessionMessages,
                sessionScmStatus: remainingScmStatus,
                sessionRepositoryTreeExpandedPathsBySessionId: remainingTreeState,
                reviewCommentsDraftsBySessionId: remainingReviewDrafts,
                actionDraftsBySessionId: remainingActionDrafts,
                sessionLastViewed: { ...sessionLastViewed },
                sessionListViewData: buildSessionListViewDataForState({
                    ...state,
                    sessions: remainingSessions,
                    sessionListRenderables: remainingRenderables,
                } as SessionsDomain & SessionsDomainDependencies),
            };
            const next = {
                ...nextState,
                sessionListViewDataByServerId: setActiveServerSessionListCache(
                    state.sessionListViewDataByServerId,
                    nextState.sessionListViewData,
                ),
            };
            saveWarmSessionCacheForState(next as SessionsDomain & SessionsDomainDependencies);
            return next;
        }),
    };
}
