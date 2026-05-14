import type { StoreGet, StoreSet } from './_shared';
import { buildSessionFolderAssignmentKey } from '@/sync/domains/session/folders';

export type SessionFolderAssignment = Readonly<{
    sessionId: string;
    folderId: string | null;
}>;

export type SessionFoldersDomain = {
    sessionFolderAssignmentsBySessionKey: Record<string, string | null>;
    sessionFolderAssignmentsLoadingByServerId: Record<string, boolean>;
    applySessionFolderAssignments: (serverId: string, assignments: readonly SessionFolderAssignment[]) => void;
    setSessionFolderAssignmentsLoading: (serverId: string, loading: boolean) => void;
    setSessionFolderAssignmentOptimistic: (serverId: string, sessionId: string, folderId: string | null) => string | null;
    rollbackSessionFolderAssignment: (serverId: string, sessionId: string, previousFolderId: string | null) => void;
    clearSessionFolderAssignmentsForServer: (serverId: string) => void;
};

export function createSessionFoldersDomain<S extends SessionFoldersDomain>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): SessionFoldersDomain {
    return {
        sessionFolderAssignmentsBySessionKey: {},
        sessionFolderAssignmentsLoadingByServerId: {},
        applySessionFolderAssignments: (serverId, assignments) => {
            set((state) => {
                const next = { ...state.sessionFolderAssignmentsBySessionKey };
                for (const assignment of assignments) {
                    next[buildSessionFolderAssignmentKey(serverId, assignment.sessionId)] = assignment.folderId;
                }
                return { sessionFolderAssignmentsBySessionKey: next } as Partial<S>;
            });
        },
        setSessionFolderAssignmentsLoading: (serverId, loading) => {
            set((state) => ({
                sessionFolderAssignmentsLoadingByServerId: {
                    ...state.sessionFolderAssignmentsLoadingByServerId,
                    [serverId]: loading,
                },
            }) as Partial<S>);
        },
        setSessionFolderAssignmentOptimistic: (serverId, sessionId, folderId) => {
            const key = buildSessionFolderAssignmentKey(serverId, sessionId);
            const previous = get().sessionFolderAssignmentsBySessionKey[key] ?? null;
            set((state) => ({
                sessionFolderAssignmentsBySessionKey: {
                    ...state.sessionFolderAssignmentsBySessionKey,
                    [key]: folderId,
                },
            }) as Partial<S>);
            return previous;
        },
        rollbackSessionFolderAssignment: (serverId, sessionId, previousFolderId) => {
            const key = buildSessionFolderAssignmentKey(serverId, sessionId);
            set((state) => ({
                sessionFolderAssignmentsBySessionKey: {
                    ...state.sessionFolderAssignmentsBySessionKey,
                    [key]: previousFolderId,
                },
            }) as Partial<S>);
        },
        clearSessionFolderAssignmentsForServer: (serverId) => {
            const prefix = `${String(serverId).trim()}:`;
            set((state) => ({
                sessionFolderAssignmentsBySessionKey: Object.fromEntries(
                    Object.entries(state.sessionFolderAssignmentsBySessionKey)
                        .filter(([key]) => !key.startsWith(prefix)),
                ),
                sessionFolderAssignmentsLoadingByServerId: Object.fromEntries(
                    Object.entries(state.sessionFolderAssignmentsLoadingByServerId)
                        .filter(([key]) => key !== serverId),
                ),
            }) as Partial<S>);
        },
    };
}
