import type { LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

const snapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [{
        id: 'launcher_preview',
        source: 'registered_preview',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Vite app',
        subtitle: 'localhost:5173',
        confidence: 'high',
        state: 'available',
        actions: ['open_preview'],
        browserTarget: {
            kind: 'localServicePreview',
            targetId: 'preview_vite',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: {
                title: 'Vite app',
                addressLabel: 'localhost:5173',
            },
        },
    }],
} satisfies LocalServiceLauncherSnapshotV1;

describe('local service launcher UI store', () => {
    it('keeps identical collections and selected targets stable across feed freshness changes', async () => {
        const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState, selectLocalServiceLaunchTargets } = await import('./store');
        const loaded = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), snapshot);
        const targets = selectLocalServiceLaunchTargets(loaded);
        const repeated = applyLocalServiceLauncherSnapshot(loaded, structuredClone(snapshot));
        expect(repeated).toBe(loaded);
        const tick = applyLocalServiceLauncherSnapshot(loaded, { ...snapshot, updatedAt: 2_000 });
        expect(tick.updatedAt).toBe(2_000);
        expect(tick.targetIds).toBe(loaded.targetIds);
        expect(tick.targetsById).toBe(loaded.targetsById);
        expect(selectLocalServiceLaunchTargets(tick)).toBe(targets);
    });
    it('normalizes launcher snapshots and keeps last-known targets during refresh', async () => {
        const {
            applyLocalServiceLauncherRefreshStarted,
            applyLocalServiceLauncherSnapshot,
            createLocalServiceLauncherState,
            selectLocalServiceLaunchTargets,
        } = await import('./store');

        const loaded = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), snapshot);
        const firstTarget = selectLocalServiceLaunchTargets(loaded)[0];
        const refreshing = applyLocalServiceLauncherRefreshStarted(loaded, {
            machineId: 'machine_1',
            sessionId: 'session_1',
        });
        const reloaded = applyLocalServiceLauncherSnapshot(refreshing, {
            ...snapshot,
            updatedAt: 1_200,
        });

        expect(refreshing.refreshStatus).toBe('refreshing');
        expect(selectLocalServiceLaunchTargets(refreshing)).toEqual(snapshot.targets);
        expect(selectLocalServiceLaunchTargets(reloaded)[0]).toBe(firstTarget);
    });

    it('does not fabricate a feed update time on the refresh or failure transitions', async () => {
        const {
            failLocalServiceLauncherRefresh,
            applyLocalServiceLauncherRefreshStarted,
            applyLocalServiceLauncherSnapshot,
            createLocalServiceLauncherState,
            snapshotFromLocalServiceLauncherState,
        } = await import('./store');

        // `updatedAt` is the daemon's launcher-feed update time — `applyLocalServiceLauncherSnapshot`
        // takes it straight from the wire. Neither starting nor failing a refresh produces one, and
        // stamping the client clock is not harmless here: `snapshotFromLocalServiceLauncherState`
        // reconstructs a wire-shaped snapshot out of this field for a live consumer, so a fabricated
        // value leaves the store claiming a daemon feed time that never existed.
        const loaded = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), snapshot);
        expect(loaded.updatedAt).toBe(1_000);

        const refreshing = applyLocalServiceLauncherRefreshStarted(loaded, {
            machineId: 'machine_1',
            sessionId: 'session_1',
        });
        expect(refreshing.updatedAt).toBe(1_000);

        const failed = failLocalServiceLauncherRefresh(refreshing, {
            machineId: 'machine_1',
            sessionId: 'session_1',
            reasonCode: 'request_failed',
        });
        expect(failed.refreshStatus).toBe('error');
        expect(failed.updatedAt).toBe(1_000);

        // A different machine has no loaded feed, so it reports none — and the snapshot
        // reconstruction correctly refuses to invent one.
        const switched = applyLocalServiceLauncherRefreshStarted(loaded, {
            machineId: 'machine_2',
        });
        expect(switched.updatedAt).toBeNull();
        expect(snapshotFromLocalServiceLauncherState(switched)).toBeNull();
    });
});
