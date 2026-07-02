import type { Session } from '../../state/storageTypes';

export type ReachableTargetPeerSession = Readonly<{
    id: string;
    active: boolean;
    machineId: string | null;
    hostHint: string | null;
    projectMachineId: string | null;
}>;

export type ComparableBasePathPeerSessionResolution = Readonly<{
    comparableBasePath: string;
    peerSession: ReachableTargetPeerSession;
}>;

export type ComparableBasePathPeerSessionSource = Readonly<Pick<Session, 'id' | 'active'>>;

export type BuildComparableBasePathPeerSessionsParams<TSession extends ComparableBasePathPeerSessionSource = ComparableBasePathPeerSessionSource> = Readonly<{
    sessionRecords: Record<string, TSession>;
    unresolvedComparableBasePaths: ReadonlySet<string>;
    resolveComparableBasePathAndPeerSession: (
        sessionId: string,
        sessionRecord: TSession,
    ) => ComparableBasePathPeerSessionResolution | null;
}>;

const EMPTY_COMPARABLE_BASE_PATH_PEER_SESSIONS: readonly ReachableTargetPeerSession[] = [];

function compareReachableTargetPeerSessions(a: ReachableTargetPeerSession, b: ReachableTargetPeerSession): number {
    const activeDelta = Number(Boolean(b.active)) - Number(Boolean(a.active));
    if (activeDelta !== 0) {
        return activeDelta;
    }
    return a.id.localeCompare(b.id);
}

export function buildComparableBasePathPeerSessions<TSession extends ComparableBasePathPeerSessionSource>(
    params: BuildComparableBasePathPeerSessionsParams<TSession>,
): Map<string, ReachableTargetPeerSession[]> {
    const peerSessionsByComparableBasePath = new Map<string, ReachableTargetPeerSession[]>();

    for (const sessionId in params.sessionRecords) {
        const sessionRecord = params.sessionRecords[sessionId];
        const resolution = params.resolveComparableBasePathAndPeerSession(sessionId, sessionRecord);
        if (!resolution || !params.unresolvedComparableBasePaths.has(resolution.comparableBasePath)) {
            continue;
        }

        const peerSessions = peerSessionsByComparableBasePath.get(resolution.comparableBasePath) ?? [];
        peerSessions.push(resolution.peerSession);
        peerSessionsByComparableBasePath.set(resolution.comparableBasePath, peerSessions);
    }

    for (const peerSessions of peerSessionsByComparableBasePath.values()) {
        if (peerSessions.length > 1) {
            peerSessions.sort(compareReachableTargetPeerSessions);
        }
    }

    return peerSessionsByComparableBasePath;
}

export function listComparableBasePathPeerSessions(
    peerSessionsByComparableBasePath: ReadonlyMap<string, ReadonlyArray<ReachableTargetPeerSession>>,
    comparableBasePath: string | null | undefined,
): ReadonlyArray<ReachableTargetPeerSession> {
    if (!comparableBasePath) {
        return EMPTY_COMPARABLE_BASE_PATH_PEER_SESSIONS;
    }

    return peerSessionsByComparableBasePath.get(comparableBasePath) ?? EMPTY_COMPARABLE_BASE_PATH_PEER_SESSIONS;
}
