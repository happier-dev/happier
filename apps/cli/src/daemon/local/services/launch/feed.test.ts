import { describe, expect, it } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol';

import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import { createManagedLocalServiceRegistry } from '../managed/registry';
import { createLocalServicePreviewRegistry, registerLocalServicePreview } from '../preview/registry';
import { createLocalServiceLauncherFeed } from './feed';

function inventoryEntry(
    overrides: Partial<NormalizedLocalServiceInventoryEntry> = {},
): NormalizedLocalServiceInventoryEntry {
    const port = overrides.port ?? 5173;
    return {
        id: 'inventory-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        endpoint: {
            scheme: 'http',
            host: '127.0.0.1',
            port,
            probeState: 'ready',
            probedAt: 2_000,
        },
        port,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source: 'detected',
        presentation: {
            pageTitle: 'Local Vite App',
            pageTitleSource: 'html_title',
            displayName: 'Vite',
            folderLabel: 'web',
            addressLabel: 'localhost:5173',
        },
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'medium',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        provenance: {
            process: {
                pid: 400,
                ppid: 300,
                lineagePids: [400, 300],
                command: 'npm run dev',
                cwd: '/repo/web',
                redacted: true,
            },
        },
        classification: {
            kind: 'vite',
            displayName: 'Vite',
            confidence: 'high',
            lowSignal: false,
            signals: ['vite'],
        },
        ...overrides,
    };
}

describe('createLocalServiceLauncherFeed', () => {
    it('projects daemon registries into a fail-closed launcher snapshot', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [
                inventoryEntry(),
                inventoryEntry({
                    id: 'inventory-without-preview',
                    port: 3000,
                    presentation: { addressLabel: 'localhost:3000', displayName: 'Next app' },
                }),
            ],
            diagnostics: [],
        });
        registerLocalServicePreview(previewRegistry, {
            previewId: 'preview-a',
            sessionId: 'session-a',
            machineId: 'machine-a',
            owner: { kind: 'session', id: 'session-a' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' },
            display: {
                title: 'Local Vite App',
                addressLabel: 'localhost:5173',
                folderLabel: 'web',
                iconToken: 'vite',
            },
            originMode: 'path',
        });
        managedRegistry.startDetectAfterLaunch({
            id: 'managed-a',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            routeName: 'Managed worker',
            minimumConfidence: 'medium',
            process: { pid: 700, startedAt: 1_000 },
        });
        managedRegistry.applyInventoryEntry({
            id: 'managed-entry-a',
            port: 4173,
            confidence: 'high',
            processOwnershipConfidence: 'high',
            provenance: {
                process: {
                    pid: 701,
                    ppid: 700,
                    lineagePids: [701, 700],
                    command: 'vite --host 127.0.0.1',
                    redacted: true,
                },
            },
        });

        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            sessionId: 'session-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
            runTargets: [{
                id: 'web:dev',
                cwd: '/repo/web',
                packageName: 'web',
                packageManager: 'npm',
                scriptName: 'dev',
                command: 'vite --host 127.0.0.1',
                launchIntent: {
                    kind: 'packageScript',
                    packageManager: 'npm',
                    cwd: '/repo/web',
                    scriptName: 'dev',
                },
            }],
        });

        const snapshot = await feed.getSnapshot();

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(snapshot.targets.map((target) => ({
            id: target.id,
            source: target.source,
            state: target.state,
            unavailableReason: target.unavailableReason ?? null,
            actions: target.actions,
            browserTargetKind: target.browserTarget?.kind ?? null,
        }))).toEqual([
            {
                id: 'preview:preview-a',
                source: 'registered_preview',
                state: 'available',
                unavailableReason: null,
                actions: [],
                browserTargetKind: 'localServicePreview',
            },
            {
                id: 'inventory:inventory-a',
                source: 'inventory_entry',
                state: 'available',
                unavailableReason: null,
                actions: [],
                browserTargetKind: 'localServicePreview',
            },
            {
                id: 'inventory:inventory-without-preview',
                source: 'inventory_entry',
                state: 'available',
                unavailableReason: null,
                actions: ['open'],
                browserTargetKind: 'externalUrl',
            },
            {
                id: 'package:web:dev',
                source: 'package_script',
                state: 'unavailable',
                unavailableReason: 'launch_unavailable',
                actions: [],
                browserTargetKind: null,
            },
            {
                id: 'managed:managed-a',
                source: 'managed_service',
                state: 'unavailable',
                unavailableReason: 'managed_preview_unavailable',
                actions: [],
                browserTargetKind: null,
            },
        ]);
    });

    it('preserves the open action + externalUrl target for a listening loopback entry (fence carve-out)', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [inventoryEntry({ id: 'loopback-open', port: 5173, presentation: { addressLabel: 'localhost:5173' } })],
            diagnostics: [],
        });
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
        });

        const snapshot = await feed.getSnapshot();
        const target = snapshot.targets.find((t) => t.id === 'inventory:loopback-open');
        expect(target?.state).toBe('available');
        expect(target?.actions).toEqual(['open']);
        expect(target?.browserTarget?.kind).toBe('externalUrl');
    });

    it('ranks an openable loopback entry above a package_script suggestion', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [inventoryEntry({ id: 'loopback-open', port: 5173, presentation: { addressLabel: 'localhost:5173' } })],
            diagnostics: [],
        });
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
            runTargets: [{
                id: 'web:dev',
                cwd: '/repo/web',
                packageName: 'web',
                packageManager: 'npm',
                scriptName: 'dev',
                command: 'vite',
                launchIntent: { kind: 'packageScript', packageManager: 'npm', cwd: '/repo/web', scriptName: 'dev' },
            }],
        });

        const snapshot = await feed.getSnapshot();
        const ids = snapshot.targets.map((t) => t.id);
        expect(ids.indexOf('inventory:loopback-open')).toBeLessThan(ids.indexOf('package:web:dev'));
    });

    it('honors an explicit machine scope by returning entries from all workspaces even with a sessionId', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [
                inventoryEntry({ id: 'entry-web', port: 5173, presentation: { addressLabel: 'localhost:5173' }, provenance: { workspace: { path: '/repo/web', association: 'process_tree' } } }),
                inventoryEntry({ id: 'entry-foreign', port: 9999, presentation: { addressLabel: 'localhost:9999' }, provenance: { workspace: { path: '/other/app', association: 'cwd_containment' } } }),
            ],
            diagnostics: [],
        });
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
            resolveSessionWorkspacePaths: () => ['/repo/web'],
        });

        const scoped = await feed.getSnapshot({ sessionId: 'session-b', scope: 'machine' });
        const ids = scoped.targets.filter((t) => t.source === 'inventory_entry').map((t) => t.id);
        expect(ids).toContain('inventory:entry-web');
        expect(ids).toContain('inventory:entry-foreign');
    });

    it('scopes to an explicit session-less workspaceRoot', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [
                inventoryEntry({ id: 'entry-web', port: 5173, presentation: { addressLabel: 'localhost:5173' }, provenance: { workspace: { path: '/repo/web', association: 'process_tree' } } }),
                inventoryEntry({ id: 'entry-foreign', port: 9999, presentation: { addressLabel: 'localhost:9999' }, provenance: { workspace: { path: '/other/app', association: 'cwd_containment' } } }),
            ],
            diagnostics: [],
        });
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
        });

        const scoped = await feed.getSnapshot({ workspaceRoot: '/repo/web' });
        const ids = scoped.targets.filter((t) => t.source === 'inventory_entry').map((t) => t.id);
        expect(ids).toContain('inventory:entry-web');
        expect(ids).not.toContain('inventory:entry-foreign');
    });

    it('expands a ~-prefixed workspaceRoot at the daemon boundary before scoping', async () => {
        const previousHome = process.env.HOME;
        process.env.HOME = '/repo';
        try {
            const inventoryRegistry = createLocalServiceInventoryRegistry();
            const managedRegistry = createManagedLocalServiceRegistry();
            const previewRegistry = createLocalServicePreviewRegistry();
            inventoryRegistry.replaceSnapshot({
                v: 1,
                machineId: 'machine-a',
                generatedAt: 2_000,
                refreshState: 'idle',
                entries: [
                    inventoryEntry({ id: 'entry-web', port: 5173, presentation: { addressLabel: 'localhost:5173' }, provenance: { workspace: { path: '/repo/web', association: 'process_tree' } } }),
                    inventoryEntry({ id: 'entry-foreign', port: 9999, presentation: { addressLabel: 'localhost:9999' }, provenance: { workspace: { path: '/other/app', association: 'cwd_containment' } } }),
                ],
                diagnostics: [],
            });
            const feed = createLocalServiceLauncherFeed({
                machineId: 'machine-a',
                inventoryRegistry,
                managedRegistry,
                previewRegistry,
                now: () => 3_000,
            });

            const scoped = await feed.getSnapshot({ workspaceRoot: '~/web' });
            const ids = scoped.targets.filter((t) => t.source === 'inventory_entry').map((t) => t.id);
            expect(ids).toContain('inventory:entry-web');
            expect(ids).not.toContain('inventory:entry-foreign');
        } finally {
            if (previousHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = previousHome;
            }
        }
    });

    it('scopes a requested snapshot to the session workspace PATH (not the session) and projects attribution', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [
                // (a) same-workspace service started by session-a
                inventoryEntry({
                    id: 'entry-session-a',
                    port: 5173,
                    presentation: { addressLabel: 'localhost:5173', displayName: 'Vite A' },
                    provenance: {
                        process: { pid: 400, lineagePids: [400], command: 'vite', cwd: '/repo/web', redacted: true },
                        session: { id: 'session-a' },
                        workspace: { path: '/repo/web', association: 'process_tree' },
                    },
                }),
                // (b) same-workspace service started by session-b
                inventoryEntry({
                    id: 'entry-session-b',
                    port: 5174,
                    presentation: { addressLabel: 'localhost:5174', displayName: 'Vite B' },
                    provenance: {
                        process: { pid: 410, lineagePids: [410], command: 'vite', cwd: '/repo/web', redacted: true },
                        session: { id: 'session-b' },
                        workspace: { path: '/repo/web', association: 'process_tree' },
                    },
                }),
                // (c) foreign-workspace listener
                inventoryEntry({
                    id: 'entry-foreign',
                    port: 9999,
                    presentation: { addressLabel: 'localhost:9999', displayName: 'Other' },
                    provenance: {
                        process: { pid: 500, lineagePids: [500], command: 'node', cwd: '/other/app', redacted: true },
                        workspace: { path: '/other/app', association: 'cwd_containment' },
                    },
                }),
            ],
            diagnostics: [],
        });

        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
            resolveSessionWorkspacePaths: (sessionId) =>
                sessionId === 'session-b' ? ['/repo/web'] : [],
        });

        const snapshot = await feed.getSnapshot({ sessionId: 'session-b' });

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        const inventoryTargets = snapshot.targets.filter((target) => target.source === 'inventory_entry');
        const byId = new Map(inventoryTargets.map((target) => [target.id, target]));
        // Scope is workspace PATH: BOTH same-workspace entries are present, even though
        // entry-session-a belongs to a different session.
        expect(byId.has('inventory:entry-session-a')).toBe(true);
        expect(byId.has('inventory:entry-session-b')).toBe(true);
        // Foreign workspace excluded.
        expect(byId.has('inventory:entry-foreign')).toBe(false);
        // Attribution projected onto each target's sessionId.
        expect(byId.get('inventory:entry-session-a')?.sessionId).toBe('session-a');
        expect(byId.get('inventory:entry-session-b')?.sessionId).toBe('session-b');
    });

    it('scopes run-targets to the session workspace and surfaces a package_script target', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();

        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
            resolveSessionWorkspacePaths: () => ['/repo/web'],
            runTargets: [
                {
                    id: 'web:dev',
                    cwd: '/repo/web',
                    packageName: 'web',
                    packageManager: 'npm',
                    scriptName: 'dev',
                    command: 'vite',
                    launchIntent: { kind: 'packageScript', packageManager: 'npm', cwd: '/repo/web', scriptName: 'dev' },
                },
                {
                    id: 'api:dev',
                    cwd: '/other/api',
                    packageName: 'api',
                    packageManager: 'npm',
                    scriptName: 'dev',
                    command: 'uvicorn',
                    launchIntent: { kind: 'packageScript', packageManager: 'npm', cwd: '/other/api', scriptName: 'dev' },
                },
            ],
        });

        const snapshot = await feed.getSnapshot({ sessionId: 'session-b' });

        const scriptIds = snapshot.targets.filter((t) => t.source === 'package_script').map((t) => t.id);
        expect(scriptIds).toContain('package:web:dev');
        expect(scriptIds).not.toContain('package:api:dev');
    });

    it('returns all entries unscoped when no sessionId is supplied', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [
                inventoryEntry({ id: 'entry-web', port: 5173, presentation: { addressLabel: 'localhost:5173' }, provenance: { workspace: { path: '/repo/web', association: 'process_tree' } } }),
                inventoryEntry({ id: 'entry-foreign', port: 9999, presentation: { addressLabel: 'localhost:9999' }, provenance: { workspace: { path: '/other/app', association: 'cwd_containment' } } }),
            ],
            diagnostics: [],
        });

        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
            resolveSessionWorkspacePaths: () => ['/repo/web'],
        });

        const snapshot = await feed.getSnapshot();

        const inventoryIds = snapshot.targets.filter((t) => t.source === 'inventory_entry').map((t) => t.id);
        expect(inventoryIds).toContain('inventory:entry-web');
        expect(inventoryIds).toContain('inventory:entry-foreign');
    });

    it('does not block the launcher snapshot on unresolved run-target discovery', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [inventoryEntry({ id: 'loopback-open', port: 5173, presentation: { addressLabel: 'localhost:5173' } })],
            diagnostics: [],
        });
        let releaseRunTargets: (targets: readonly []) => void = () => {};
        const runTargets = new Promise<readonly []>((resolve) => {
            releaseRunTargets = resolve;
        });
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
            runTargetsTimeoutMs: 1,
            runTargets: () => runTargets,
        });

        let timeout: ReturnType<typeof setTimeout> | undefined;
        const snapshotPromise = feed.getSnapshot()
            .then((snapshot) => ({ kind: 'snapshot' as const, snapshot }));
        const result = await Promise.race([
            snapshotPromise,
            new Promise<{ kind: 'timeout' }>((resolve) => {
                timeout = setTimeout(() => resolve({ kind: 'timeout' }), 25);
            }),
        ]);
        if (timeout) clearTimeout(timeout);
        releaseRunTargets([]);
        await snapshotPromise.catch(() => undefined);

        expect(result.kind).toBe('snapshot');
        if (result.kind !== 'snapshot') return;
        expect(LocalServiceLauncherSnapshotV1Schema.parse(result.snapshot)).toEqual(result.snapshot);
        expect(result.snapshot.targets.map((target) => target.id)).toEqual(['inventory:loopback-open']);
    });

    it('does not fail the launcher snapshot when run-target discovery rejects', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        const errors: unknown[] = [];
        inventoryRegistry.replaceSnapshot({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [inventoryEntry({ id: 'loopback-open', port: 5173, presentation: { addressLabel: 'localhost:5173' } })],
            diagnostics: [],
        });
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            previewRegistry,
            now: () => 3_000,
            onRunTargetsError: (error) => errors.push(error),
            runTargets: async () => {
                throw new Error('package discovery failed');
            },
        });

        const snapshot = await feed.getSnapshot();

        expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(snapshot.targets.map((target) => target.id)).toEqual(['inventory:loopback-open']);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
    });
});
