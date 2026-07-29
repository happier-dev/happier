import { describe, expect, it, vi } from 'vitest';

import {
    createLocalServiceLauncherHistoryStore,
    createLocalServiceLauncherLeafRoutes,
} from './leaves';
import type { BrowserViewTargetV1, LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';

const MACHINE_ID = 'machine-a';

const EXTERNAL_URL_TARGET: BrowserViewTargetV1 = {
    kind: 'externalUrl',
    targetId: 'inventory:entry-vite',
    url: 'http://127.0.0.1:5173/',
};

function snapshotWith(targets: LocalServiceLauncherSnapshotV1['targets']): LocalServiceLauncherSnapshotV1 {
    return {
        v: 1,
        machineId: MACHINE_ID,
        updatedAt: 1_000,
        targets,
    };
}

type LaunchTarget = LocalServiceLauncherSnapshotV1['targets'][number];

function inventoryTarget(overrides: Partial<LaunchTarget> = {}): LaunchTarget {
    return {
        id: 'inventory:entry-vite',
        source: 'inventory_entry',
        machineId: MACHINE_ID,
        title: 'Vite',
        confidence: 'high',
        state: 'available',
        actions: ['open'],
        browserTarget: EXTERNAL_URL_TARGET,
        ...overrides,
    };
}

function previewRow() {
    return {
        previewId: 'lsv-preview:inventory:entry-vite',
        resource: {
            previewId: 'lsv-preview:inventory:entry-vite',
            sessionId: 'session-1',
            machineId: MACHINE_ID,
            owner: { kind: 'session' as const, id: 'session-1' },
            target: { scheme: 'http' as const, host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' },
            display: { title: 'Vite', addressLabel: 'localhost:5173' },
            originMode: 'host' as const,
            browserTarget: {
                kind: 'localServicePreview' as const,
                targetId: 'lsv-preview:inventory:entry-vite',
                sessionId: 'session-1',
                machineId: MACHINE_ID,
            },
        },
        accessUrl: 'http://127.0.0.1:5173/',
        expiresAt: null,
        diagnostics: [],
    };
}

describe('createLocalServiceLauncherHistoryStore', () => {
    it('records, lists, and clears history entries with a cleared count', () => {
        const history = createLocalServiceLauncherHistoryStore();
        history.record('a');
        history.record('b');
        expect(history.list()).toEqual(['a', 'b']);

        expect(history.clear()).toBe(2);
        expect(history.list()).toEqual([]);
        expect(history.isDismissed('a')).toBe(true);
    });
});

describe('createLocalServiceLauncherLeafRoutes', () => {
    it('openPreview returns the target browser view and records it in history', async () => {
        const history = createLocalServiceLauncherHistoryStore();
        const routes = createLocalServiceLauncherLeafRoutes({
            machineId: MACHINE_ID,
            feed: { getSnapshot: vi.fn(async () => snapshotWith([inventoryTarget()])) },
            previewRoutes: { openOrCreate: vi.fn() },
            history,
        });

        const result = await routes.openPreview({ machineId: MACHINE_ID, targetId: 'inventory:entry-vite' });

        expect(result.status).toBe('opened');
        expect(result.browserTarget).toEqual(EXTERNAL_URL_TARGET);
        expect(history.list()).toEqual(['inventory:entry-vite']);
    });

    it('openPreview reports unavailable for an unknown target', async () => {
        const routes = createLocalServiceLauncherLeafRoutes({
            machineId: MACHINE_ID,
            feed: { getSnapshot: vi.fn(async () => snapshotWith([])) },
            previewRoutes: { openOrCreate: vi.fn() },
            history: createLocalServiceLauncherHistoryStore(),
        });

        const result = await routes.openPreview({ machineId: MACHINE_ID, targetId: 'missing' });

        expect(result).toEqual({
            protocolVersion: 1,
            status: 'unavailable',
            targetId: 'missing',
            reasonCode: 'launcher_target_unknown',
        });
    });

    it('registerPreview delegates an inventory target to the private-preview owner', async () => {
        const openOrCreate = vi.fn(async () => ({
            ok: true as const,
            response: { protocolVersion: 1 as const, status: 'created' as const, preview: previewRow(), snapshot: {
                v: 1 as const, machineId: MACHINE_ID, generatedAt: 1_000, refreshState: 'idle' as const,
                resources: [], previews: [], diagnostics: [],
            } },
        }));
        const routes = createLocalServiceLauncherLeafRoutes({
            machineId: MACHINE_ID,
            feed: { getSnapshot: vi.fn(async () => snapshotWith([inventoryTarget()])) },
            previewRoutes: { openOrCreate },
            history: createLocalServiceLauncherHistoryStore(),
        });

        const result = await routes.registerPreview({
            machineId: MACHINE_ID,
            targetId: 'inventory:entry-vite',
            sessionId: 'session-1',
        });

        expect(openOrCreate).toHaveBeenCalledWith({
            machineId: MACHINE_ID,
            sessionId: 'session-1',
            inventoryEntryId: 'entry-vite',
        });
        expect(result.status).toBe('registered');
        expect(result.previewId).toBe('lsv-preview:inventory:entry-vite');
    });

    it('clearHistory empties the store and returns the cleared count', async () => {
        const history = createLocalServiceLauncherHistoryStore();
        history.record('inventory:entry-vite');
        const routes = createLocalServiceLauncherLeafRoutes({
            machineId: MACHINE_ID,
            feed: { getSnapshot: vi.fn(async () => snapshotWith([])) },
            previewRoutes: { openOrCreate: vi.fn() },
            history,
        });

        const result = await routes.clearHistory({ machineId: MACHINE_ID });

        expect(result.cleared).toBe(1);
        expect(result.snapshot.machineId).toBe(MACHINE_ID);
        expect(history.list()).toEqual([]);
    });
});
