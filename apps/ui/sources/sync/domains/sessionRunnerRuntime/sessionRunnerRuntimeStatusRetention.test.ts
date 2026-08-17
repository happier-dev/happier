import type { SessionRunnerRuntimeStateV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    createSessionRunnerRuntimeStatusRetention,
    type SessionRunnerRuntimeStatusIdentity,
} from './sessionRunnerRuntimeStatusRetention';

function buildIdentity(
    overrides: Partial<SessionRunnerRuntimeStatusIdentity> = {},
): SessionRunnerRuntimeStatusIdentity {
    return {
        serverId: 'server-1',
        machineId: 'machine-1',
        sessionId: 'session-1',
        ...overrides,
    };
}

function buildRuntimeState(
    identity: SessionRunnerRuntimeStatusIdentity,
): SessionRunnerRuntimeStateV1 {
    return {
        v: 1,
        sessionId: identity.sessionId,
        machineId: identity.machineId,
        observedAtMs: 1,
        runner: {
            pid: 123,
            runtimeId: 'version:cli-old',
            processCommandHash: 'hash-old',
            entrypointVersion: 'cli-old',
            entrypointSource: 'process_command',
            startedBy: 'daemon',
            startingMode: 'remote',
        },
        daemon: {
            currentEntrypointVersion: 'version:cli-new',
            currentEntrypointSource: 'launch_spec',
        },
        versionState: 'stale',
        statusSource: 'daemon_tracking',
        plannedRestart: {
            supported: true,
            eligible: true,
        },
    };
}

function buildFetchedRuntimeStatus(identity: SessionRunnerRuntimeStatusIdentity) {
    return {
        state: buildRuntimeState(identity),
        runnerProcessIdentity: {
            pid: 123,
            processStartTimeMs: 1_000,
        },
    } as const;
}

describe('sessionRunnerRuntimeStatusRetention', () => {
    it('scopes retained V1 snapshots to the exact server, machine, and session identity', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const identity = buildIdentity();
        retention.completeRefresh(retention.beginRefresh(identity), buildFetchedRuntimeStatus(identity));
        const retained = retention.read(identity);

        expect(retention.read(identity)).toBe(retained);
        expect(retention.read(buildIdentity({ serverId: 'server-2' }))).toBeNull();
        expect(retention.read(buildIdentity({ machineId: 'machine-2' }))).toBeNull();
        expect(retention.read(buildIdentity({ sessionId: 'session-2' }))).toBeNull();

        const mismatchedIdentity = buildIdentity({ sessionId: 'session-2' });
        retention.completeRefresh(
            retention.beginRefresh(identity),
            buildFetchedRuntimeStatus(mismatchedIdentity),
        );
        expect(retention.read(identity)?.state).toBe(retained?.state);
        expect(retention.read(identity)?.runnerProcessIdentity).toBeNull();
        expect(retention.read(mismatchedIdentity)).toBeNull();
    });

    it('retains last-known V1 presentation but deauthorizes a V2 runner witness while refresh is pending or unavailable', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const identity = buildIdentity();
        retention.completeRefresh(retention.beginRefresh(identity), buildFetchedRuntimeStatus(identity));
        const retained = retention.read(identity);
        expect(retained?.runnerProcessIdentity).toEqual({
            pid: 123,
            processStartTimeMs: 1_000,
        });

        const refresh = retention.beginRefresh(identity);
        expect(retention.read(identity)?.state).toBe(retained?.state);
        expect(retention.read(identity)?.runnerProcessIdentity).toBeNull();
        retention.completeRefresh(refresh, null);
        expect(retention.read(identity)?.state).toBe(retained?.state);
        expect(retention.read(identity)?.runnerProcessIdentity).toBeNull();

        const recoveredRefresh = retention.beginRefresh(identity);
        retention.completeRefresh(
            recoveredRefresh,
            buildFetchedRuntimeStatus(identity),
        );
        expect(retention.read(identity)?.runnerProcessIdentity).toEqual({
            pid: 123,
            processStartTimeMs: 1_000,
        });
    });

    it('rejects an older same-identity refresh after a newer valid refresh completes', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const identity = buildIdentity();
        const olderRefresh = retention.beginRefresh(identity);
        const newerRefresh = retention.beginRefresh(identity);
        const olderState = buildRuntimeState(identity);
        const newerState = {
            ...olderState,
            versionState: 'current',
            plannedRestart: { supported: true, eligible: false },
        } satisfies SessionRunnerRuntimeStateV1;

        retention.completeRefresh(newerRefresh, { state: newerState, runnerProcessIdentity: null });
        const newerSnapshot = retention.read(identity);
        retention.completeRefresh(olderRefresh, { state: olderState, runnerProcessIdentity: null });

        expect(retention.read(identity)).toBe(newerSnapshot);
        expect(retention.read(identity)?.state).toBe(newerState);
    });

    it('evicts the oldest retained identity after 32 snapshots', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const oldestIdentity = buildIdentity({ sessionId: 'session-0' });
        retention.completeRefresh(
            retention.beginRefresh(oldestIdentity),
            buildFetchedRuntimeStatus(oldestIdentity),
        );

        for (let index = 1; index <= 32; index += 1) {
            const identity = buildIdentity({ sessionId: `session-${index}` });
            retention.completeRefresh(retention.beginRefresh(identity), buildFetchedRuntimeStatus(identity));
        }

        expect(retention.read(oldestIdentity)).toBeNull();
        expect(retention.read(buildIdentity({ sessionId: 'session-1' }))).not.toBeNull();
        expect(retention.read(buildIdentity({ sessionId: 'session-32' }))).not.toBeNull();
    });

    it('bounds pending-only identities and rejects completion after ticket eviction', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const oldestIdentity = buildIdentity({ sessionId: 'session-0' });
        const oldestRefresh = retention.beginRefresh(oldestIdentity);

        for (let index = 1; index <= 32; index += 1) {
            retention.beginRefresh(buildIdentity({ sessionId: `session-${index}` }));
        }

        retention.completeRefresh(oldestRefresh, buildFetchedRuntimeStatus(oldestIdentity));
        expect(retention.read(oldestIdentity)).toBeNull();
    });
});
