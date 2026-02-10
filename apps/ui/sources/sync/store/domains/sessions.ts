import type { GitStatus, GitWorkingSnapshot, Machine, Session } from '../../domains/state/storageTypes';
import type { NormalizedMessage } from '../../typesRaw';
import type { SessionListViewItem } from '../../domains/session/listing/sessionListViewData';
import { nowServerMs } from '../../runtime/time';
import { loadSessionDrafts, loadSessionLastViewed, loadSessionModelModeUpdatedAts, loadSessionModelModes, loadSessionPermissionModeUpdatedAts, loadSessionPermissionModes, saveSessionDrafts, saveSessionLastViewed, saveSessionModelModeUpdatedAts, saveSessionModelModes, saveSessionPermissionModeUpdatedAts, saveSessionPermissionModes } from '../../domains/state/persistence';
import { projectManager } from '../../runtime/orchestration/projectManager';
import { isModelMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { parsePermissionIntentAlias, resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import { buildSessionListViewDataWithServerScope } from '../buildSessionListViewDataWithServerScope';
import { setActiveServerSessionListCache } from '../sessionListCache';

import type { StoreGet, StoreSet } from './_shared';
import { applyAgentStateUpdateToSessionMessages } from './messages';
import type { SessionMessages } from './messages';
import { persistSessionPermissionData } from './sessionPermissionPersistence';

type SessionModelMode = NonNullable<Session['modelMode']>;
type GitOperationLogEntry = import('../../runtime/orchestration/projectManager').GitProjectOperationLogEntry;
type GitInFlightOperation = import('../../runtime/orchestration/projectManager').GitProjectInFlightOperation;
type BeginGitOperationResult = import('../../runtime/orchestration/projectManager').BeginGitProjectOperationResult;

export type SessionsDomain = {
    sessions: Record<string, Session>;
    sessionsData: (string | Session)[] | null;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
    sessionGitStatus: Record<string, GitStatus | null>;
    sessionLastViewed: Record<string, number>;
    isDataReady: boolean;

    getActiveSessions: () => Session[];
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[]) => void;
    applyLoaded: () => void;
    applyReady: () => void;

    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    markSessionOptimisticThinking: (sessionId: string) => void;
    clearSessionOptimisticThinking: (sessionId: string) => void;
    markSessionViewed: (sessionId: string) => void;
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    updateSessionModelMode: (sessionId: string, mode: SessionModelMode) => void;

    getProjects: () => import('../../runtime/orchestration/projectManager').Project[];
    getProject: (projectId: string) => import('../../runtime/orchestration/projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('../../runtime/orchestration/projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];

    getProjectGitStatus: (projectId: string) => GitStatus | null;
    getSessionProjectGitStatus: (sessionId: string) => GitStatus | null;
    updateSessionProjectGitStatus: (sessionId: string, status: GitStatus | null) => void;
    getProjectGitSnapshot: (projectId: string) => GitWorkingSnapshot | null;
    getSessionProjectGitSnapshot: (sessionId: string) => GitWorkingSnapshot | null;
    updateSessionProjectGitSnapshot: (sessionId: string, snapshot: GitWorkingSnapshot | null) => void;
    getSessionProjectGitTouchedPaths: (sessionId: string) => string[];
    markSessionProjectGitTouchedPaths: (sessionId: string, paths: string[]) => void;
    pruneSessionProjectGitTouchedPaths: (sessionId: string, activePaths: Set<string>) => void;
    getSessionProjectGitOperationLog: (sessionId: string) => GitOperationLogEntry[];
    appendSessionProjectGitOperation: (
        sessionId: string,
        entry: Omit<GitOperationLogEntry, 'id' | 'sessionId'>,
    ) => void;
    getSessionProjectGitInFlightOperation: (sessionId: string) => GitInFlightOperation | null;
    beginSessionProjectGitOperation: (
        sessionId: string,
        operation: import('../../runtime/orchestration/projectManager').GitProjectOperationKind,
    ) => BeginGitOperationResult;
    finishSessionProjectGitOperation: (sessionId: string, operationId: string) => boolean;

    deleteSession: (sessionId: string) => void;
};

type SessionsDomainDependencies = {
    machines: Record<string, Machine>;
    sessionMessages: Record<string, SessionMessages>;
    // Keep resilient: older settings payloads (or partial boot states) may not yet include this key.
    settings: { groupInactiveSessionsByProject?: boolean };
};

// UI-only "optimistic processing" marker.
// Cleared via timers so components don't need to poll time.
const OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS = 15_000;
const optimisticThinkingTimeoutBySessionId = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Centralized session online state resolver
 * Returns either "online" (string) or a timestamp (number) for last seen
 */
function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): "online" | number {
    // Session is online if the active flag is true
    return session.active ? "online" : session.activeAt;
}

/**
 * Checks if a session should be shown in the active sessions group
 */
function isSessionActive(session: { active: boolean; activeAt: number }): boolean {
    // Use the active flag directly, no timeout checks
    return session.active;
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

    return {
        sessions: {},
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionGitStatus: {},
        sessionLastViewed,
        isDataReady: false,
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
	        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[]) => set((state) => {
            // Load drafts and permission modes if sessions are empty (initial load)
            const savedDrafts = Object.keys(state.sessions).length === 0 ? sessionDrafts : {};
            const savedPermissionModes = Object.keys(state.sessions).length === 0 ? sessionPermissionModes : {};
            const savedModelModes = Object.keys(state.sessions).length === 0 ? sessionModelModes : {};
            const savedPermissionModeUpdatedAts = Object.keys(state.sessions).length === 0 ? sessionPermissionModeUpdatedAts : {};
            const savedModelModeUpdatedAts = Object.keys(state.sessions).length === 0 ? sessionModelModeUpdatedAts : {};

            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Preserve existing draft and permission mode if they exist, or load from saved data
                const existingDraft = state.sessions[session.id]?.draft;
                const savedDraft = savedDrafts[session.id];
                const existingPermissionMode = state.sessions[session.id]?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                const existingModelMode = state.sessions[session.id]?.modelMode;
                const savedModelMode = savedModelModes[session.id];
                const existingPermissionModeUpdatedAt = state.sessions[session.id]?.permissionModeUpdatedAt;
                const savedPermissionModeUpdatedAt = savedPermissionModeUpdatedAts[session.id];
                const existingModelModeUpdatedAt = state.sessions[session.id]?.modelModeUpdatedAt;
                const savedModelModeUpdatedAt = savedModelModeUpdatedAts[session.id];
                const existingOptimisticThinkingAt = state.sessions[session.id]?.optimisticThinkingAt ?? null;

                // CLI may publish a session permission mode in encrypted metadata for local-only starts.
                // This is a fallback signal for when there are no app-sent user messages carrying meta.permissionMode yet.
                const metadataPermission = resolvePermissionIntentFromSessionMetadata(session.metadata);
                const metadataCanonicalPermissionMode = metadataPermission?.intent ?? null;
                const metadataPermissionModeUpdatedAt = metadataPermission?.updatedAt ?? null;

                let mergedPermissionMode =
                    existingPermissionMode ||
                    savedPermissionMode ||
                    session.permissionMode ||
                    'default';

                let mergedPermissionModeUpdatedAt =
                    existingPermissionModeUpdatedAt ??
                    savedPermissionModeUpdatedAt ??
                    null;

                if (metadataCanonicalPermissionMode && typeof metadataPermissionModeUpdatedAt === 'number') {
                    const localUpdatedAt = mergedPermissionModeUpdatedAt ?? 0;
                    if (metadataPermissionModeUpdatedAt > localUpdatedAt) {
                        mergedPermissionMode = metadataCanonicalPermissionMode;
                        mergedPermissionModeUpdatedAt = metadataPermissionModeUpdatedAt;
                    }
                }

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

                mergedSessions[session.id] = {
                    ...session,
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    optimisticThinkingAt: session.thinking === true ? null : existingOptimisticThinkingAt,
                    permissionMode: mergedPermissionMode,
                    // Preserve local coordination timestamp (not synced to server)
                    permissionModeUpdatedAt: mergedPermissionModeUpdatedAt,
                    modelMode: mergedModelMode,
                    modelModeUpdatedAt: mergedModelModeUpdatedAt,
                };
            });

            // Build active set from all sessions (including existing ones)
            const activeSet = new Set<string>();
            Object.values(mergedSessions).forEach(session => {
                if (isSessionActive(session)) {
                    activeSet.add(session.id);
                }
            });

            // Separate active and inactive sessions
            const activeSessions: Session[] = [];
            const inactiveSessions: Session[] = [];

            // Process all sessions from merged set
            Object.values(mergedSessions).forEach(session => {
                if (activeSet.has(session.id)) {
                    activeSessions.push(session);
                } else {
                    inactiveSessions.push(session);
                }
            });

            // Sort both arrays by creation date for stable ordering
            activeSessions.sort((a, b) => b.createdAt - a.createdAt);
            inactiveSessions.sort((a, b) => b.createdAt - a.createdAt);

            // Build flat list data for FlashList
            const listData: (string | Session)[] = [];

            if (activeSessions.length > 0) {
                listData.push('online');
                listData.push(...activeSessions);
            }

            // Legacy sessionsData - to be removed
            // Machines are now integrated into sessionListViewData

            if (inactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...inactiveSessions);
            }

            // Process AgentState updates for sessions that already have messages loaded
            const updatedSessionMessages = { ...state.sessionMessages };

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
                    updatedSessionMessages[session.id] = {
                        ...updated.sessionMessages,
                        isLoaded: existingSessionMessages.isLoaded,
                    };
                    if (updated.sessionLatestUsage !== undefined) {
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            latestUsage: updated.sessionLatestUsage,
                        };
                    }
                    if (updated.sessionTodos !== undefined) {
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            todos: updated.sessionTodos,
                        };
                    }
                }
            });

            // Build new unified list view data
            const sessionListViewData = buildSessionListViewDataWithServerScope({
                sessions: mergedSessions,
                machines: state.machines,
                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
            });

            // Update project manager with current sessions and machines
            const machineMetadataMap = new Map<string, any>();
            Object.values(state.machines).forEach(machine => {
                if (machine.metadata) {
                    machineMetadataMap.set(machine.id, machine.metadata);
                }
            });
            projectManager.updateSessions(Object.values(mergedSessions), machineMetadataMap);

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData,  // Legacy - to be removed
                sessionListViewData,
                sessionListViewDataByServerId: setActiveServerSessionListCache(
                    state.sessionListViewDataByServerId,
                    sessionListViewData,
                ),
                sessionMessages: updatedSessionMessages
            };
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsData: []
            };
            return result;
        }),
        applyReady: () => set((state) => ({
            ...state,
            isDataReady: true
        })),
        applyGitStatus: (sessionId: string, status: GitStatus | null) => set((state) => {
            // Update project git status as well
            projectManager.updateSessionProjectGitStatus(sessionId, status);

            return {
                ...state,
                sessionGitStatus: {
                    ...state.sessionGitStatus,
                    [sessionId]: status
                }
            };
        }),
        updateSessionDraft: (sessionId: string, draft: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Don't store empty strings, convert to null
            const normalizedDraft = draft?.trim() ? draft : null;

            // Collect all drafts for persistence
            const allDrafts: Record<string, string> = {};
            Object.entries(state.sessions).forEach(([id, sess]) => {
                if (id === sessionId) {
                    if (normalizedDraft) {
                        allDrafts[id] = normalizedDraft;
                    }
                } else if (sess.draft) {
                    allDrafts[id] = sess.draft;
                }
            });

            // Persist drafts
            saveSessionDrafts(allDrafts);

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    draft: normalizedDraft
                }
            };

            // Rebuild sessionListViewData to update the UI immediately
            const sessionListViewData = buildSessionListViewDataWithServerScope({
                sessions: updatedSessions,
                machines: state.machines,
                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
            });

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData,
                sessionListViewDataByServerId: setActiveServerSessionListCache(
                    state.sessionListViewDataByServerId,
                    sessionListViewData,
                ),
            };
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
            const sessionListViewData = buildSessionListViewDataWithServerScope({
                sessions: nextSessions,
                machines: state.machines,
                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
            });

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
                    const nextSessionListViewData = buildSessionListViewDataWithServerScope({
                        sessions: next,
                        machines: s.machines,
                        groupInactiveSessionsByProject: s.settings.groupInactiveSessionsByProject === true,
                    });
                    return {
                        ...s,
                        sessions: next,
                        sessionListViewData: nextSessionListViewData,
                        sessionListViewDataByServerId: setActiveServerSessionListCache(
                            s.sessionListViewDataByServerId,
                            nextSessionListViewData,
                        ),
                    };
                });
            }, OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS);
            optimisticThinkingTimeoutBySessionId.set(sessionId, timeout);

            return {
                ...state,
                sessions: nextSessions,
                sessionListViewData,
                sessionListViewDataByServerId: setActiveServerSessionListCache(
                    state.sessionListViewDataByServerId,
                    sessionListViewData,
                ),
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
            const nextSessionListViewData = buildSessionListViewDataWithServerScope({
                sessions: nextSessions,
                machines: state.machines,
                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
            });

            return {
                ...state,
                sessions: nextSessions,
                sessionListViewData: nextSessionListViewData,
                sessionListViewDataByServerId: setActiveServerSessionListCache(
                    state.sessionListViewDataByServerId,
                    nextSessionListViewData,
                ),
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
        // Project git status methods
        getProjectGitStatus: (projectId: string) => projectManager.getProjectGitStatus(projectId),
        getSessionProjectGitStatus: (sessionId: string) => projectManager.getSessionProjectGitStatus(sessionId),
        updateSessionProjectGitStatus: (sessionId: string, status: GitStatus | null) => {
            projectManager.updateSessionProjectGitStatus(sessionId, status);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
        },
        getProjectGitSnapshot: (projectId: string) => projectManager.getProjectGitSnapshot(projectId),
        getSessionProjectGitSnapshot: (sessionId: string) => projectManager.getSessionProjectGitSnapshot(sessionId),
        updateSessionProjectGitSnapshot: (sessionId: string, snapshot: GitWorkingSnapshot | null) => {
            projectManager.updateSessionProjectGitSnapshot(sessionId, snapshot);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
        },
        getSessionProjectGitTouchedPaths: (sessionId: string) => projectManager.getSessionProjectGitTouchedPaths(sessionId),
        markSessionProjectGitTouchedPaths: (sessionId: string, paths: string[]) => {
            projectManager.markSessionProjectGitTouchedPaths(sessionId, paths);
            set((state) => ({ ...state }));
        },
        pruneSessionProjectGitTouchedPaths: (sessionId: string, activePaths: Set<string>) => {
            projectManager.pruneSessionProjectGitTouchedPaths(sessionId, activePaths);
            set((state) => ({ ...state }));
        },
        getSessionProjectGitOperationLog: (sessionId: string) => projectManager.getSessionProjectGitOperationLog(sessionId),
        appendSessionProjectGitOperation: (
            sessionId: string,
            entry: Omit<GitOperationLogEntry, 'id' | 'sessionId'>,
        ) => {
            projectManager.appendSessionProjectGitOperation(sessionId, entry);
            set((state) => ({ ...state }));
        },
        getSessionProjectGitInFlightOperation: (sessionId: string) =>
            projectManager.getSessionProjectGitInFlightOperation(sessionId),
        beginSessionProjectGitOperation: (
            sessionId: string,
            operation: import('../../runtime/orchestration/projectManager').GitProjectOperationKind,
        ) => {
            const result = projectManager.beginSessionProjectGitOperation(sessionId, operation);
            if (result.started || result.reason === 'operation_in_flight') {
                set((state) => ({ ...state }));
            }
            return result;
        },
        finishSessionProjectGitOperation: (sessionId: string, operationId: string) => {
            const finished = projectManager.finishSessionProjectGitOperation(sessionId, operationId);
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

	            // Remove session from sessions
	            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;
            
            // Remove session messages if they exist
            const { [sessionId]: deletedMessages, ...remainingSessionMessages } = state.sessionMessages;
            
            // Remove session git status if it exists
            const { [sessionId]: deletedGitStatus, ...remainingGitStatus } = state.sessionGitStatus;
            
            // Clear drafts and permission modes from persistent storage
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);
            
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
            const sessionListViewData = buildSessionListViewDataWithServerScope({
                sessions: remainingSessions,
                machines: state.machines,
                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
            });
            
            return {
                ...state,
                sessions: remainingSessions,
                sessionMessages: remainingSessionMessages,
                sessionGitStatus: remainingGitStatus,
                sessionLastViewed: { ...sessionLastViewed },
                sessionListViewData,
                sessionListViewDataByServerId: setActiveServerSessionListCache(
                    state.sessionListViewDataByServerId,
                    sessionListViewData,
                ),
            };
        }),
    };
}
