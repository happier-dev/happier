import { describe, expect, it, vi } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import { createLocalServicePreviewRegistry, previewIdForInventoryEntry, registerLocalServicePreview } from '../preview/registry';
import { createLocalServiceLauncherFeed } from './feed';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { buildLocalServiceRows } from '../../../../../../../apps/ui/sources/sync/domains/local/services/serviceRow';
import { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } from '../../../../../../../apps/ui/sources/sync/domains/browser/targets/suggestions';
import { createProjectServiceRelocation } from '@/workspaces/execution/projectServiceRelocation';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { join } from 'node:path';

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
        // `terminate_detected` now requires established ownership (`high`); `medium` means the
        // platform could not establish who owns the process and the gate fails closed.
        processOwnershipConfidence: 'high',
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
    it.each([
        ['Start', 'source'], ['Start', 'worker'], ['Move', 'source'], ['Move', 'worker'],
    ] as const)('keeps a complete binding read pending through %s settlement on %s', async (operation, destination) => {
        const createOwner = () => createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Literal Project launches never install plugin dependencies.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const owner = createOwner();
        const oldOwner = createOwner();
        const workspace: WorkspaceRefV1 = { id: `${destination}-ref`, serverId: 'home', machineId: destination,
            rootPath: process.cwd(), createdAtMs: 1 };
        const oldWorkspace = { ...workspace, id: `${destination}-old-ref`, machineId: destination === 'source' ? 'worker' : 'source' };
        let release!: () => void;
        const launchGate = new Promise<void>(resolve => { release = resolve; });
        let launchEntered = false;
        const supervise = async (custodian: typeof owner, target: typeof workspace, pending: boolean) => custodian.superviseProject({
            workspace: target, declaration: { workspaceRefId: target.id, selection: { kind: 'manifest', name: 'httpPort' } },
            cwd: target.rootPath, serviceId: 'project-service:httpPort', specIdentity: 'httpPort', execution: 'portable', isCurrent: () => true,
            requester: { serverId: 'home', accountId: 'owner', machineId: target.machineId, installationId: 'installation' },
            processSpec: { mode: { kind: 'managedSpawn', host: '127.0.0.1' } },
            // Hold the genuine process-launch boundary, with real native custody and feed logic beneath the read.
            authorizeLaunch: async input => {
                if (pending) { launchEntered = true; await launchGate; }
                return { command: process.execPath,
                    args: ['-e', `require('node:http').createServer((req,res)=>res.end('ok')).listen(${input.endpoint!.port},'127.0.0.1')`],
                    env: {}, release: async () => undefined };
            },
        });
        const targetFor = (handle: Awaited<ReturnType<typeof supervise>>) => ({
            kind: 'managed_service' as const, machineId: handle.workspace.machineId, workspaceId: handle.workspace.id,
            managedServiceId: handle.instanceId, declaration: handle.declaration, cwd: handle.cwd,
        });
        const feed = createLocalServiceLauncherFeed({ machineId: destination, projectManagedServices: owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry() });
        let completion: Promise<unknown> | undefined;
        try {
            if (operation === 'Start') completion = supervise(owner, workspace, true);
            else {
                const old = await supervise(oldOwner, oldWorkspace, false);
                const currentTarget = targetFor(old);
                const address = { serverId: 'home', refId: 'source-ref' };
                const choice = destination === 'source' ? { kind: 'primary' as const }
                    : { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: destination } };
                const request = { workspace: address, serviceName: 'httpPort', requestId: `move-${destination}`, currentTarget,
                    destination: choice, selectedTarget: { machineId: destination }, desiredPlacement: { workspace: address,
                        serviceName: 'httpPort', expectedRevision: 'absent' as const, expected: { kind: 'absent' as const },
                        value: { runsOn: choice, unavailable: 'fail' as const } } };
                completion = createProjectServiceRelocation({
                    readService: async () => ({ status: 'resolved', execution: 'portable', currentTarget,
                        workspace: oldWorkspace, instanceId: old.instanceId, snapshot: old.snapshot() }),
                    resolveDestination: async () => ({ status: 'resolved', workspace }),
                    // Account/config and Sync transport are the boundaries; relocation and both native owners stay real.
                    saveDesiredPlacement: async () => ({ status: 'applied', placement: request.desiredPlacement.value,
                        revision: 1, provenance: 'saved' }),
                    stopService: async () => old.stop(),
                    revalidateDestination: async () => ({ status: 'admitted' }),
                    reviewDestinationSetup: async () => ({ status: 'admitted' }),
                    handoffPrepareBetween: async () => ({ ok: true, traversed: [] }),
                    startService: async () => {
                        expect(old.snapshot().state).toBe('stopped');
                        return { status: 'succeeded', currentTarget: targetFor(await supervise(owner, workspace, true)) };
                    },
                })(request).then(result => { expect(result).toMatchObject({ ok: true, result: { status: 'moved' } }); });
            }
            void completion.catch(() => {});
            await vi.waitFor(() => expect(launchEntered).toBe(true));
            // An unrelated Workspace need not wait for this declaration's native publication.
            expect((await feed.getSnapshot({ projection: 'managed_bindings', workspaceRoot: join(workspace.rootPath, 'unrelated') })).targets).toEqual([]);
            const observations: unknown[] = [];
            const bindingRead = feed.getSnapshot({ projection: 'managed_bindings', workspaceRoot: workspace.rootPath });
            void bindingRead.then(value => observations.push(value), error => observations.push(error));
            await new Promise<void>(resolve => setImmediate(resolve));
            // Incomplete native custody is neither an unavailable Machine nor authoritative absence.
            expect(observations).toEqual([]);
            release();
            await completion;
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(await bindingRead);
            const handle = owner.listProjectServices()[0]!;
            expect(snapshot.targets).toEqual([expect.objectContaining({ machineId: destination,
                sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId }, serviceState: 'healthy' })]);
            expect(buildLocalServiceRows({ inventoryRows: [], launchTargets: snapshot.targets, sessionId: null, scope: 'workspace' }))
                .toEqual([expect.objectContaining({ status: 'running' })]);
        } finally { release(); await completion?.catch(() => {}); await owner.dispose(); await oldOwner.dispose(); }
    });

    it('settles a pending complete read as failed when native establishment fails, without reporting absence', async () => {
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let launchEntered = false;
        const start = owner.superviseProject({
            workspace: { id: 'checkout', serverId: 'home', machineId: 'source', rootPath: process.cwd(), createdAtMs: 1 },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'httpPort' } },
            cwd: process.cwd(), serviceId: 'httpPort', specIdentity: 'httpPort', isCurrent: () => true,
            requester: { serverId: 'home', accountId: 'owner', machineId: 'source', installationId: 'installation' },
            processSpec: { mode: { kind: 'managedSpawn', endpointNone: true } },
            authorizeLaunch: async () => {
                launchEntered = true; await gate;
                throw Object.assign(new Error('OS launch refused'), { code: 'EACCES' });
            },
        });
        void start.catch(() => {});
        const feed = createLocalServiceLauncherFeed({ machineId: 'source', projectManagedServices: owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry() });
        try {
            await vi.waitFor(() => expect(launchEntered).toBe(true));
            const read = feed.getSnapshot({ projection: 'managed_bindings', workspaceRoot: process.cwd() });
            const rejected = expect(read).rejects.toMatchObject({ code: 'plugin_managed_service_establishment_failed' });
            release();
            await expect(start).rejects.toMatchObject({ code: 'plugin_managed_service_establishment_failed' });
            await rejected;
            expect(owner.listProjectServices()).toEqual([]);
        } finally { release(); await start.catch(() => {}); await owner.dispose(); }
    });

    it.each(['inventory', 'declaration', 'move'] as const)('keeps native listener provenance through %s custody and preserves unrelated listeners', async scenario => {
        let current = true;
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // This literal Project command does not install plugin dependencies.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const previewRegistry = createLocalServicePreviewRegistry();
        try {
            const handle = await owner.superviseProject({
                workspace: { id: 'checkout', serverId: 'home', machineId: 'machine-a', rootPath: process.cwd(), createdAtMs: 1 },
                declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'httpPort' } },
                cwd: process.cwd(), serviceId: 'project-service:httpPort', specIdentity: 'httpPort', isCurrent: () => current,
                requester: { serverId: 'home', accountId: 'owner', machineId: 'machine-a', installationId: 'installation' },
                processSpec: { mode: { kind: 'managedSpawn', host: '127.0.0.1' } },
                authorizeLaunch: async input => ({ command: process.execPath,
                    args: ['-e', `require('node:http').createServer((req,res)=>res.end('ok')).listen(${input.endpoint!.port},'127.0.0.1')`],
                    env: {}, release: async () => undefined }),
            });
            const root = owner.readProcessRoots()[0];
            if (!root) throw new Error('Managed native process root is missing');
            const port = Number(new URL(handle.snapshot().baseUrl!).port);
            const direct = inventoryEntry({ id: 'owned-loopback', port, provenance: {
                process: { pid: root.pid, lineagePids: [root.pid], command: 'http server', cwd: process.cwd(), redacted: true },
            } });
            const child = inventoryEntry({ id: 'owned-wildcard', port,
                address: { kind: 'wildcard', host: '0.0.0.0', family: 'ipv4' },
                provenance: { process: { pid: root.pid + 1, lineagePids: [root.pid + 1, root.pid],
                    command: 'http child', cwd: process.cwd(), redacted: true } },
            });
            const unrelated = inventoryEntry({ id: 'unrelated', port,
                address: { kind: 'lan', host: '192.168.1.20', family: 'ipv4' },
                endpoint: { scheme: 'http', host: '192.168.1.20', port, probeState: 'ready', probedAt: 2_000 },
                provenance: { process: { pid: root.pid + 2, lineagePids: [root.pid + 2], command: 'http server', cwd: process.cwd(), redacted: true } },
            });
            inventoryRegistry.replaceSnapshot({ v: 1, machineId: 'machine-a', generatedAt: 2_000,
                refreshState: 'idle', entries: [direct, child, unrelated], diagnostics: [] });
            const serviceTarget = { kind: 'managed_service' as const, machineId: handle.workspace.machineId,
                workspaceId: handle.workspace.id, managedServiceId: handle.instanceId, cwd: handle.cwd, declaration: handle.declaration };
            const retiredPreview = registerLocalServicePreview(previewRegistry, { previewId: 'a-retired-preview', machineId: 'machine-a',
                serviceTarget: { ...serviceTarget, managedServiceId: 'retired-occurrence' },
                owner: { kind: 'user', id: 'owner' }, target: { scheme: 'http', host: '127.0.0.1', port },
                initialPath: { pathname: '/', search: '' }, display: { title: 'httpPort', addressLabel: `localhost:${port}` }, originMode: 'host' });
            expect(retiredPreview.ok).toBe(true);
            const preview = registerLocalServicePreview(previewRegistry, { previewId: 'owned-preview', machineId: 'machine-a', serviceTarget,
                owner: { kind: 'user', id: 'owner' }, target: { scheme: 'http', host: '127.0.0.1', port },
                initialPath: { pathname: '/', search: '' }, display: { title: 'httpPort', addressLabel: `localhost:${port}` }, originMode: 'host' });
            expect(preview.ok).toBe(true);
            if (!preview.ok) throw new Error('Managed preview registration failed');
            const createFeed = () => createLocalServiceLauncherFeed({ machineId: 'machine-a', projectManagedServices: owner,
                inventoryRegistry, previewRegistry, runTargets: scenario === 'inventory' ? [] : [{
                    id: handle.serviceId, cwd: handle.cwd, workspaceId: handle.workspace.id,
                    workspace: { serverId: handle.workspace.serverId, machineId: handle.workspace.machineId,
                        workspaceId: handle.workspace.id, rootPath: handle.workspace.rootPath },
                    declaration: handle.declaration, title: 'httpPort',
                }] });
            const feed = createFeed();
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(await feed.getSnapshot());
            expect(snapshot.targets.map(target => target.id)).toEqual([handle.serviceId, 'inventory:unrelated']);
            expect(snapshot.targets[0]).toMatchObject({ title: 'httpPort', actions: ['manage', 'open_preview', 'register_preview'],
                sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId, inventoryEntryId: direct.id },
                browserTarget: { kind: 'localServicePreview', targetId: 'owned-preview' } });
            expect(buildLocalServiceRows({ inventoryRows: [], launchTargets: snapshot.targets, sessionId: null, scope: 'machine' })
                .map(row => row.id)).toEqual([handle.serviceId, 'inventory:unrelated']);
            const bindings = LocalServiceLauncherSnapshotV1Schema.parse(await feed.getSnapshot({ projection: 'managed_bindings' }));
            expect(bindings.targets).toEqual([snapshot.targets[0]]);
            // The native listener may belong only to a descendant, with no direct-root binding.
            inventoryRegistry.replaceSnapshot({ v: 1, machineId: 'machine-a', generatedAt: 3_000,
                refreshState: 'idle', entries: [child, unrelated], diagnostics: [] });
            const descendantSnapshot = LocalServiceLauncherSnapshotV1Schema.parse(await feed.getSnapshot());
            expect(descendantSnapshot.targets.map(target => target.id)).toEqual([handle.serviceId, 'inventory:unrelated']);
            expect(descendantSnapshot.targets[0]?.sourceClass).toMatchObject({ inventoryEntryId: child.id });
            // A snapshot without listener evidence still reports authoritative managed custody.
            inventoryRegistry.replaceSnapshot({ v: 1, machineId: 'machine-a', generatedAt: 4_000,
                refreshState: 'idle', entries: [], diagnostics: [] });
            expect((await feed.getSnapshot({ projection: 'managed_bindings' })).targets).toEqual([
                expect.objectContaining({ id: handle.serviceId, actions: ['manage', 'open_preview'] }),
            ]);
            inventoryRegistry.replaceSnapshot({ v: 1, machineId: 'machine-a', generatedAt: 5_000,
                refreshState: 'idle', entries: [direct, child, unrelated], diagnostics: [] });
            if (scenario === 'move') {
                // Move retires serving authority before the old Machine finishes Stop.
                current = false;
                await expect(feed.getSnapshot({ projection: 'managed_bindings' })).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
                const handoff = LocalServiceLauncherSnapshotV1Schema.parse(await feed.getSnapshot());
                expect(handoff.targets.map(target => target.id)).toEqual([handle.serviceId, 'inventory:unrelated']);
                expect(handoff.targets[0]?.actions).toEqual(['manage']);
                expect(handoff.targets[0]?.browserTarget).toBeUndefined();
                // A first read during retirement must also correlate the live root.
                expect((await createFeed().getSnapshot()).targets.map(target => target.id)).toEqual([
                    handle.serviceId, 'inventory:unrelated',
                ]);
            }
            await handle.stop();
            expect(owner.listProjectServices()).toEqual([]);
            expect(owner.readProcessRoots()).toEqual([]);
            const stopped = LocalServiceLauncherSnapshotV1Schema.parse(await feed.getSnapshot());
            expect(selectRunningServiceForEndedPreview(buildBrowserLaunchpadRows({ launcherSnapshot: stopped }),
                preview.resource.browserTarget!)).toBeNull();
            expect(stopped.targets.map(target => target.id)).toEqual(scenario === 'inventory' ? [
                'inventory:owned-loopback', 'inventory:owned-wildcard', 'inventory:unrelated',
            ] : [handle.serviceId, 'inventory:unrelated']);
            if (scenario !== 'inventory') {
                // With only the cached owned listener, exactly the declaration remains.
                inventoryRegistry.replaceSnapshot({ v: 1, machineId: 'machine-a', generatedAt: 6_000,
                    refreshState: 'idle', entries: [{ ...direct }], diagnostics: [] });
                expect((await feed.getSnapshot()).targets.map(target => target.id)).toEqual([handle.serviceId]);
                // A fresh listener on the identical address/id, even with a reused PID,
                // is not the previously correlated cached observation.
                inventoryRegistry.replaceSnapshot({ v: 1, machineId: 'machine-a', generatedAt: 7_000,
                    refreshState: 'idle', entries: [{ ...direct, lastSeenAt: 7_000, provenance: {
                        process: { ...direct.provenance!.process!, processStartTimeMs: 7_000 },
                    } }], diagnostics: [] });
                expect((await feed.getSnapshot()).targets.map(target => target.id)).toEqual([
                    handle.serviceId, 'inventory:owned-loopback',
                ]);
            }
        } finally { await owner.dispose(); }
    });

    it.each(['running', 'unknown', 'stopped'] as const)('projects %s plugin-native custody with its exact preview and manage rights', async nativePhase => {
        let phase: 'running' | 'stopped' | 'unknown' = nativePhase;
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // This Project launch never reaches plugin dependency installation.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const handle = await owner.superviseProject({
            workspace: { id: 'checkout', serverId: 'home', machineId: 'machine-a', rootPath: process.cwd(), createdAtMs: 1 },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'native-service' } },
            cwd: process.cwd(), serviceId: 'native-service', specIdentity: 'native-service', isCurrent: () => true,
            ...(nativePhase === 'unknown' ? { execution: 'portable' as const } : {}),
            requester: { serverId: 'home', accountId: 'owner', machineId: 'machine-a', installationId: 'installation' },
            processSpec: { mode: { kind: 'native',
                instance: { adapter: { pluginId: 'fixture.plugin', localId: 'native-service' }, nativeResourceId: 'exact-instance' },
                lifecycle: { inspect: async () => ({ phase, readiness: phase === 'running' ? 'ready' : 'not_reported',
                    endpoint: phase === 'running' ? ['http:', '//127.0.0.1:4312'].join('') : null }),
                    stop: async () => { phase = 'stopped'; return { status: 'stopped' }; } } } },
            authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
                env: {}, release: async () => undefined }),
        });
        try {
            const previewRegistry = createLocalServicePreviewRegistry();
            if (nativePhase === 'running') {
                expect(registerLocalServicePreview(previewRegistry, { previewId: 'plugin-native-preview', machineId: 'machine-a',
                    serviceTarget: { kind: 'managed_service', machineId: 'machine-a', managedServiceId: handle.instanceId,
                        cwd: handle.cwd, declaration: handle.declaration }, owner: { kind: 'user', id: 'owner' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 4312 }, initialPath: { pathname: '/', search: '' },
                    display: { title: 'Native service', addressLabel: 'localhost:4312' }, originMode: 'host' }).ok).toBe(true);
            }
            const feed = createLocalServiceLauncherFeed({ machineId: 'machine-a', projectManagedServices: owner,
                inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry });
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(await feed.getSnapshot());
            if (nativePhase === 'running') {
                expect(owner.readProcessRoots()).toEqual([]);
                expect(snapshot.targets).toEqual([expect.objectContaining({ serviceState: 'healthy', actions: ['manage', 'open_preview'],
                    browserTarget: expect.objectContaining({ targetId: 'plugin-native-preview',
                        serviceTarget: expect.objectContaining({ managedServiceId: handle.instanceId }) }) })]);
                await handle.stop();
                expect((await feed.getSnapshot()).targets).toEqual([]);
                return;
            }
            expect(snapshot.targets).toEqual([expect.objectContaining({
                state: 'available', serviceState: 'unhealthy', actions: ['manage'],
                sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId },
                unavailableReason: nativePhase === 'unknown' ? 'managed_service_native_state_unknown' : 'managed_service_native_cleanup_unconfirmed',
            })]);
            expect(owner.listProjectServices()).toEqual([handle]);
            if (nativePhase === 'unknown') expect(snapshot.targets[0]).toHaveProperty('execution', 'portable');
            else expect(snapshot.targets[0]).not.toHaveProperty('execution');
        } finally { await handle.stop(); await owner.dispose(); }
    });

    it('refuses an unmounted managed binding owner instead of reporting authoritative absence', async () => {
        const feed = createLocalServiceLauncherFeed({ machineId: 'machine-a',
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry() });
        const request = { workspaceRoot: '/repo', projection: 'managed_bindings' as const };
        await expect(feed.getSnapshot(request)).rejects.toMatchObject({ code: 'project_service_bindings_unavailable' });
        expect((await feed.getSnapshot()).targets).toEqual([]);
    });

    it('projects daemon registries into a fail-closed launcher snapshot', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
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
            previewId: previewIdForInventoryEntry('account-a', 'machine-a', 'session-a', 'inventory-a'),
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
            originMode: 'host',
        });
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            sessionId: 'session-a',
            accountId: 'account-a',
            inventoryRegistry,
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
                id: 'inventory:inventory-a',
                source: 'inventory_entry',
                state: 'available',
                unavailableReason: null,
                actions: ['open_preview', 'register_preview'],
                browserTargetKind: 'localServicePreview',
            },
            {
                id: 'inventory:inventory-without-preview',
                source: 'inventory_entry',
                state: 'available',
                unavailableReason: null,
                actions: ['register_preview'],
                browserTargetKind: null,
            },
            {
                id: 'package:web:dev',
                source: 'package_script',
                state: 'unavailable',
                unavailableReason: 'launch_unavailable',
                actions: [],
                browserTargetKind: null,
            },
        ]);
        expect(snapshot.targets.find(target => target.id === 'inventory:inventory-a')?.browserTarget)
            .toMatchObject({ kind: 'localServicePreview', targetId: 'preview-a' });
    });

    it('preserves private-preview registration for a listening detected entry without a raw loopback target', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
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
            previewRegistry,
            now: () => 3_000,
        });

        const snapshot = await feed.getSnapshot();
        const target = snapshot.targets.find((t) => t.id === 'inventory:loopback-open');
        expect(target?.state).toBe('available');
        expect(target?.actions).toEqual(['register_preview']);
        expect(target?.browserTarget).toBeUndefined();
    });

    it('ranks an openable loopback entry above a package_script suggestion', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
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
        const previewRegistry = createLocalServicePreviewRegistry();

        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine-a',
            inventoryRegistry,
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
            previewRegistry,
            now: () => 3_000,
            resolveSessionWorkspacePaths: () => ['/repo/web'],
        });

        const snapshot = await feed.getSnapshot();

        const inventoryIds = snapshot.targets.filter((t) => t.source === 'inventory_entry').map((t) => t.id);
        expect(inventoryIds).toContain('inventory:entry-web');
        expect(inventoryIds).toContain('inventory:entry-foreign');
    });

    it('retains valid run-target discovery beyond one second', async () => {
        vi.useFakeTimers();
        try {
            const inventoryRegistry = createLocalServiceInventoryRegistry();
            const previewRegistry = createLocalServicePreviewRegistry();
            inventoryRegistry.replaceSnapshot({
                v: 1,
                machineId: 'machine-a',
                generatedAt: 2_000,
                refreshState: 'idle',
                entries: [inventoryEntry({ id: 'loopback-open', port: 5173, presentation: { addressLabel: 'localhost:5173' } })],
                diagnostics: [],
            });
            const discoveredTargets = [{
                id: 'web:dev',
                cwd: '/repo/web',
                packageName: 'web',
                packageManager: 'npm' as const,
                scriptName: 'dev',
                command: 'vite',
                launchIntent: { kind: 'packageScript' as const, packageManager: 'npm' as const, cwd: '/repo/web', scriptName: 'dev' },
            }];
            let releaseRunTargets: (targets: typeof discoveredTargets) => void = () => {};
            const runTargets = new Promise<typeof discoveredTargets>((resolve) => {
                releaseRunTargets = resolve;
            });
            const feed = createLocalServiceLauncherFeed({
                machineId: 'machine-a',
                inventoryRegistry,
                previewRegistry,
                now: () => 3_000,
                runTargets: () => runTargets,
            });

            let settled = false;
            const snapshotPromise = feed.getSnapshot()
                .then((snapshot) => { settled = true; return snapshot; });
            await vi.advanceTimersByTimeAsync(1_001);
            const settledBeforeDiscovery = settled;
            releaseRunTargets(discoveredTargets);
            const snapshot = await snapshotPromise;

            expect(settledBeforeDiscovery).toBe(false);
            expect(LocalServiceLauncherSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
            expect(snapshot.targets.map((target) => target.id)).toEqual(['inventory:loopback-open', 'package:web:dev']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not fail the launcher snapshot when run-target discovery rejects', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
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
