import type {
    SessionRunnerProcessIdentityV2,
    SessionRunnerRuntimeStateV1,
} from '@happier-dev/protocol';

export type SessionRunnerRuntimeStatusIdentity = Readonly<{
    serverId: string;
    machineId: string;
    sessionId: string;
}>;

export type SessionRunnerRuntimeStatusSnapshot = SessionRunnerRuntimeStatusIdentity & Readonly<{
    state: SessionRunnerRuntimeStateV1;
    runnerProcessIdentity: SessionRunnerProcessIdentityV2 | null;
}>;

type SessionRunnerRuntimeStatusRefresh = Readonly<{
    identity: SessionRunnerRuntimeStatusIdentity;
    identityKey: string;
}>;

export type SessionRunnerRuntimeStatusRetention = Readonly<{
    read: (identity: SessionRunnerRuntimeStatusIdentity) => SessionRunnerRuntimeStatusSnapshot | null;
    beginRefresh: (identity: SessionRunnerRuntimeStatusIdentity) => SessionRunnerRuntimeStatusRefresh;
    completeRefresh: (
        refresh: SessionRunnerRuntimeStatusRefresh,
        fetched: Readonly<{
            state: SessionRunnerRuntimeStateV1;
            runnerProcessIdentity: SessionRunnerProcessIdentityV2 | null;
        }> | null,
    ) => void;
    clearForTests: () => void;
}>;

const MAX_RETAINED_SESSION_RUNNER_RUNTIME_STATUSES = 32;
const MAX_PENDING_SESSION_RUNNER_RUNTIME_STATUS_REFRESHES = 32;
function buildIdentityKey(identity: SessionRunnerRuntimeStatusIdentity): string {
    return JSON.stringify([identity.serverId, identity.machineId, identity.sessionId]);
}

function evictOldestEntries<Value>(entries: Map<string, Value>, maximumSize: number): void {
    while (entries.size > maximumSize) {
        const oldestIdentityKey = entries.keys().next().value;
        if (typeof oldestIdentityKey !== 'string') return;
        entries.delete(oldestIdentityKey);
    }
}

export function createSessionRunnerRuntimeStatusRetention(): SessionRunnerRuntimeStatusRetention {
    const retainedByIdentity = new Map<string, SessionRunnerRuntimeStatusSnapshot>();
    const latestRefreshByIdentity = new Map<string, SessionRunnerRuntimeStatusRefresh>();

    return {
        clearForTests() {
            retainedByIdentity.clear();
            latestRefreshByIdentity.clear();
        },
        read(identity) {
            const identityKey = buildIdentityKey(identity);
            return retainedByIdentity.get(identityKey) ?? null;
        },
        beginRefresh(identity) {
            const refreshIdentity = { ...identity };
            const identityKey = buildIdentityKey(refreshIdentity);
            const retained = retainedByIdentity.get(identityKey);
            if (retained?.runnerProcessIdentity) {
                retainedByIdentity.set(identityKey, {
                    ...retained,
                    runnerProcessIdentity: null,
                });
            }
            const refresh = {
                identity: refreshIdentity,
                identityKey,
            } satisfies SessionRunnerRuntimeStatusRefresh;

            latestRefreshByIdentity.delete(identityKey);
            latestRefreshByIdentity.set(identityKey, refresh);
            evictOldestEntries(
                latestRefreshByIdentity,
                MAX_PENDING_SESSION_RUNNER_RUNTIME_STATUS_REFRESHES,
            );
            return refresh;
        },
        completeRefresh(refresh, fetched) {
            if (latestRefreshByIdentity.get(refresh.identityKey) !== refresh) {
                return;
            }
            latestRefreshByIdentity.delete(refresh.identityKey);

            const identity = refresh.identity;
            if (!fetched) return;
            const state = fetched.state;
            if (
                state.sessionId !== identity.sessionId
                || state.machineId !== identity.machineId
            ) {
                return;
            }
            const snapshot = {
                ...identity,
                state,
                runnerProcessIdentity: fetched.runnerProcessIdentity,
            } satisfies SessionRunnerRuntimeStatusSnapshot;
            retainedByIdentity.delete(refresh.identityKey);
            retainedByIdentity.set(refresh.identityKey, snapshot);
            evictOldestEntries(
                retainedByIdentity,
                MAX_RETAINED_SESSION_RUNNER_RUNTIME_STATUSES,
            );
        },
    };
}

export const sessionRunnerRuntimeStatusRetention = createSessionRunnerRuntimeStatusRetention();
