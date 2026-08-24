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
import { isTranscriptRenderableAggregate } from '../../domains/messages/transcriptRenderableAggregate';
import {
    areSessionListRenderablesEqual,
    buildSessionListRenderableFromSession,
    didSessionListRenderableEmbeddedListRowFieldsChange,
    didSessionListRenderableProjectGroupingFieldsChange,
    didSessionListRenderableReachabilityPeerFieldsChange,
    preserveSessionListRenderableTransientState,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';
import { assessSessionListRenderableChange } from './sessionListRenderableStoreUpdate';
import { createKeyedTimeoutScheduler } from '@/utils/time/keyedTimeoutScheduler';
import {
    type SessionListAttentionPromotionMode,
    type SessionListWorkingPlacementMode,
} from '../../domains/session/listing/attentionPromotion/sessionListAttentionPromotionTypes';
import { nowServerMs } from '../../runtime/time';
import { clearSessionTranscriptDerivedCachesForSession } from '../../runtime/sessionTranscriptDerivedCaches';
import {
    loadSessionLastViewed,
    loadSessionModelModeUpdatedAts,
    loadSessionModelModes,
    loadSessionPermissionModeUpdatedAts,
    loadSessionPermissionModes,
    loadSessionActionDrafts,
    loadSessionReviewCommentsDrafts,
    loadWorkspaceReviewCommentsDrafts,
    prepareSessionLocalStateScopeForActivation,
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
    readPersistedSessionListWarmCacheEntries,
    resolveWarmCacheAccountScope,
    saveSessionListWarmCacheEntries,
} from '../../domains/state/warmCachePersistence';
import {
    buildPersistedSessionListCacheEntriesFromRenderables,
    buildSessionListCacheEntryFromRenderable,
} from '../../domains/state/warmCacheAdapters';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { syncPerformanceTelemetry } from '../../runtime/syncPerformanceTelemetry';
import { isModelMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { parsePermissionIntentAlias, resolveMetadataStringOverrideStateV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import {
    applyReachableTargetsToSessionListRenderables,
} from '../buildSessionListViewDataWithServerScope';
import {
    isTerminalPrimaryTurnStatus,
    resolveSessionRuntimePresenceFields,
    SESSION_RESUMING_PRESENTATION_TIMEOUT_MS,
} from '../../domains/session/attention/deriveSessionRuntimePresentationState';
import { setActiveServerSessionListCache } from '../sessionListCache';
import { getActiveServerSnapshot } from '../../domains/server/serverRuntime';
import { areScmWorkingSnapshotsEquivalentIgnoringFetchedAt } from '@/scm/sync/snapshotDiff';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import type { SessionActionDraftStatus } from '@/sync/domains/sessionActions/sessionActionDraftTypes';

import type { StoreGet, StoreSet } from './_shared';
import { areSessionValuesDeepEqual, areStoredSessionsEqual } from './areStoredSessionsEqual';
import { applyAgentStateUpdateToSessionMessages } from './messages';
import type { SessionMessages } from './messages';
import { persistSessionModelData } from './sessionModelPersistence';
import { persistSessionPermissionData } from './sessionPermissionPersistence';
import { resolveMergedSessionPermissionMode } from './resolveMergedSessionPermissionMode';
import {
    applySessionListRenderableCommitPlan,
    buildNextSessionListRenderableDelta,
    buildSessionListViewDataForRenderableState,
    didSessionListRenderableListViewFieldsChangeForSettings,
    planSessionListRenderableMergeCommit,
    planSessionListRenderablePatchesCommit,
    planSessionListRenderableReplacementCommit,
    refreshSessionListViewDataRowsForRenderables,
    shouldRebuildOnSessionPlacementFieldsChange,
} from './sessionListRenderableCommit';
import { clearAgentInputLocalUiStateForSession } from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import { deleteSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    createWarmCacheSaveScheduler,
    WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS,
} from './warmCacheSaveScheduler';

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
    /**
     * Sessions this viewer has positive evidence are gone, keyed by id.
     *
     * Neither `sessions` nor `sessionListRenderables` can answer "does this session exist": both
     * are list-scoped caches. `sessionListRenderables` is evicted for every row a replace-mode
     * `/v2/sessions` page omits inside its removal window — and that endpoint filters
     * `archivedAt: null` server-side, so archiving alone empties it. `sessions` holds only the
     * records this run actually hydrated, and is in practice a *subset* of the renderables
     * (measured live: `sessions \ renderables` = 0, `renderables \ sessions` = 97), so it cannot
     * cover an evicted row either.
     *
     * `deleteSession` is the one signal that does mean gone. Every caller reaches it through
     * `handleDeleteSessionSocketUpdate`, on exactly three pieces of server evidence: the socket
     * `delete-session` update, the socket `session-share-revoked` update (the session survives for
     * its owner but not for this viewer), and an exact session fetch answering `not_found`. Those
     * are the same grounds the session route states as "deleted, or you may no longer have
     * access". Anything that must distinguish gone from not-cached — a durable pointer such as a
     * transcript session reference — reads this map rather than inferring absence.
     */
    deletedSessionIds: Record<string, true>;
    sessionListRenderableDelta: import('./sessionListRenderableCommit').SessionListRenderableDelta;
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

    activateSessionLocalStateScope: (scope: ServerAccountScope, legacyScopes?: readonly ServerAccountScope[]) => void;
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
    applyLoaded: () => void;
    applyReady: () => void;

    applyScmStatus: (sessionId: string, status: ScmStatus | null) => void;
    getSessionRepositoryTreeExpandedPaths: (sessionId: string) => string[];
    setSessionRepositoryTreeExpandedPaths: (sessionId: string, paths: string[]) => void;
    clearSessionRepositoryTreeExpandedPaths: (sessionId: string) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionResuming: (sessionId: string) => void;
    armSessionResumingFallback: (sessionId: string) => void;
    clearSessionResuming: (sessionId: string) => void;
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
    publishSessionProjectScmSnapshots: (
        publishes: ReadonlyArray<Readonly<{
            sessionId: string;
            snapshot: ScmWorkingSnapshot;
            status: ScmStatus | null;
        }>>,
    ) => void;
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
        sessionListSectionModeV1?: 'activity' | 'single';
        sessionListAttentionPromotionModeV1?: SessionListAttentionPromotionMode;
        sessionListWorkingPlacementModeV1?: SessionListWorkingPlacementMode;
        workspacePathDisplayModeV1?: 'name' | 'path';
    };
};

// UI-only "optimistic processing" marker.
// Cleared via timers so components don't need to poll time.
const OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS = 15_000;
const optimisticThinkingTimeouts = createKeyedTimeoutScheduler();

// UI-only "thinking debounce" marker.
// Kept for a short grace period after the session stops streaming, so the UI doesn't flicker
// between "working" and "online" between output chunks.
const SESSION_THINKING_GRACE_TIMEOUT_MS = 3_000;
const thinkingGraceTimeouts = createKeyedTimeoutScheduler();

// UI-only "resuming" lifecycle marker (single owner). Set at resume initiation and cleared on the
// first post-attach activity; a bounded decay timer guarantees a crashed/never-settling resume
// cannot latch the indicator forever.
const resumingTimeouts = createKeyedTimeoutScheduler();

let actionDraftIdCounter = 0;
function createActionDraftId(nowMs: number): string {
    actionDraftIdCounter += 1;
    return `action_draft_${nowMs}_${actionDraftIdCounter}`;
}

function normalizeReadyEventNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
}

function resolveMergedSessionReadyEvent(params: Readonly<{
    previousSession: Session | undefined;
    incomingSession: Pick<Session, 'latestReadyEventSeq' | 'latestReadyEventAt'>;
}>): Pick<Session, 'latestReadyEventSeq' | 'latestReadyEventAt'> {
    const previousSeq = normalizeReadyEventNumber(params.previousSession?.latestReadyEventSeq);
    const previousAt = normalizeReadyEventNumber(params.previousSession?.latestReadyEventAt);
    const incomingSeq = normalizeReadyEventNumber(params.incomingSession.latestReadyEventSeq);
    const incomingAt = normalizeReadyEventNumber(params.incomingSession.latestReadyEventAt);

    if (incomingSeq === null) {
        return {
            latestReadyEventSeq: previousSeq,
            latestReadyEventAt: previousAt,
        };
    }

    if (previousSeq === null || incomingSeq > previousSeq) {
        return {
            latestReadyEventSeq: incomingSeq,
            latestReadyEventAt: incomingAt,
        };
    }

    if (incomingSeq < previousSeq) {
        return {
            latestReadyEventSeq: previousSeq,
            latestReadyEventAt: previousAt,
        };
    }

    return {
        latestReadyEventSeq: incomingSeq,
        latestReadyEventAt: incomingAt ?? previousAt,
    };
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
        && isTerminalPrimaryTurnStatus(previousSession.latestTurnStatus ?? null)
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

/**
 * Centralized session online state resolver
 * Returns either "online" (string) or a timestamp (number) for last seen
 */
function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): "online" | number {
    // Session is online if the active flag is true
    return session.active ? "online" : session.activeAt;
}

/**
 * Diffs against what the warm-cache key is known to hold rather than against a
 * reconstruction of the previous renderables. Boot hydration therefore produces the
 * record that is already on disk and writes nothing, and steady-state saves skip both
 * the serialization and the storage write when nothing the cache keeps has changed.
 */
function saveWarmSessionCacheForState(state: SessionsDomain & SessionsDomainDependencies): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const accountId = resolveWarmCacheAccountScope(state.profile?.id);
    if (!activeServerId || !accountId) return;
    const previousEntries = readPersistedSessionListWarmCacheEntries(activeServerId, accountId);
    const nextEntries = buildPersistedSessionListCacheEntriesFromRenderables(state.sessionListRenderables ?? {}, previousEntries);
    if (previousEntries && nextEntries === previousEntries) return;
    saveSessionListWarmCacheEntries(
        activeServerId,
        accountId,
        nextEntries,
    );
}

function buildSessionListViewDataForState(state: SessionsDomain & SessionsDomainDependencies): SessionListViewItem[] {
    return buildSessionListViewDataForRenderableState(state);
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
    const emptySessionRepositoryTreeExpandedPaths: string[] = [];
    let actionDraftsBySessionId: Record<string, SessionActionDraft[]> = loadSessionActionDrafts();
    let warmCacheSaveScheduler: ReturnType<typeof createWarmCacheSaveScheduler<
        SessionsDomain & SessionsDomainDependencies
    >> | null = null;
    const getWarmCacheSaveScheduler = () => {
        if (!warmCacheSaveScheduler) {
            warmCacheSaveScheduler = createWarmCacheSaveScheduler<
                SessionsDomain & SessionsDomainDependencies
            >({
                get,
                save: saveWarmSessionCacheForState,
                delayMs: WARM_CACHE_PROGRESS_SAVE_DEBOUNCE_MS,
                onSchedule: ({ state, coalesced }) => {
                    syncPerformanceTelemetry.countLazy('sync.store.sessions.warmCache.schedule', () => ({
                        coalesced: coalesced ? 1 : 0,
                        renderables: Object.keys(state.sessionListRenderables ?? {}).length,
                        scheduled: coalesced ? 0 : 1,
                    }));
                },
                onFlush: (currentState, flush) => {
                    measureSessionApplyPhase(
                        'sync.store.sessions.warmCache.flush',
                        () => ({ renderables: Object.keys(currentState.sessionListRenderables ?? {}).length }),
                        flush,
                    );
                },
            });
        }
        return warmCacheSaveScheduler;
    };

    const clearDeferredWarmCacheSave = (): void => {
        warmCacheSaveScheduler?.clear();
    };

    const saveWarmSessionCacheImmediately = (
        state: SessionsDomain & SessionsDomainDependencies,
    ): void => {
        getWarmCacheSaveScheduler().saveImmediately(state);
    };
    const scheduleWarmSessionCacheSave = (
        state?: SessionsDomain & SessionsDomainDependencies,
    ): void => {
        getWarmCacheSaveScheduler().schedule(state);
    };

    const stripLegacySessionDraftField = <T extends object>(value: T): Omit<T, 'draft'> => {
        const { draft: _discardedLegacyDraft, ...withoutDraft } = value as T & Readonly<{ draft?: unknown }>;
        return withoutDraft;
    };

    const stripLocalSessionFields = (session: Session): Session => ({
        ...stripLegacySessionDraftField(session),
        permissionMode: null,
        permissionModeUpdatedAt: undefined,
        modelMode: undefined,
        modelModeUpdatedAt: undefined,
    });

    const applyLocalSessionFields = (session: Session): Session => ({
        ...stripLocalSessionFields(session),
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

    const clearSessionResumingMarker = (sessionId: string, expectedResumingAt?: number): void => {
        set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            const resumingAt = session.resumingAt ?? null;
            if (resumingAt === null) return state;
            if (expectedResumingAt !== undefined && resumingAt !== expectedResumingAt) return state;

            resumingTimeouts.cancel(sessionId);

            const renderable = state.sessionListRenderables[sessionId];
            const nextRenderables = renderable && (renderable.resumingAt ?? null) !== null
                ? {
                    ...state.sessionListRenderables,
                    [sessionId]: {
                        ...renderable,
                        resumingAt: null,
                    },
                }
                : state.sessionListRenderables;
            const nextStateBase = {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        resumingAt: null,
                    },
                },
                sessionListRenderables: nextRenderables,
            };
            const shouldRebuildSessionListViewData = nextRenderables !== state.sessionListRenderables
                && shouldRebuildOnSessionPlacementFieldsChange(state.settings);

            return {
                ...nextStateBase,
                sessionListViewData: shouldRebuildSessionListViewData
                    ? buildSessionListViewDataForState(nextStateBase)
                    : state.sessionListViewData,
            };
        });
    };

    return {
        sessions: {},
        sessionListRenderables: {},
        deletedSessionIds: {},
        sessionListRenderableDelta: {
            revision: 0,
            changedSessionIds: [],
            removedSessionIds: [],
            rebuiltSessionListViewData: false,
        },
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
        activateSessionLocalStateScope: (scope, legacyScopes = []) => {
            clearDeferredWarmCacheSave();
            prepareSessionLocalStateScopeForActivation(scope, legacyScopes);
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
            clearDeferredWarmCacheSave();
            hydrateSessionLocalState(null);
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
            return state.sessionRepositoryTreeExpandedPathsBySessionId[sessionId] ?? emptySessionRepositoryTreeExpandedPaths;
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

            // Persisted local mode maps must be consulted for any session that appears after bootstrap
            // (deep links, pagination, socket-delivered sessions, etc.), not only when the sessions store
            // is initially empty.
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
            const changedConsumerSessionIds = new Set<string>();
            let reconciledSessionMessageCount = 0;
            let needsReachablePeerReevaluation = false;
            let didReachablePeerReevaluation = false;
            let didImmediateWarmCacheRelevantRenderableChange = false;
            let didDeferredWarmCacheRelevantRenderableChange = false;
            let listViewFieldChangeCount = 0;
            const listViewRowRefreshSessionIds: string[] = [];
            let attentionPromotionFieldChangeCount = 0;
            const rebuildOnAttentionPromotionFieldsChange =
                shouldRebuildOnSessionPlacementFieldsChange(state.settings);

            measureSessionApplyPhase(
                'sync.store.sessions.apply.merge',
                () => ({ sessions: sessions.length }),
                () => {
            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(incomingSession => {
                const previousSession = state.sessions[incomingSession.id];
                const session = stripLegacySessionDraftField(
                    resolveOrderedSessionApply(previousSession, incomingSession),
                );
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Preserve existing local mode selections, or load them from persisted local state.
                const existingPermissionMode = previousSession?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                const existingModelMode = previousSession?.modelMode;
                const savedModelMode = savedModelModes[session.id];
                const existingPermissionModeUpdatedAt = previousSession?.permissionModeUpdatedAt;
                const savedPermissionModeUpdatedAt = savedPermissionModeUpdatedAts[session.id];
                const existingModelModeUpdatedAt = previousSession?.modelModeUpdatedAt;
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
                const hasTerminalTurnProjection = isTerminalPrimaryTurnStatus(session.latestTurnStatus ?? null);
                const wasThinking = previousSession
                    ? resolveSessionRuntimePresenceFields({
                        thinking: previousSession.thinking,
                        thinkingAt: previousSession.thinkingAt,
                        latestTurnStatus: previousSession.latestTurnStatus,
                        latestTurnStatusObservedAt: previousSession.latestTurnStatusObservedAt,
                    }).thinking
                    : false;

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

                // State-aware on purpose: an explicit CLEAR is an override with a
                // timestamp, not an absent key. The Agent transition writes one when the
                // armed switch chose no model, and it is the only thing that can retire a
                // client-local selection made for the DEPARTED Agent — the selectability
                // clamp below cannot, because a freeform-capable target (Claude) accepts
                // any id, so the source Agent's model survived the cutover, named the
                // composer chip and was handed to the target's resume.
                const modelOverride = resolveMetadataStringOverrideStateV1(session.metadata, 'modelOverrideV1', 'modelId');
                const metadataModelId = modelOverride === null
                    ? null
                    : (modelOverride.state === 'set' ? modelOverride.value : 'default');
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
                    thinkingGraceTimeouts.cancel(session.id);
                } else if (runtimePresence.thinking === true) {
                    mergedThinkingGraceUntil = null;
                    thinkingGraceTimeouts.cancel(session.id);
                } else if (hasTerminalTurnProjection) {
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
                            const currentRenderable = s.sessionListRenderables[sessionId];
                            const nextRenderables = currentRenderable
                                && (currentRenderable.thinkingGraceUntil ?? null) === expectedThinkingGraceUntil
                                ? {
                                    ...s.sessionListRenderables,
                                    [sessionId]: {
                                        ...currentRenderable,
                                        thinkingGraceUntil: null,
                                    },
                                }
                                : s.sessionListRenderables;
                            const nextStateBase = {
                                ...s,
                                sessions: next,
                                sessionListRenderables: nextRenderables,
                            };
                            const shouldRebuildSessionListViewData = nextRenderables !== s.sessionListRenderables
                                && shouldRebuildOnSessionPlacementFieldsChange(s.settings);
                            return {
                                ...nextStateBase,
                                sessionListViewData: shouldRebuildSessionListViewData
                                    ? buildSessionListViewDataForState(nextStateBase)
                                    : s.sessionListViewData,
                            };
                        });
                    });
                } else if (typeof mergedThinkingGraceUntil === 'number' && mergedThinkingGraceUntil <= localNowMs) {
                    mergedThinkingGraceUntil = null;
                    thinkingGraceTimeouts.cancel(session.id);
                }

                const mergedOptimisticThinkingAt = runtimePresence.thinking ? null : existingOptimisticThinkingAt;

                // Resuming lifecycle (single owner): preserve the explicit marker until the first
                // post-attach activity settles it. Settle only on genuine NEW activity — real
                // thinking, an advanced turn boundary / ready / meaningful event relative to the
                // previous snapshot, or a live-and-idle reconnect with no pending optimistic work.
                // A mere presence heartbeat (which creeps activeAt without advancing frozen event
                // timestamps) never settles or resurrects the marker.
                let mergedResumingAt = existingResumingAt;
                if (existingResumingAt !== null) {
                    const isLiveOwner = presence === 'online' && session.active === true;
                    const activityAdvanced =
                        (session.latestTurnStatusObservedAt ?? 0) > (previousSession?.latestTurnStatusObservedAt ?? 0)
                        || (session.meaningfulActivityAt ?? 0) > (previousSession?.meaningfulActivityAt ?? 0)
                        || (session.latestReadyEventAt ?? 0) > (previousSession?.latestReadyEventAt ?? 0);
                    const connectedIdleWithoutPendingWork =
                        isLiveOwner && hasTerminalTurnProjection && mergedOptimisticThinkingAt === null;
                    const shouldSettleResuming =
                        runtimePresence.thinking === true
                        || (isLiveOwner && activityAdvanced)
                        || connectedIdleWithoutPendingWork;
                    if (shouldSettleResuming) {
                        mergedResumingAt = null;
                        resumingTimeouts.cancel(session.id);
                    }
                }

                const nextSession: Session = {
                    ...session,
                    ...resolveMergedSessionReadyEvent({
                        previousSession,
                        incomingSession: session,
                    }),
                    thinking: runtimePresence.thinking,
                    thinkingAt: runtimePresence.thinkingAt,
                    presence,
                    optimisticThinkingAt: mergedOptimisticThinkingAt,
                    resumingAt: mergedResumingAt,
                    thinkingGraceUntil: mergedThinkingGraceUntil,
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
                    changedConsumerSessionIds.add(session.id);
                    if (mergedSessions === state.sessions) {
                        mergedSessions = { ...state.sessions };
                    }
                    mergedSessions[session.id] = mergedSession;
                }

                const existingSessionMessages = updatedSessionMessages[session.id];
                let renderableMessages = existingSessionMessages?.isLoaded === true
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
                        renderableMessages = updatedSessionMessages[session.id]?.isLoaded === true
                            ? readStoredSessionMessagesFromStateLike(updatedSessionMessages[session.id])
                            : undefined;
                    }
                    // Guard with value equality: the reconcile surfaces usage
                    // and todos on every snapshot, and unconditional writes
                    // would churn the Session identity for identical values.
                    if (
                        updated.sessionLatestUsage !== undefined
                        && !areSessionValuesDeepEqual(mergedSessions[session.id]!.latestUsage ?? null, updated.sessionLatestUsage)
                    ) {
                        if (mergedSessions === state.sessions) {
                            mergedSessions = { ...state.sessions };
                        }
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id]!,
                            latestUsage: updated.sessionLatestUsage,
                        };
                    }
                    if (
                        updated.sessionTodos !== undefined
                        && !areSessionValuesDeepEqual(mergedSessions[session.id]!.todos ?? null, updated.sessionTodos)
                    ) {
                        if (mergedSessions === state.sessions) {
                            mergedSessions = { ...state.sessions };
                        }
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id]!,
                            todos: updated.sessionTodos,
                        };
                    }
                }

                // Reuse the incrementally-maintained transcript aggregate when
                // it is still valid; the builder self-checks completedRequests
                // identity and falls back to the messages walk otherwise.
                const sessionMessagesForRenderable = updatedSessionMessages[session.id];
                const nextRenderableBase = buildSessionListRenderableFromSession(
                    mergedSessions[session.id]!,
                    renderableMessages,
                    sessionMessagesForRenderable?.isLoaded === true
                    && isTranscriptRenderableAggregate(sessionMessagesForRenderable.renderableAggregate)
                        ? sessionMessagesForRenderable.renderableAggregate
                        : undefined,
                );
                const previousRenderable = state.sessionListRenderables?.[session.id];
                // Unconditional, exactly like the renderable-replacement path: the
                // merge owner is what stamps the unread entry fact, and it handles
                // the no-previous case itself. Skipping it for a first ingest would
                // leave a freshly-arrived unread row keyed on moving activity — and
                // persist that missing entry fact into the warm cache.
                const nextRenderable = preserveSessionListRenderableTransientState(
                    previousRenderable,
                    nextRenderableBase,
                );
                const mergedRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderable)
                    ? previousRenderable
                    : nextRenderable;
                // One decision owner for renderable changes across ingestion
                // paths: applySessions must reach the same rebuild/row-refresh/
                // warm-cache verdicts as the canonical plan functions.
                const assessment = assessSessionListRenderableChange({
                    previous: previousRenderable,
                    next: mergedRenderable,
                    rebuildOnAttentionPromotionFieldsChange,
                    didListViewFieldsChange: (previous, next) =>
                        didSessionListRenderableListViewFieldsChangeForSettings(previous, next, state.settings),
                    didListViewRowFieldsChange: didSessionListRenderableEmbeddedListRowFieldsChange,
                });
                if (mergedRenderable !== previousRenderable) {
                    changedRenderableCount += 1;
                    changedConsumerSessionIds.add(session.id);
                    if (assessment.didListViewFieldsChange) {
                        listViewFieldChangeCount += 1;
                    }
                    if (assessment.shouldRefreshListViewRow) {
                        listViewRowRefreshSessionIds.push(session.id);
                    }
                    if (assessment.didAttentionPromotionFieldsChange) {
                        attentionPromotionFieldChangeCount += 1;
                    }
                    if (!didImmediateWarmCacheRelevantRenderableChange) {
                        const previousWarmCacheEntry = previousRenderable
                            ? buildSessionListCacheEntryFromRenderable(previousRenderable)
                            : undefined;
                        const nextWarmCacheEntry = buildSessionListCacheEntryFromRenderable(
                            mergedRenderable,
                            previousWarmCacheEntry,
                        );
                        if (nextWarmCacheEntry !== previousWarmCacheEntry) {
                            if (assessment.warmCacheChange === 'deferred') {
                                didDeferredWarmCacheRelevantRenderableChange = true;
                            } else {
                                didImmediateWarmCacheRelevantRenderableChange = true;
                            }
                        }
                    }
                    if (mergedRenderables === state.sessionListRenderables) {
                        mergedRenderables = { ...state.sessionListRenderables };
                    }
                    mergedRenderables[session.id] = mergedRenderable;
                }

                if (!needsSessionListViewDataRebuild && assessment.needsSessionListViewDataRebuild) {
                    needsSessionListViewDataRebuild = true;
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
                attentionPromotionFieldChanges: attentionPromotionFieldChangeCount,
                projectManagerUpdate: needsProjectManagerUpdate ? 1 : 0,
                reachablePeerReevaluation: needsReachablePeerReevaluation ? 1 : 0,
                warmCacheRelevant: (didImmediateWarmCacheRelevantRenderableChange || didDeferredWarmCacheRelevantRenderableChange) ? 1 : 0,
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
                                && didSessionListRenderableListViewFieldsChangeForSettings(previousRenderable, nextRenderable, state.settings)
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
                sessionListRenderableDelta: buildNextSessionListRenderableDelta({
                    previous: state.sessionListRenderableDelta,
                    changedSessionIds: Array.from(changedConsumerSessionIds),
                    removedSessionIds: [],
                    rebuiltSessionListViewData: needsSessionListViewDataRebuild,
                }),
                sessionMessages: updatedSessionMessages,
            };

            const sessionListViewData = needsSessionListViewDataRebuild
                ? measureSessionApplyPhase(
                    'sync.store.sessions.apply.listRebuild',
                    () => ({ renderables: Object.keys(mergedRenderables).length }),
                    () => buildSessionListViewDataForState(nextStateBase),
                )
                : refreshSessionListViewDataRowsForRenderables({
                    sessionListViewData: state.sessionListViewData,
                    renderables: mergedRenderables,
                    sessionIds: listViewRowRefreshSessionIds,
                });

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
                listRowRefreshes: listViewRowRefreshSessionIds.length,
                listViewFieldChanges: listViewFieldChangeCount,
                attentionPromotionFieldChanges: attentionPromotionFieldChangeCount,
                projectManagerUpdate: needsProjectManagerUpdate ? 1 : 0,
                reachablePeerReevaluation: didReachablePeerReevaluation ? 1 : 0,
            });

            const nextState = {
                ...nextStateBase,
                sessionsData: null,
                sessionListViewData,
                sessionListViewDataByServerId: (needsSessionListViewDataRebuild || sessionListViewData !== state.sessionListViewData) && sessionListViewData
                    ? setActiveServerSessionListCache(
                        state.sessionListViewDataByServerId,
                        sessionListViewData,
                    )
                    : state.sessionListViewDataByServerId,
            };
            if (didImmediateWarmCacheRelevantRenderableChange) {
                const previousRenderableCount = Object.keys(state.sessionListRenderables ?? {}).length;
                if (previousRenderableCount === 0) {
                    measureSessionApplyPhase(
                        'sync.store.sessions.apply.warmCache',
                        () => ({ renderables: Object.keys(nextState.sessionListRenderables ?? {}).length }),
                        () => saveWarmSessionCacheImmediately(nextState as SessionsDomain & SessionsDomainDependencies),
                    );
                } else {
                    syncPerformanceTelemetry.count('sync.store.sessions.apply.warmCache.deferred', {
                        renderables: Object.keys(nextState.sessionListRenderables ?? {}).length,
                        immediate: 1,
                    });
                    scheduleWarmSessionCacheSave(nextState as SessionsDomain & SessionsDomainDependencies);
                }
            } else if (didDeferredWarmCacheRelevantRenderableChange) {
                syncPerformanceTelemetry.count('sync.store.sessions.apply.warmCache.deferred', {
                    renderables: Object.keys(nextState.sessionListRenderables ?? {}).length,
                });
                scheduleWarmSessionCacheSave(nextState as SessionsDomain & SessionsDomainDependencies);
            }
                return nextState;
            }),
        ),
        replaceSessionListRenderables: (sessions) => set((state) => {
            const plan = planSessionListRenderableReplacementCommit({
                state,
                incomingRenderables: sessions,
            });
            syncPerformanceTelemetry.count('sync.store.sessions.renderables.replace', {
                incoming: sessions.length,
                previous: Object.keys(state.sessionListRenderables ?? {}).length,
                changed: plan.changedCount,
                removed: plan.removedCount,
                noop: plan.noop ? 1 : 0,
                listRebuild: plan.needsSessionListViewDataRebuild ? 1 : 0,
                listViewFieldChanges: plan.listViewFieldChangeCount,
                attentionPromotionFieldChanges: plan.attentionPromotionFieldChangeCount,
                staleMetadataPreserved: plan.staleMetadataPreservedCount,
                stalePendingFlagsPreserved: plan.stalePendingFlagsPreservedCount,
                warmCacheRelevant: plan.didWarmCacheRelevantRenderableChange ? 1 : 0,
            });

            if (plan.noop) {
                return state;
            }

            const next = applySessionListRenderableCommitPlan({
                state,
                plan,
                measureListRebuild: (compute) => measureSessionApplyPhase(
                    'sync.store.sessions.renderables.replace.listRebuild',
                    () => ({
                        renderables: Object.keys(plan.nextRenderables).length,
                        incoming: sessions.length,
                        changed: plan.changedCount,
                        removed: plan.removedCount,
                        listViewFieldChanges: plan.listViewFieldChangeCount,
                        attentionPromotionFieldChanges: plan.attentionPromotionFieldChangeCount,
                    }),
                    compute,
                ),
            });
            if (plan.didImmediateWarmCacheRelevantRenderableChange) {
                measureSessionApplyPhase(
                    'sync.store.sessions.renderables.replace.warmCache',
                    () => ({
                        renderables: Object.keys(next.sessionListRenderables ?? {}).length,
                        incoming: sessions.length,
                        changed: plan.changedCount,
                        removed: plan.removedCount,
                    }),
                    () => saveWarmSessionCacheImmediately(next as SessionsDomain & SessionsDomainDependencies),
                );
            } else if (plan.didDeferredWarmCacheRelevantRenderableChange) {
                syncPerformanceTelemetry.count('sync.store.sessions.renderables.replace.warmCache.deferred', {
                    renderables: Object.keys(next.sessionListRenderables ?? {}).length,
                    incoming: sessions.length,
                    changed: plan.changedCount,
                    removed: plan.removedCount,
                });
                scheduleWarmSessionCacheSave(next as SessionsDomain & SessionsDomainDependencies);
            }
            return next;
        }),
        mergeSessionListRenderables: (sessions) => set((state) => {
            if (sessions.length === 0) {
                return state;
            }
            const plan = planSessionListRenderableMergeCommit({
                state,
                incomingRenderables: sessions,
            });
            syncPerformanceTelemetry.count('sync.store.sessions.renderables.merge', {
                incoming: sessions.length,
                previous: Object.keys(state.sessionListRenderables ?? {}).length,
                changed: plan.changedCount,
                removed: plan.removedCount,
                noop: plan.noop ? 1 : 0,
                listRebuild: plan.needsSessionListViewDataRebuild ? 1 : 0,
                listViewFieldChanges: plan.listViewFieldChangeCount,
                attentionPromotionFieldChanges: plan.attentionPromotionFieldChangeCount,
                staleMetadataPreserved: plan.staleMetadataPreservedCount,
                stalePendingFlagsPreserved: plan.stalePendingFlagsPreservedCount,
                warmCacheRelevant: plan.didWarmCacheRelevantRenderableChange ? 1 : 0,
            });

            if (plan.noop) {
                return state;
            }

            const next = applySessionListRenderableCommitPlan({
                state,
                plan,
                measureListRebuild: (compute) => measureSessionApplyPhase(
                    'sync.store.sessions.renderables.merge.listRebuild',
                    () => ({
                        renderables: Object.keys(plan.nextRenderables).length,
                        incoming: sessions.length,
                        changed: plan.changedCount,
                        listViewFieldChanges: plan.listViewFieldChangeCount,
                        attentionPromotionFieldChanges: plan.attentionPromotionFieldChangeCount,
                    }),
                    compute,
                ),
            });
            if (plan.didImmediateWarmCacheRelevantRenderableChange) {
                measureSessionApplyPhase(
                    'sync.store.sessions.renderables.merge.warmCache',
                    () => ({
                        renderables: Object.keys(next.sessionListRenderables ?? {}).length,
                        incoming: sessions.length,
                        changed: plan.changedCount,
                    }),
                    () => saveWarmSessionCacheImmediately(next as SessionsDomain & SessionsDomainDependencies),
                );
            } else if (plan.didDeferredWarmCacheRelevantRenderableChange) {
                syncPerformanceTelemetry.count('sync.store.sessions.renderables.merge.warmCache.deferred', {
                    renderables: Object.keys(next.sessionListRenderables ?? {}).length,
                    incoming: sessions.length,
                    changed: plan.changedCount,
                });
                scheduleWarmSessionCacheSave(next as SessionsDomain & SessionsDomainDependencies);
            }
            return next;
        }),
        applySessionListRenderablePatches: (patches) => set((state) => {
            if (patches.length === 0) {
                return state;
            }

            const plan = planSessionListRenderablePatchesCommit({
                state,
                patches,
            });
            syncPerformanceTelemetry.count('sync.store.sessions.renderables.patch', {
                patches: patches.length,
                changed: plan.changedCount,
                noopPatches: plan.noopPatchCount,
                missing: plan.missingCount,
                listRebuild: plan.needsSessionListViewDataRebuild ? 1 : 0,
                listViewFieldChanges: plan.listViewFieldChangeCount,
                attentionPromotionFieldChanges: plan.attentionPromotionFieldChangeCount,
                warmCacheRelevant: plan.didWarmCacheRelevantRenderableChange ? 1 : 0,
            });

            if (plan.noop) {
                return state;
            }

            const nextState = applySessionListRenderableCommitPlan({
                state,
                plan,
                measureListRebuild: (compute) => measureSessionApplyPhase(
                    'sync.store.sessions.renderables.patch.listRebuild',
                    () => ({
                        renderables: Object.keys(plan.nextRenderables).length,
                        patches: patches.length,
                        changed: plan.changedCount,
                        missing: plan.missingCount,
                        listViewFieldChanges: plan.listViewFieldChangeCount,
                        attentionPromotionFieldChanges: plan.attentionPromotionFieldChangeCount,
                    }),
                    compute,
                ),
            });

            if (plan.didImmediateWarmCacheRelevantRenderableChange) {
                syncPerformanceTelemetry.count('sync.store.sessions.renderables.patch.warmCache.deferred', {
                    renderables: Object.keys(nextState.sessionListRenderables ?? {}).length,
                    patches: patches.length,
                    changed: plan.changedCount,
                    missing: plan.missingCount,
                    immediate: 1,
                });
                scheduleWarmSessionCacheSave(nextState as SessionsDomain & SessionsDomainDependencies);
            } else if (plan.didDeferredWarmCacheRelevantRenderableChange) {
                syncPerformanceTelemetry.count('sync.store.sessions.renderables.patch.warmCache.deferred', {
                    renderables: Object.keys(nextState.sessionListRenderables ?? {}).length,
                    patches: patches.length,
                    changed: plan.changedCount,
                    missing: plan.missingCount,
                });
                scheduleWarmSessionCacheSave(nextState as SessionsDomain & SessionsDomainDependencies);
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
        markSessionResuming: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            const resumingAt = Date.now();

            // A previous accepted resume may still have its bounded fallback armed. A new
            // attempt owns this lifecycle now and remains marked for the full RPC duration.
            resumingTimeouts.cancel(sessionId);

            const nextSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    resumingAt,
                },
            };

            const renderable = state.sessionListRenderables[sessionId];
            const nextRenderables = renderable && (renderable.resumingAt ?? null) !== resumingAt
                ? {
                    ...state.sessionListRenderables,
                    [sessionId]: {
                        ...renderable,
                        resumingAt,
                    },
                }
                : state.sessionListRenderables;
            const nextStateBase = {
                ...state,
                sessions: nextSessions,
                sessionListRenderables: nextRenderables,
            };
            const shouldRebuildSessionListViewData = nextRenderables !== state.sessionListRenderables
                && shouldRebuildOnSessionPlacementFieldsChange(state.settings);

            return {
                ...nextStateBase,
                sessionListViewData: shouldRebuildSessionListViewData
                    ? buildSessionListViewDataForState(nextStateBase)
                    : state.sessionListViewData,
            };
        }),
        armSessionResumingFallback: (sessionId: string) => {
            const resumingAt = get().sessions[sessionId]?.resumingAt ?? null;
            if (resumingAt === null) return;

            resumingTimeouts.schedule(sessionId, SESSION_RESUMING_PRESENTATION_TIMEOUT_MS, () => {
                // Activity or a newer resume may have settled/replaced this lifecycle before the
                // safety net fires. Only the exact accepted attempt may clear its own marker.
                clearSessionResumingMarker(sessionId, resumingAt);
            });
        },
        clearSessionResuming: (sessionId: string) => clearSessionResumingMarker(sessionId),
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
            const renderable = state.sessionListRenderables[sessionId];
            const nextRenderables = renderable && (renderable.thinkingGraceUntil ?? null) !== null
                ? {
                    ...state.sessionListRenderables,
                    [sessionId]: {
                        ...renderable,
                        thinkingGraceUntil: null,
                    },
                }
                : state.sessionListRenderables;
            const nextStateBase = {
                ...state,
                sessions: nextSessions,
                sessionListRenderables: nextRenderables,
            };
            const shouldRebuildSessionListViewData = nextRenderables !== state.sessionListRenderables
                && shouldRebuildOnSessionPlacementFieldsChange(state.settings);

            return {
                ...nextStateBase,
                sessionListViewData: shouldRebuildSessionListViewData
                    ? buildSessionListViewDataForState(nextStateBase)
                    : state.sessionListViewData,
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

            const persisted = persistSessionPermissionData(updatedSessions, sessionLocalStateScope, {
                modes: sessionPermissionModes,
                updatedAts: sessionPermissionModeUpdatedAts,
            });
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

            const persisted = persistSessionModelData(updatedSessions, sessionLocalStateScope, {
                modes: sessionModelModes,
                updatedAts: sessionModelModeUpdatedAts,
            });
            if (persisted) {
                sessionModelModes = persisted.modes;
                sessionModelModeUpdatedAts = persisted.updatedAts;
            }

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
        publishSessionProjectScmSnapshots: (publishes) => {
            // A project SCM refresh publishes to every session sharing the repo. Doing that
            // through the individual snapshot/status/prune actions costs up to six store
            // notifications per session; every notification re-runs all store subscribers,
            // which starves the JS thread on large accounts. All project-manager mutations
            // happen here first, then a single notification covers the whole batch.
            if (publishes.length === 0) return;
            const statusUpdates: Record<string, ScmStatus | null> = {};
            for (const { sessionId, snapshot, status } of publishes) {
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
                projectManager.pruneSessionProjectScmTouchedPaths(sessionId, activePaths);
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
            optimisticThinkingTimeouts.cancel(sessionId);
            resumingTimeouts.cancel(sessionId);
            thinkingGraceTimeouts.cancel(sessionId);

	            // Remove session from sessions
	            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;
            const { [sessionId]: _deletedRenderable, ...remainingRenderables } = state.sessionListRenderables;
            
            // Remove session messages if they exist, along with the module-scoped
            // derived caches that root the transcript outside the store.
            const { [sessionId]: deletedMessages, ...remainingSessionMessages } = state.sessionMessages;
            clearSessionTranscriptDerivedCachesForSession(sessionId);

            // Remove session source-control status if it exists
            const { [sessionId]: _deletedScmStatus, ...remainingScmStatus } = state.sessionScmStatus;
            const { [sessionId]: _deletedTreeState, ...remainingTreeState } = state.sessionRepositoryTreeExpandedPathsBySessionId;
            sessionRepositoryTreeExpandedPathsBySessionId = remainingTreeState;
            const { [sessionId]: _deletedReviewDrafts, ...remainingReviewDrafts } = state.reviewCommentsDraftsBySessionId;
            reviewCommentsDraftsBySessionId = remainingReviewDrafts;
            const { [sessionId]: _deletedActionDrafts, ...remainingActionDrafts } = state.actionDraftsBySessionId;
            actionDraftsBySessionId = remainingActionDrafts;
            
            // Clear canonical draft and permission modes from persistent storage.
            const reviewDrafts = loadSessionReviewCommentsDrafts(sessionLocalStateScope);
            delete reviewDrafts[sessionId];
            saveSessionReviewCommentsDrafts(reviewDrafts, sessionLocalStateScope);

            const actionDrafts = loadSessionActionDrafts(sessionLocalStateScope);
            delete actionDrafts[sessionId];
            saveSessionActionDrafts(actionDrafts, sessionLocalStateScope);

            if (sessionLocalStateScope) {
                fireAndForget(
                    deleteSessionDraft({
                        scope: sessionLocalStateScope,
                        address: { kind: 'session', sessionId },
                    }),
                    { tag: 'sessions.sessionDeleted.deleteSessionDraft' },
                );
            }
            clearAgentInputLocalUiStateForSession(sessionLocalStateScope, sessionId);
            
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
                // The only durable record that this id is gone rather than merely uncached.
                deletedSessionIds: { ...state.deletedSessionIds, [sessionId]: true as const },
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
