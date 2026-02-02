import type { ApiChangeEntry } from './apiTypes';

export type PlannedKvAction =
    | { type: 'none' }
    | { type: 'refresh-feature'; feature: 'todos' }
    | { type: 'bulk-keys'; feature: 'todos'; keys: string[] };

export type PlannedChangeActions = {
    sessionIdsToCatchUp: string[];
    invalidate: {
        sessions: boolean;
        machines: boolean;
        artifacts: boolean;
        settings: boolean;
        profile: boolean;
        friends: boolean;
        feed: boolean;
    };
    kv: PlannedKvAction;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function planSyncActionsFromChanges(changes: ApiChangeEntry[]): PlannedChangeActions {
    const sessionIds = new Set<string>();
    let invalidateSessions = false;
    let invalidateMachines = false;
    let invalidateArtifacts = false;
    let invalidateSettings = false;
    let invalidateProfile = false;
    let invalidateFriends = false;
    let invalidateFeed = false;

    let kvFull = false;
    const kvKeys = new Set<string>();

    for (const change of changes) {
        const kind = change.kind;
        if (kind === 'session' || kind === 'share') {
            invalidateSessions = true;
            if (typeof change.entityId === 'string' && change.entityId.length > 0) {
                sessionIds.add(change.entityId);
            }
            continue;
        }

        if (kind === 'account') {
            invalidateSettings = true;
            invalidateProfile = true;
            continue;
        }

        if (kind === 'machine') {
            invalidateMachines = true;
            continue;
        }

        if (kind === 'artifact') {
            invalidateArtifacts = true;
            continue;
        }

        if (kind === 'friends') {
            invalidateFriends = true;
            continue;
        }

        if (kind === 'feed') {
            invalidateFeed = true;
            continue;
        }

        if (kind === 'kv') {
            const hint = change.hint;
            if (!isRecord(hint)) {
                kvFull = true;
                continue;
            }
            if (hint.full === true) {
                kvFull = true;
                continue;
            }
            const keys = hint.keys;
            if (Array.isArray(keys)) {
                for (const key of keys) {
                    if (typeof key === 'string' && key.length > 0) {
                        kvKeys.add(key);
                    }
                }
                continue;
            }
            kvFull = true;
            continue;
        }

        // Forward-compatible: unknown kinds trigger a safe sessions refresh.
        invalidateSessions = true;
    }

    const kv: PlannedKvAction = kvFull
        ? { type: 'refresh-feature', feature: 'todos' }
        : kvKeys.size > 0
            ? { type: 'bulk-keys', feature: 'todos', keys: Array.from(kvKeys).sort() }
            : { type: 'none' };

    return {
        sessionIdsToCatchUp: Array.from(sessionIds).sort(),
        invalidate: {
            sessions: invalidateSessions,
            machines: invalidateMachines,
            artifacts: invalidateArtifacts,
            settings: invalidateSettings,
            profile: invalidateProfile,
            friends: invalidateFriends,
            feed: invalidateFeed,
        },
        kv,
    };
}

