export type SessionListSecondaryLineMode = 'status' | 'path';

/**
 * The list's one recency fact.
 *
 * Only committed transcript evidence, queued human input, the session-level
 * meaningful-activity fact and creation count. Transient thinking is operational
 * presentation, so it deliberately has no input here and cannot make a streaming row
 * climb the timeline on every heartbeat.
 */
export function deriveSessionListMeaningfulActivityAt(params: Readonly<{
    sessionMeaningfulActivityAt?: number | null | undefined;
    sessionCreatedAt: number | null | undefined;
    latestCommittedMessageCreatedAt: number | null | undefined;
    latestPendingMessageCreatedAt: number | null | undefined;
}>): number | null {
    let latest: number | null = null;

    const include = (value: number | null | undefined) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
        latest = latest == null ? value : Math.max(latest, value);
    };

    const sessionMeaningfulActivityAt = params.sessionMeaningfulActivityAt;
    include(sessionMeaningfulActivityAt);
    const committed = params.latestCommittedMessageCreatedAt;
    include(committed);
    const pending = params.latestPendingMessageCreatedAt;
    include(pending);
    const sessionCreatedAt = params.sessionCreatedAt;
    include(sessionCreatedAt);

    return latest;
}

export function resolveSessionListSecondaryLineMode(params: Readonly<{
    groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'loading' | 'folder' | 'attention' | 'working' | null;
}>): SessionListSecondaryLineMode {
    if (params.groupKind === 'date') {
        return 'path';
    }
    return 'status';
}
