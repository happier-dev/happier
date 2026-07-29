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
            requestedAt: 1_100,
        });
        const reloaded = applyLocalServiceLauncherSnapshot(refreshing, {
            ...snapshot,
            updatedAt: 1_200,
        });

        expect(refreshing.refreshStatus).toBe('refreshing');
        expect(selectLocalServiceLaunchTargets(refreshing)).toEqual(snapshot.targets);
        expect(selectLocalServiceLaunchTargets(reloaded)[0]).toBe(firstTarget);
    });
});
