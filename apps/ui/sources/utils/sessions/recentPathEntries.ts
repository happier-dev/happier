export type SessionRecentPathEntry = string;

/**
 * The empty recent-path projection. It lives here, with the codec, rather than with the projection
 * builder: the store's initial state reads it while the store module is still evaluating, and the
 * builder module transitively imports the store, so reading it from there is a temporal-dead-zone
 * fault inside that import cycle. This module imports nothing.
 */
export const EMPTY_SESSION_RECENT_PATH_ENTRIES: SessionRecentPathEntry[] = Object.freeze(
    [] as SessionRecentPathEntry[],
) as SessionRecentPathEntry[];

const SESSION_RECENT_PATH_ENTRY_PREFIX = 'happier:session-recent-path:v1:';

type DecodedSessionRecentPathEntry = Readonly<{
    sessionId: string;
    machineId: string;
    path: string;
    createdAt: number;
}>;

export function encodeSessionRecentPathEntry(input: DecodedSessionRecentPathEntry): SessionRecentPathEntry {
    return `${SESSION_RECENT_PATH_ENTRY_PREFIX}${JSON.stringify([
        input.sessionId,
        input.machineId,
        input.path,
        input.createdAt,
    ])}`;
}

export function decodeSessionRecentPathEntry(raw: string): DecodedSessionRecentPathEntry | null {
    if (!raw.startsWith(SESSION_RECENT_PATH_ENTRY_PREFIX)) {
        return null;
    }

    try {
        const decoded = JSON.parse(raw.slice(SESSION_RECENT_PATH_ENTRY_PREFIX.length));
        if (!Array.isArray(decoded) || decoded.length !== 4) {
            return null;
        }

        const [sessionId, machineId, path, createdAt] = decoded;
        if (
            typeof sessionId !== 'string' ||
            typeof machineId !== 'string' ||
            typeof path !== 'string' ||
            typeof createdAt !== 'number' ||
            !Number.isFinite(createdAt)
        ) {
            return null;
        }

        return { sessionId, machineId, path, createdAt };
    } catch {
        return null;
    }
}
