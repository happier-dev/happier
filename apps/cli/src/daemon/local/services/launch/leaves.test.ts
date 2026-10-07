import { describe, expect, it, vi } from 'vitest';

import {
    createLocalServiceLauncherHistoryStore,
    createLocalServiceLauncherLeafRoutes,
} from './leaves';
import type { BrowserViewTargetV1, LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import { createLocalServicePreviewRegistry } from '../preview/registry';
import { createLocalServicePreviewRoutes } from '../preview/routes';
import { createLocalServiceLauncherFeed } from './feed';

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

    it('registerPreview binds the canonical feed listener and Session through private registration', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1, machineId: MACHINE_ID, generatedAt: 1_000, refreshState: 'idle', diagnostics: [],
            entries: [{
                id: 'entry-vite:authority', machineId: MACHINE_ID,
                address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
                endpoint: { scheme: 'http', host: '127.0.0.1', port: 5173, probeState: 'ready', probedAt: 1_000 },
                port: 5173, protocol: 'tcp', detectedAt: 1_000, lastSeenAt: 1_000,
                state: 'listening', source: 'detected', labels: [], diagnostics: [],
                confidence: 'high', processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high',
            }],
        });
        const previewRegistry = createLocalServicePreviewRegistry();
        const previewRoutes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID, accountId: 'account-1', inventoryRegistry, registry: previewRegistry,
            server: {
                token: 'daemon-token', serverBaseUrl: 'https://home.example.test',
                // Only the server HTTP boundary is substituted; feed, binding and registration are real.
                http: {
                    async post(_url, body) {
                        const resource = LocalServicePreviewResourceV1Schema.parse(body);
                        return { data: { resource, accessUrl: 'https://private.example.test/?previewToken=admission', expiresAt: 61_000 } };
                    },
                    async delete() { return { data: { ok: true } }; },
                },
            },
        });
        const feed = createLocalServiceLauncherFeed({ machineId: MACHINE_ID, inventoryRegistry, previewRegistry });
        const target = (await feed.getSnapshot()).targets.find(candidate => candidate.sourceClass?.kind === 'inventory_entry');
        if (!target) throw new Error('Expected canonical inventory launch target');
        const routes = createLocalServiceLauncherLeafRoutes({
            machineId: MACHINE_ID,
            feed,
            previewRoutes,
            history: createLocalServiceLauncherHistoryStore(),
        });

        const result = await routes.registerPreview({
            machineId: MACHINE_ID,
            targetId: target.id,
            sessionId: 'session-1',
        });

        const snapshot = await previewRoutes.getSnapshot();
        expect(snapshot.previews).toHaveLength(1);
        const preview = snapshot.previews?.[0];
        if (!preview) throw new Error('Expected private preview registration');
        expect(preview.resource).toMatchObject({
            machineId: MACHINE_ID, sessionId: 'session-1', owner: { kind: 'session', id: 'session-1' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        });
        expect(preview.accessUrl).toBe('https://private.example.test/?previewToken=admission');
        expect(result).toMatchObject({ status: 'registered', targetId: target.id, previewId: preview.previewId });
        expect(result.browserTarget).toEqual(preview.resource.browserTarget);
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
