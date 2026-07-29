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

describe('sessionRunnerRuntimeStatusRetention', () => {
    it('scopes retained snapshots to the exact server, machine, and session identity', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const identity = buildIdentity();
        retention.completeRefresh(
            retention.beginRefresh(identity),
            buildRuntimeState(identity),
        );
        const retained = retention.read(identity);

        expect(retention.read(identity)).toBe(retained);
        expect(retention.read(buildIdentity({ serverId: 'server-2' }))).toBeNull();
        expect(retention.read(buildIdentity({ machineId: 'machine-2' }))).toBeNull();
        expect(retention.read(buildIdentity({ sessionId: 'session-2' }))).toBeNull();

        const mismatchedIdentity = buildIdentity({ sessionId: 'session-2' });
        retention.completeRefresh(
            retention.beginRefresh(identity),
            buildRuntimeState(mismatchedIdentity),
        );
        expect(retention.read(identity)).toBe(retained);
        expect(retention.read(mismatchedIdentity)).toBeNull();
    });

    it('keeps the last validated snapshot when refresh is unavailable', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const identity = buildIdentity();
        retention.completeRefresh(
            retention.beginRefresh(identity),
            buildRuntimeState(identity),
        );
        const retained = retention.read(identity);

        expect(retention.read(identity)).toBe(retained);

        retention.completeRefresh(
            retention.beginRefresh(identity),
            null,
        );
        expect(retention.read(identity)).toBe(retained);

        const neverValidatedIdentity = buildIdentity({ sessionId: 'session-2' });
        retention.completeRefresh(
            retention.beginRefresh(neverValidatedIdentity),
            null,
        );
        expect(retention.read(neverValidatedIdentity)).toBeNull();
    });

    it('rejects an older same-identity refresh after a newer valid refresh completes', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const identity = buildIdentity();
        const olderRefresh = retention.beginRefresh(identity);
        const newerRefresh = retention.beginRefresh(identity);
        const olderState = buildRuntimeState(identity);
        const newerState = {
            ...buildRuntimeState(identity),
            versionState: 'current',
            plannedRestart: {
                supported: true,
                eligible: false,
            },
        } satisfies SessionRunnerRuntimeStateV1;

        retention.completeRefresh(newerRefresh, newerState);
        const newerSnapshot = retention.read(identity);
        retention.completeRefresh(olderRefresh, olderState);

        expect(newerState.observedAtMs).toBe(olderState.observedAtMs);
        expect(retention.read(identity)).toBe(newerSnapshot);
        expect(retention.read(identity)?.state).toBe(newerState);
    });

    it('evicts the oldest retained identity after 32 snapshots', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const oldestIdentity = buildIdentity({ sessionId: 'session-0' });
        retention.completeRefresh(
            retention.beginRefresh(oldestIdentity),
            buildRuntimeState(oldestIdentity),
        );

        for (let index = 1; index <= 32; index += 1) {
            const identity = buildIdentity({ sessionId: `session-${index}` });
            retention.completeRefresh(
                retention.beginRefresh(identity),
                buildRuntimeState(identity),
            );
        }

        expect(retention.read(oldestIdentity)).toBeNull();
        expect(retention.read(buildIdentity({ sessionId: 'session-1' }))).not.toBeNull();
        expect(retention.read(buildIdentity({ sessionId: 'session-32' }))).not.toBeNull();
    });

    it('bounds pending-only identities and rejects a completion after its ticket is evicted', () => {
        const retention = createSessionRunnerRuntimeStatusRetention();
        const oldestIdentity = buildIdentity({ sessionId: 'session-0' });
        const oldestRefresh = retention.beginRefresh(oldestIdentity);

        for (let index = 1; index <= 32; index += 1) {
            retention.beginRefresh(buildIdentity({ sessionId: `session-${index}` }));
        }

        retention.completeRefresh(
            oldestRefresh,
            buildRuntimeState(oldestIdentity),
        );
        expect(retention.read(oldestIdentity)).toBeNull();
    });
});
