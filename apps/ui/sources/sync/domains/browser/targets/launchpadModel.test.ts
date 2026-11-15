import type { BrowserViewTargetV1} from '@happier-dev/protocol/browser/target/v1';
import type { LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { describe, expect, it } from 'vitest';

const previewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_vite',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: { title: 'Vite app', addressLabel: 'localhost:5173' },
} satisfies BrowserViewTargetV1;

const launcherSnapshot = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 1_000,
    targets: [{
        id: 'preview:preview_vite',
        source: 'inventory_entry',
        sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'entry_vite' },
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Vite app',
        subtitle: 'localhost:5173',
        confidence: 'high',
        state: 'available',
        actions: ['register_preview'],
        browserTarget: previewTarget,
    }, {
        id: 'inventory:old',
        source: 'inventory_entry',
        machineId: 'machine_1',
        sessionId: 'session_1',
        title: 'Old service',
        subtitle: 'localhost:4000',
        confidence: 'medium',
        state: 'stale',
        unavailableReason: 'stale_service',
        actions: ['open_preview'],
        browserTarget: { ...previewTarget, targetId: 'preview_stale' },
    }],
} satisfies LocalServiceLauncherSnapshotV1;

describe('buildBrowserLaunchpadModel', () => {
    /**
     * Lab W: the phone launchpad's Running previews ARE the Local services rows. One row model owns a
     * running service (`buildLocalServiceRows`); the launchpad no longer derives its own local-service
     * rows, sections or unavailable reasons from the same launcher snapshot.
     */
    it('lists running local services as Services rows and keeps them out of its own rows', async () => {
        const { buildBrowserLaunchpadModel } = await import('./launchpadModel');

        const model = buildBrowserLaunchpadModel({ launcherSnapshot, nowMs: 2_000 });

        const running = model.rows.filter((row) => row.section === 'running');
        expect(running.map((row) => row.serviceRow?.title)).toEqual(['Vite app']);
        expect(running[0]?.serviceRow?.status).toBe('running');
        expect(running[0]?.serviceRow?.primaryAction?.kind).toBe('open');
        // A stale service is not a preview anyone can open here: no dead row for it either.
        expect(model.rows.some((row) => row.title === 'Old service')).toBe(false);
    });

    /** Before the first Services read lands there is no inventory: the launchpad loads, it never says nothing is running. */
    it('reports the first Services read as loading, then as a failure, but not later refreshes over known rows', async () => {
        const { buildBrowserLaunchpadModel } = await import('./launchpadModel');

        expect(buildBrowserLaunchpadModel({ launcherSnapshot: null, launcherRefresh: { status: 'refreshing', error: null } }).refreshStatus)
            .toBe('refreshing');
        const failed = buildBrowserLaunchpadModel({ launcherSnapshot: null, launcherRefresh: { status: 'error', error: 'request_failed' } });
        expect([failed.refreshStatus, failed.refreshError]).toEqual(['error', 'request_failed']);
        expect(buildBrowserLaunchpadModel({ launcherSnapshot, launcherRefresh: { status: 'refreshing', error: null }, nowMs: 2_000 }).refreshStatus)
            .toBe('idle');
    });
});
