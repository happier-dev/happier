import {
    resolveDisplayIdentityForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';
import {
    encodeSessionRecentPathEntry,
    type SessionRecentPathEntry,
} from '@/utils/sessions/recentPathEntries';

/**
 * The recent-path projection: for every session this viewer holds a full record for, the machine
 * and path a "recent paths" surface would show it under, newest session first.
 *
 * It is a pure function of the state handed to it, and its one consumer —
 * `useSessionRecentPathEntries` — derives it inside the selector. That is only sound while the
 * derivation stays a read: the caller supplies the *pure* project resolver
 * (`createProjectForSessionResolver`), and the display resolver indexes the store's own id-keyed
 * machine record rather than rebuilding one per session. Hand it the store's registering
 * `getProjectForSession` instead and every read becomes three `Map` writes per path-bearing
 * session — the defect this shape exists to prevent.
 */
function readCreatedAt(session: { createdAt?: number | null } | null | undefined): number {
    const createdAt = session?.createdAt;
    return typeof createdAt === 'number' ? (createdAt || 0) : 0;
}

export function buildSessionRecentPathEntries(
    state: SessionMachineTargetState,
): SessionRecentPathEntry[] {
    const sessions = state.sessions ?? {};
    const entries: Array<{ key: SessionRecentPathEntry; createdAt: number }> = [];

    // The session record map is keyed by session id by every writer, and the display resolver
    // looks the session up by that same key — so the key is the id the entry must carry.
    for (const [sessionId, session] of Object.entries(sessions)) {
        const { machineId, basePath: path } = resolveDisplayIdentityForSessionFromState({
            state,
            sessionId,
            metadata: session.metadata ?? null,
        });
        if (!machineId || !path) continue;

        const createdAt = readCreatedAt(session as { createdAt?: number | null });
        entries.push({
            key: encodeSessionRecentPathEntry({ sessionId, machineId, path, createdAt }),
            createdAt,
        });
    }

    return entries
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((entry) => entry.key);
}
