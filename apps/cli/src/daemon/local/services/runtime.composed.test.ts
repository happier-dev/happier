import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxiosError, AxiosHeaders } from 'axios';
import { createLocalServiceActionConfirmationNonceV1, type LocalServiceActionRequestV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { buildPluginHostedWebStaticAssetPreviewId } from '@happier-dev/protocol/plugins/ui';

import { createLocalServicesDaemonRuntime } from './runtime';
import {
    listLocalServicePreviewResources,
    registerLocalServicePreview,
    unregisterLocalServicePreview,
} from './preview/registry';
import type { NormalizedLocalServiceInventorySnapshot } from './inventory/scanner';
import { createLocalServiceEndpointEnricher } from './inventory/endpoint';
import { createLocalPageTitleEnricher } from './inventory/pageTitle';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState, selectLocalServiceLaunchTargets } from '../../../../../../apps/ui/sources/sync/domains/local/services/launch/store';
import { buildLocalServiceRows } from '../../../../../../apps/ui/sources/sync/domains/local/services/serviceRow';

function previewServerBoundary() {
    const registrations = new Map<string, unknown>();
    return {
        registrations,
        input: {
            token: 'daemon-token', serverBaseUrl: 'https://home.example.test',
            http: {
                async post(_url: string, body: unknown) {
                    const resource = LocalServicePreviewResourceV1Schema.parse(body);
                    registrations.set(resource.previewId, resource);
                    return { data: { resource, accessUrl: `https://preview.example.test${resource.initialPath.pathname}${resource.initialPath.search}`, expiresAt: 65_000 } };
                },
                async delete(url: string) {
                    if (!registrations.delete(decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? ''))) {
                        throw new AxiosError('Preview not found', undefined, undefined, undefined, {
                            status: 404,
                            statusText: 'Not Found',
                            headers: {},
                            config: { headers: new AxiosHeaders() },
                            data: { error: 'preview_not_found', reasonCode: 'preview_not_found' },
                        });
                    }
                    return { data: { ok: true } };
                },
            },
        },
    };
}

function buildSnapshot(
    overrides: Partial<NormalizedLocalServiceInventorySnapshot> = {},
): NormalizedLocalServiceInventorySnapshot {
    return {
        v: 1,
        machineId: 'machine-a',
        generatedAt: 1_000,
        refreshState: 'idle',
        diagnostics: [],
        entries: [{
            id: 'entry-1',
            machineId: 'machine-a',
            address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
            endpoint: {
                scheme: 'http',
                host: '127.0.0.1',
                port: 5173,
                probeState: 'ready',
                probedAt: 1_000,
            },
            port: 5173,
            protocol: 'tcp',
            detectedAt: 1_000,
            lastSeenAt: 1_000,
            state: 'listening',
            source: 'detected',
            labels: [],
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            workspaceAssociationConfidence: 'high',
            diagnostics: [],
            provenance: {
                process: {
                    pid: 400,
                    ppid: 300,
                    lineagePids: [400, 300, 1],
                    command: 'npm run dev',
                    cwd: '/repo/app',
                    redacted: true,
                },
            },
        }],
        ...overrides,
    };
}

describe('createLocalServicesDaemonRuntime', () => {
    it('keeps scans fresh without waking inventory or launcher readers for unchanged facts', async () => {
        let observedAt = 1_000;
        let port = 5173;
        const scan = vi.fn(async () => ({
            listeners: [{ address: '127.0.0.1', port, protocol: 'tcp' as const }],
            processes: new Map(), workspaces: [], diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, scan, runTargets: () => [], now: () => observedAt });
        const cancellation = new AbortController();
        try {
            const first = await runtime.refreshInventoryNow();
            let publications = 0;
            let launcherReads = 0;
            runtime.inventoryRegistry.subscribe(() => { publications++; });
            const watched = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: first.generatedAt, signal: cancellation.signal })
                .then(async result => {
                    if (result.changed) {
                        launcherReads++;
                        await runtime.launcherRoutes.getSnapshot({ scope: 'machine' });
                    }
                });
            for (let index = 1; index <= 75; index++) {
                observedAt += 10_000;
                await runtime.refreshInventoryNow();
            }
            await new Promise<void>(resolve => setImmediate(resolve));
            expect({ publications, launcherReads }).toEqual({ publications: 0, launcherReads: 0 });
            expect(runtime.inventoryRegistry.getSnapshot().generatedAt).toBe(first.generatedAt);
            expect(runtime.inventoryRegistry.getSnapshot().entries[0]?.lastSeenAt).toBe(observedAt);
            const scanCount = scan.mock.calls.length;
            await runtime.inventoryRoutes.getSnapshot();
            await runtime.launcherRoutes.getSnapshot({ scope: 'machine' });
            expect(scan).toHaveBeenCalledTimes(scanCount);
            port = 5174;
            observedAt += 10_000;
            await runtime.refreshInventoryNow();
            await watched;
            expect({ publications, launcherReads }).toEqual({ publications: 1, launcherReads: 1 });
        } finally { cancellation.abort(); await runtime.stop(); }
    });

    it('keeps native action freshness independent of a silent material generation', async () => {
        let observedAt = 1_000;
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, now: () => observedAt, runTargets: () => [],
            scan: async () => ({ listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([[400, { pid: 400, ppid: 1, command: 'server', cwd: '/repo' }]]),
                workspaces: [], diagnostics: [] }) });
        try {
            const first = await runtime.refreshInventoryNow();
            const entry = first.entries[0];
            if (!entry?.provenance?.process) throw new Error('Expected listener identity');
            observedAt = 2_000;
            // A mismatched identity must be rejected by the real native probe, before signalling.
            const outcome = await runtime.terminateDetectedService({ now: observedAt,
                entry: { ...entry, provenance: { process: { ...entry.provenance.process, pid: 401 } } },
                request: { requestId: 'identity-check', action: 'terminate_detected', force: false,
                    target: { kind: 'inventory_entry', machineId: 'machine-a', inventoryEntryId: entry.id } } });
            expect(outcome).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
            expect(runtime.inventoryRegistry.getSnapshot().generatedAt).toBe(first.generatedAt);
        } finally { await runtime.stop(); }
    });

    it('preserves native discovery cadence across an unchanged watch window and reports disappearance on the next scan', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let listenerPresent = true;
        const scan = vi.fn(async () => ({ listeners: listenerPresent
            ? [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const }] : [],
            processes: new Map(), workspaces: [], diagnostics: [] }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', inventoryEnabled: () => true,
            scan, runTargets: () => [] });
        try {
            const initial = await runtime.inventoryRoutes.getSnapshot();
            const watch = () => runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: initial.generatedAt });
            const first = watch();
            await vi.advanceTimersByTimeAsync(25_000);
            expect(await first).toEqual({ changed: false });
            expect(scan).toHaveBeenCalledTimes(3);
            listenerPresent = false;
            const second = watch();
            await vi.advanceTimersByTimeAsync(4_999);
            expect(scan).toHaveBeenCalledTimes(3);
            await vi.advanceTimersByTimeAsync(1);
            const changed = await second;
            expect(scan).toHaveBeenCalledTimes(4);
            expect(changed.changed && changed.snapshot.entries[0]?.state).toBe('stale');
        } finally { await runtime.stop(); vi.useRealTimers(); }
    });

    it('publishes declaration changes and endpoint-free managed start/stop without a listener change', async () => {
        let observedAt = 1_000;
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Literal Project commands do not install plugin dependencies.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const runTargets: import('./launch/runTargets').LocalServiceLauncherRunTarget[] = [];
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, now: () => observedAt, projectManagedServices: owner,
            runTargets: () => runTargets,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const workspaceRef = { id: 'checkout', serverId: 'home', machineId: 'machine-a', rootPath: process.cwd(), createdAtMs: 1 };
        const workspace = { serverId: workspaceRef.serverId, machineId: workspaceRef.machineId, workspaceId: workspaceRef.id,
            rootPath: workspaceRef.rootPath };
        const declaration = { workspaceRefId: workspaceRef.id, selection: { kind: 'manifest', name: 'worker' } } as const;
        let publications = 0;
        runtime.inventoryRegistry.subscribe(() => { publications++; });
        const observe = async () => { observedAt += 10_000; await runtime.refreshInventoryNow(); };
        try {
            await observe();
            expect(publications).toBe(1);
            await observe();
            expect(publications).toBe(1);
            runTargets.push({ id: 'worker', cwd: workspace.rootPath, workspaceId: workspace.workspaceId,
                workspace, declaration, title: 'worker' });
            await observe();
            expect(publications).toBe(2);
            const handle = await owner.superviseProject({ workspace: workspaceRef, declaration, cwd: workspaceRef.rootPath,
                serviceId: 'worker', specIdentity: 'worker', isCurrent: () => true,
                requester: { serverId: 'home', accountId: 'owner', machineId: 'machine-a', installationId: 'installation' },
                processSpec: { mode: { kind: 'managedSpawn', endpointNone: true } },
                authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
                    env: {}, release: async () => undefined }) });
            await observe();
            expect(publications).toBe(3);
            expect((await runtime.launcherRoutes.getSnapshot({ scope: 'machine' })).targets).toEqual([
                expect.objectContaining({ serviceState: 'running', endpointKind: 'none' }),
            ]);
            await observe();
            expect(publications).toBe(3);
            await handle.stop();
            await observe();
            expect(publications).toBe(4);
            expect((await runtime.launcherRoutes.getSnapshot({ scope: 'machine' })).targets).toEqual([
                expect.objectContaining({ id: 'worker', state: 'unavailable', actions: [] }),
            ]);
            await observe();
            expect(publications).toBe(4);
        } finally { await runtime.stop(); await owner.dispose(); }
    });

    it.each(['running', 'unknown'] as const)('carries only failed native diagnostics to Services rows without republishing equal %s observations', async initialPhase => {
        let phase: 'running' | 'unknown' | 'stopped' = initialPhase;
        let observedAt = 1_000;
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Literal Project commands never reach plugin dependency installation.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, now: () => observedAt, projectManagedServices: owner, runTargets: () => [],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        try {
            const handle = await owner.superviseProject({
                workspace: { id: 'checkout', serverId: 'home', machineId: 'machine-a', rootPath: process.cwd(), createdAtMs: 1 },
                declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'native-worker' } },
                cwd: process.cwd(), serviceId: 'native-worker', specIdentity: 'native-worker', isCurrent: () => true,
                requester: { serverId: 'home', accountId: 'owner', machineId: 'machine-a', installationId: 'installation' },
                // Native lifecycle callbacks are the external-system boundary. Supervision, sanitization,
                // daemon projection, wire parsing and the Services data model remain real.
                processSpec: { mode: { kind: 'native',
                    instance: { adapter: { pluginId: 'fixture.plugin', localId: 'worker' }, nativeResourceId: 'exact-worker' },
                    lifecycle: {
                        inspect: async () => ({ phase, readiness: phase === 'running' ? 'ready' : 'not_ready', endpoint: null }),
                        logs: async () => 'Native worker failed with fixture-service-secret',
                        stop: async () => { phase = 'stopped'; return { status: 'stopped' }; },
                    } } },
                authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
                    env: { FIXTURE_SERVICE_TOKEN: 'fixture-service-secret' }, release: async () => undefined }),
            });
            await runtime.refreshInventoryNow();
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(await runtime.launcherRoutes.getSnapshot({ scope: 'machine' }));
            const targets = selectLocalServiceLaunchTargets(applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), snapshot));
            const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: targets, sessionId: null, scope: 'machine' });
            expect(row?.target.id).toBe(handle.serviceId);
            if (initialPhase === 'unknown') {
                const retainedOutput = handle.snapshot().diagnostics.find(diagnostic => diagnostic.code === 'native_service_output');
                expect(retainedOutput).toMatchObject({ severity: 'info', message: expect.stringContaining('Native worker failed') });
                expect(row?.target).toHaveProperty('diagnostics', expect.arrayContaining([retainedOutput]));
                expect(JSON.stringify(snapshot)).not.toContain('fixture-service-secret');
                expect(JSON.stringify(snapshot)).not.toContain('FIXTURE_SERVICE_TOKEN');
            } else {
                expect(row?.target).not.toHaveProperty('diagnostics');
            }
            let publications = 0;
            runtime.inventoryRegistry.subscribe(() => { publications++; });
            for (let index = 0; index < 75; index++) {
                observedAt += 10_000;
                await runtime.refreshInventoryNow();
            }
            expect(publications).toBe(0);
            if (initialPhase === 'unknown') {
                phase = 'running';
                await handle.waitUntilHealthy();
                expect(handle.snapshot().diagnostics.some(diagnostic => diagnostic.code === 'native_service_output')).toBe(true);
                observedAt += 10_000;
                await runtime.refreshInventoryNow();
                expect(publications).toBe(1);
                const recovered = LocalServiceLauncherSnapshotV1Schema.parse(await runtime.launcherRoutes.getSnapshot({ scope: 'machine' }));
                expect(recovered.targets[0]).not.toHaveProperty('diagnostics');
            }
        } finally { await runtime.stop(); await owner.dispose(); }
    });

    it.each(['command', 'native-starter', 'native-resource', 'native-lifetime'] as const)('retains a failed %s start and its existing output through the real Services feed', async kind => {
        let observedAt = 1_000;
        let restored = false;
        let started = false;
        let resourceExited = false;
        let logStarted = false;
        let releaseOutput!: () => void;
        const outputReady = new Promise<void>(resolve => { releaseOutput = resolve; });
        let releaseLaunch!: () => void;
        const launchReleased = new Promise<void>(resolve => { releaseLaunch = resolve; });
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, now: () => observedAt, projectManagedServices: owner, runTargets: () => [],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
        const start = () => owner.superviseProject({
            workspace: { id: 'checkout', serverId: 'home', machineId: 'machine-a', rootPath: process.cwd(), createdAtMs: 1 },
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: kind } },
            cwd: process.cwd(), serviceId: kind, specIdentity: restored ? `${kind}-restored` : kind, isCurrent: () => true,
            requester: { serverId: 'home', accountId: 'owner', machineId: 'machine-a', installationId: 'installation' },
            processSpec: { ...(kind === 'native-lifetime' ? { watchdog: { intervalMs: 250, missedIntervals: 1 } } : {}),
                mode: kind === 'command' ? { kind: 'managedSpawn', endpointNone: true } : {
                kind: 'native', builtinLifecycle: {
                    inspect: async () => {
                        const running = started && (restored || kind === 'native-lifetime' && !resourceExited);
                        return { phase: running ? 'running' : 'stopped', readiness: 'not_reported',
                            endpoint: running && kind === 'native-lifetime' ? 'http://127.0.0.1:43210' : null };
                    },
                    markStarted() { started = true; },
                    logs: async () => {
                        logStarted = true;
                        if (kind === 'native-lifetime') await outputReady;
                        return 'container failed with fixture-service-secret';
                    },
                    stop: async () => { started = false; return { status: 'stopped' }; },
                },
            } },
            authorizeLaunch: async () => ({ command: process.execPath,
                args: ['-e', restored && kind === 'command' ? 'setInterval(() => {}, 1000)'
                    : `console.error('service failed with fixture-service-secret'); process.exit(${kind === 'native-resource' || kind === 'native-lifetime' || restored ? 0 : 3})`],
                env: { FIXTURE_TOKEN: 'fixture-service-secret' }, release: async () => { releaseLaunch(); } }),
        });
        const readRow = async (projection?: 'managed_bindings') => {
            const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(await runtime.launcherRoutes.getSnapshot({ scope: 'machine', projection }));
            const targets = selectLocalServiceLaunchTargets(applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), snapshot));
            return buildLocalServiceRows({ inventoryRows: [], launchTargets: targets, sessionId: null, scope: 'machine' })[0];
        };
        try {
            // A rejected starter still leaves a reviewable failed attempt; a successful detached
            // starter does not make its already-dead native resource a successful Service.
            const launching = start();
            const joinedFailure = kind === 'native-starter'
                ? readRow('managed_bindings').catch((error: unknown) => ({ error })) : null;
            await launching.catch(() => undefined);
            if (joinedFailure) expect(await joinedFailure).toMatchObject({ status: 'failed' });
            // Endpoint-free admission returns before process exit. Join the actual launch
            // release so this checks the observed exit rather than scheduler speed.
            if (kind === 'command') await launchReleased;
            resourceExited = true;
            if (kind === 'native-lifetime') {
                await vi.waitFor(() => expect(logStarted).toBe(true));
                // Output IO may remain pending after resource death. Serving authority
                // must be withdrawn before awaiting it, without racing cleanup against it.
                expect(owner.listProjectServices()[0]?.snapshot().baseUrl).toBeNull();
                expect((await readRow())?.target).not.toHaveProperty('endpointUrl');
                releaseOutput();
            }
            await vi.waitFor(async () => {
                const row = await readRow();
                expect(row?.status).toBe('failed');
                expect(row?.target.diagnostics).toEqual(expect.arrayContaining([
                    expect.objectContaining({ message: expect.stringContaining('failed with [REDACTED]') }),
                ]));
                expect(JSON.stringify(row)).not.toContain('fixture-service-secret');
            }, { timeout: 10_000 });
            expect((await readRow('managed_bindings'))?.status).toBe('failed');
            await runtime.refreshInventoryNow();
            let publications = 0;
            runtime.inventoryRegistry.subscribe(() => { publications++; });
            for (let index = 0; index < 75; index++) { observedAt += 10_000; await runtime.refreshInventoryNow(); }
            expect(publications).toBe(0);
            restored = true;
            started = false;
            const recovered = await start();
            observedAt += 10_000;
            await runtime.refreshInventoryNow();
            expect((await readRow())?.status).toBe('running');
            expect((await readRow())?.target).not.toHaveProperty('diagnostics');
            expect(publications).toBe(1);
            await recovered.stop();
            expect(owner.listProjectServices()).toEqual([]);
        } finally { releaseOutput(); await runtime.stop(); await owner.dispose(); }
    });

    it('reads exact managed bindings while listener hydration is pending, keeping ordinary launcher reads fresh', async () => {
        let releaseScan!: () => void;
        const scanned = new Promise<void>(resolve => { releaseScan = resolve; });
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // No plugin dependency operation is reached by an empty Project binding observation.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, projectManagedServices: owner, runTargets: () => [],
            scan: async () => { await scanned; return { listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const }],
                processes: new Map(), workspaces: [], diagnostics: [] }; } });
        const inventory = runtime.refreshInventoryNow();
        let bindings: unknown;
        let ordinary: unknown;
        const bindingRead = runtime.launcherRoutes.getSnapshot({ scope: 'workspace', workspaceRoot: '/source', projection: 'managed_bindings' })
            .then(value => { bindings = LocalServiceLauncherSnapshotV1Schema.parse(value); });
        const ordinaryRead = runtime.launcherRoutes.getSnapshot({ scope: 'machine' }).then(value => { ordinary = value; });
        try {
            await vi.waitFor(() => expect(bindings).toMatchObject({ machineId: 'machine-a', targets: [] }));
            expect(ordinary).toBeUndefined();
            releaseScan();
            await Promise.all([inventory, bindingRead, ordinaryRead]);
            expect(LocalServiceLauncherSnapshotV1Schema.parse(ordinary).targets).toEqual([
                expect.objectContaining({ source: 'inventory_entry', state: 'available' }),
            ]);
        } finally { releaseScan(); await Promise.all([inventory, bindingRead, ordinaryRead]); await runtime.stop(); await owner.dispose(); }
    });
    it('projects manifest and detected native services from actual accepted WorkspaceRefs without a Session', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-local-service-declarations-'));
        await mkdir(join(root, '.happier'));
        await writeFile(join(root, '.happier', 'project.json'), JSON.stringify({
            version: 1, services: { worker: { source: { kind: 'command', command: 'worker-command' } } },
        }));
        await writeFile(join(root, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
        const workspace = { id: 'accepted-workspace', serverId: 'home-a', machineId: 'machine-a',
            rootPath: root, projectKey: 'project-a', createdAtMs: 1 };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', startLoop: false, inventoryEnabled: () => true,
            workspaceFacts: () => ({ facts: [{ id: workspace.id, path: root }],
                acceptedWorkspaceRefs: [workspace], diagnostics: [] }),
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
        });
        try {
            const snapshot = await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            expect(snapshot.targets.map(target => ({
                cwd: target.cwd, workspaceId: target.workspaceId, declaration: target.declaration,
            }))).toEqual(expect.arrayContaining([
                { cwd: root, workspaceId: workspace.id, declaration: {
                    workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'worker' },
                } },
                { cwd: root, workspaceId: workspace.id, declaration: {
                    workspaceRefId: workspace.id, selection: { kind: 'native', source: {
                        kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'web',
                    } },
                } },
            ]));
            expect(snapshot).not.toHaveProperty('sessionId');
            expect(snapshot.targets.every(target => !target.actions.includes('start'))).toBe(true);
        } finally {
            await runtime.stop();
            await rm(root, { recursive: true, force: true });
        }
    });
    it('discovers a sessionless workspace through the same workspace facts used by inventory', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-local-service-workspace-'));
        await writeFile(join(root, 'package.json'), JSON.stringify({
            name: 'sessionless-project', scripts: { dev: 'vite' },
        }));
        // Scan and workspace facts are OS/storage boundaries. Discovery and feed projection stay real.
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', startLoop: false, inventoryEnabled: () => true,
            workspaceFacts: () => [{ id: 'accepted-workspace', path: root }],
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
        });
        try {
            const snapshot = await runtime.launcherRoutes.getSnapshot({ workspaceRoot: root });
            expect(snapshot.targets).toEqual([expect.objectContaining({
                id: 'package:sessionless-project:dev', source: 'package_script', cwd: root,
            })]);
            expect(snapshot).not.toHaveProperty('sessionId');
        } finally {
            await runtime.stop();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('never projects an unavailable scan or a disabled feature as a ready zero', async () => {
        const failed = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', startLoop: false, inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [{ code: 'windows_netstat_scan_failed', severity: 'error' as const }] }),
        });
        expect(failed.subscribeSummary).toBeTypeOf('function');
        const errors: unknown[] = [];
        const unsubscribeFailed = failed.subscribeSummary((summary) => errors.push(summary));
        await failed.refreshInventoryNow();
        expect(errors.at(-1)).toEqual({ v: 1, state: 'error' });
        unsubscribeFailed();
        await failed.stop();
        const disabled = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false, inventoryEnabled: () => false });
        const summaries: unknown[] = [];
        const unsubscribeDisabled = disabled.subscribeSummary((summary) => summaries.push(summary));
        await disabled.refreshInventoryNow();
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'disabled' });
        unsubscribeDisabled();
        await disabled.stop();
    });
    it('invalidates a ready summary when the scanner throws and recovers on the next scan', async () => {
        let failScan = false;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', startLoop: false, inventoryEnabled: () => true,
            scan: async () => {
                if (failScan) throw new Error('OS scan unavailable');
                return { listeners: [], processes: new Map(), workspaces: [], diagnostics: [] };
            },
        });
        const summaries: unknown[] = [];
        const unsubscribe = runtime.subscribeSummary((summary) => summaries.push(summary));
        await runtime.refreshInventoryNow();
        failScan = true;
        await expect(runtime.refreshInventoryNow()).rejects.toThrow('OS scan unavailable');
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'error' });
        failScan = false;
        await runtime.refreshInventoryNow();
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
        unsubscribe();
        await runtime.stop();
    });
    it('pushes one stable machine summary from the inventory and distinguishes scan failure from zero', async () => {
        const scan = vi.fn(async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', inventoryEnabled: () => true, scan, startLoop: false });
        const summaries: unknown[] = [];
        expect(runtime.subscribeSummary).toBeTypeOf('function');
        const unsubscribe = runtime.subscribeSummary((summary) => summaries.push(summary));
        await runtime.refreshInventoryNow();
        expect(summaries).toEqual([{ v: 1, state: 'unknown' }, { v: 1, state: 'ready', runningCount: 0 }]);
        const snapshot = buildSnapshot();
        runtime.inventoryRegistry.replaceSnapshot({ ...snapshot, entries: [
            ...snapshot.entries,
            { ...snapshot.entries[0]!, id: 'wildcard', address: { kind: 'wildcard', host: '::', family: 'ipv6' } },
            { ...snapshot.entries[0]!, id: 'internal', port: 3000, classification: { kind: 'happier', signals: [] } },
        ] });
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 1 });
        const last = summaries.at(-1);
        runtime.inventoryRegistry.replaceSnapshot({ ...runtime.inventoryRegistry.getSnapshot(), generatedAt: 2_000 });
        expect(summaries.at(-1)).toBe(last);
        expect(summaries).toHaveLength(3);
        runtime.inventoryRegistry.replaceSnapshot({ ...runtime.inventoryRegistry.getSnapshot(), refreshState: 'error' });
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'error' });
        await runtime.refreshInventoryNow();
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
        unsubscribe();
        await runtime.stop();
    });

    it('does not scan for a passive Machine summary publisher without an inventory reader', async () => {
        vi.useFakeTimers();
        try {
            let listenerPresent = false;
            const scan = vi.fn(async () => ({ listeners: listenerPresent
                ? [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const }] : [],
                processes: new Map(), workspaces: [], diagnostics: [] }));
            const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', inventoryEnabled: () => true, scan, refreshIntervalMs: 1_000 });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(scan).not.toHaveBeenCalled();
            expect(runtime.subscribeSummary).toBeTypeOf('function');
            const unsubscribe = runtime.subscribeSummary(() => {});
            await vi.advanceTimersByTimeAsync(3_000);
            expect(scan).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            // An actual read still acquires fresh facts through the same owner.
            await runtime.inventoryRoutes.getSnapshot();
            expect(scan).toHaveBeenCalledTimes(1);
            expect(runtime.getSummary()).toEqual({ v: 1, state: 'ready', runningCount: 0 });
            const watched = runtime.inventoryRoutes.watchSnapshot({
                sinceGeneratedAt: runtime.inventoryRegistry.getSnapshot().generatedAt,
            });
            await vi.advanceTimersByTimeAsync(1_000);
            expect(runtime.inventoryRoutes.watcherCount()).toBe(1);
            listenerPresent = true;
            await vi.advanceTimersByTimeAsync(1_000);
            expect((await watched).changed).toBe(true);
            expect(scan.mock.calls.length).toBeGreaterThan(1);
            expect(runtime.inventoryRoutes.watcherCount()).toBe(0);
            unsubscribe();
            const count = scan.mock.calls.length;
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(scan.mock.calls.length).toBe(count);
            const unsubscribeAgain = runtime.subscribeSummary(() => {});
            await vi.advanceTimersByTimeAsync(1_000);
            expect(scan.mock.calls.length).toBe(count);
            unsubscribeAgain();
            expect(vi.getTimerCount()).toBe(0);
            await runtime.stop();
        } finally { vi.useRealTimers(); }
    });

    it('does no native or presentation work for summary observers until an inventory reader arrives', async () => {
        vi.useFakeTimers();
        const readProcessFacts = vi.fn(async () => new Map([
            [400, { pid: 400, ppid: 1, command: 'node server.js', cwd: '/repo/app' }],
        ]));
        const probe = vi.fn(async () => true);
        const title = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('<title>Local app</title>', {
            headers: { 'content-type': 'text/html' },
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', inventoryEnabled: () => true, refreshIntervalMs: 1_000,
            scan: async () => ({ listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map(), readProcessFacts, workspaces: [], diagnostics: [] }),
            endpointEnricher: createLocalServiceEndpointEnricher({ now: Date.now,
                timeoutMs: 250, concurrency: 1, successTtlMs: 30_000, failureTtlMs: 5_000, probe }),
            pageTitleEnricher: createLocalPageTitleEnricher({ maxBodyBytes: 1_024,
                timeoutMs: 650, concurrency: 1, successTtlMs: 30_000, failureTtlMs: 10_000, fetch: title }),
        });
        const unsubscribe = runtime.subscribeSummary(() => {});
        try {
            await vi.advanceTimersByTimeAsync(2_000);
            expect(runtime.getSummary()).toEqual({ v: 1, state: 'unknown' });
            expect(readProcessFacts).not.toHaveBeenCalled();
            expect(runtime.inventoryRegistry.getSnapshot().generatedAt).toBe(0);
            expect(probe).not.toHaveBeenCalled();
            expect(title).not.toHaveBeenCalled();
            const watched = await runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: 0 });
            expect(watched.changed).toBe(true);
            expect(runtime.getSummary()).toEqual({ v: 1, state: 'ready', runningCount: 1 });
            if (!watched.changed) throw new Error('Expected the newly scanned inventory');
            expect(watched.snapshot.entries[0]?.endpoint?.probeState).toBe('ready');
            expect(watched.snapshot.entries[0]?.presentation?.pageTitle).toBe('Local app');
            expect(watched.snapshot.entries[0]?.provenance?.process?.cwd).toBe('/repo/app');
            const snapshot = await runtime.inventoryRoutes.getSnapshot();
            expect(snapshot.entries[0]?.endpoint?.probeState).toBe('ready');
            expect(snapshot.entries[0]?.presentation?.pageTitle).toBe('Local app');
            expect(probe).toHaveBeenCalled();
            expect(title).toHaveBeenCalled();
            expect(readProcessFacts).toHaveBeenCalled();
        } finally { unsubscribe(); await runtime.stop(); vi.useRealTimers(); }
    });

    it('does not treat registered preview access as evidence of a running listener', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a', inventoryEnabled: () => true, startLoop: false,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
        });
        const summaries: unknown[] = [];
        expect(runtime.subscribeSummary).toBeTypeOf('function');
        const unsubscribe = runtime.subscribeSummary((summary) => summaries.push(summary));
        await runtime.refreshInventoryNow();
        const registered = registerLocalServicePreview(runtime.previewRegistry, {
            previewId: 'preview-a', sessionId: 'session-a', machineId: 'machine-a',
            owner: { kind: 'session', id: 'session-a' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'App', addressLabel: 'localhost:5173' }, originMode: 'host',
        });
        expect(registered.ok).toBe(true);
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());
        expect(summaries).toHaveLength(3);
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 1 });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot({ entries: [] }));
        expect(summaries).toHaveLength(4);
        unregisterLocalServicePreview(runtime.previewRegistry, 'preview-a');
        expect(summaries.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
        unsubscribe();
        await runtime.stop();
    });

    it('keeps the last known services when the inventory gate never resolved, without claiming to have looked', async () => {
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // `localServices.inventory` is server-represented, so with no snapshot the decision is
            // fail-closed and undecided (probe_failed): the daemon did not scan and therefore knows
            // nothing new. It keeps what it last saw and reports the refresh as unsuccessful — it
            // does not age those rows as if a scan had looked for them and missed them.
            resolveServerFeaturesSnapshot: () => undefined,
            scan,
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('listening');
        expect(snapshot.refreshState).toBe('error');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_probe_failed', severity: 'info' },
        ]);
    });

    it('does not publish an empty inventory when the gate decision itself never resolved', async () => {
        // The fresh-daemon shape of the same false negative the scan boundary used to produce. The
        // server-features probe is a 1.5 s fetch on an event loop this daemon can stall for tens of
        // seconds; when it does not resolve, the daemon never scans and knows nothing about this
        // machine's services. Reporting that as a settled `idle` inventory with zero entries is what
        // renders a terminal "No local services detected" over running services.
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            resolveServerFeaturesSnapshot: () => ({ status: 'error', reason: 'timeout' }),
            scan,
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toEqual([]);
        expect(snapshot.refreshState).toBe('error');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_probe_failed', severity: 'info' },
        ]);
    });

    it('preserves last-known listening entries when a listener scan failure is non-authoritative', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [{
                    code: 'darwin_lsof_scan_failed',
                    severity: 'warning' as const,
                    message: 'Darwin local-service listener scan failed.',
                }],
            }),
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.refreshState).toBe('error');
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('listening');
        expect(snapshot.diagnostics).toEqual([{
            code: 'darwin_lsof_scan_failed',
            severity: 'warning',
            message: 'Darwin local-service listener scan failed.',
        }]);
    });

    it('keeps launcher targets openable after a non-authoritative inventory scan failure', async () => {
        const server = previewServerBoundary();
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            accountId: 'account-a', previewServer: server.input,
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [{
                    code: 'linux_procfs_scan_failed',
                    severity: 'warning' as const,
                    message: 'procfs unavailable',
                }],
            }),
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());
        const opened = await runtime.previewRoutes.openOrCreate({
            machineId: 'machine-a', inventoryEntryId: 'entry-1',
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error(opened.reasonCode);

        await runtime.refreshInventoryNow();
        const launcherSnapshot = await runtime.launcherRoutes.getSnapshot();
        const target = launcherSnapshot.targets.find((candidate) => candidate.id === 'inventory:entry-1');

        expect(target).toMatchObject({
            state: 'available',
            browserTarget: { kind: 'localServicePreview' },
        });
        expect(target?.browserTarget).toEqual(opened.response.preview.resource.browserTarget);
        const reopened = await runtime.previewRoutes.openOrCreate({
            machineId: 'machine-a', inventoryEntryId: 'entry-1',
        });
        expect(reopened.ok).toBe(true);
        if (!reopened.ok) throw new Error(reopened.reasonCode);
        expect(reopened.response.status).toBe('existing');
        expect(reopened.response.preview.resource.previewId).toBe(opened.response.preview.resource.previewId);
        expect(reopened.response.preview.accessUrl).toBeTruthy();
        await runtime.stop();
    });

    it('runs the inventory scan when the server reports localServices inventory enabled', async () => {
        const scan = vi.fn(async () => ({
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const, pid: 400 }],
            processes: new Map([
                [400, { pid: 400, ppid: 1, command: 'node server.js', cwd: '/repo/app' }],
            ]),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // Server-represented gate (default-allow): the daemon scans when the server allows it.
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { localServices: { enabled: true, inventory: { enabled: true } } },
                    capabilities: {},
                }),
            }),
            scan,
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).toHaveBeenCalledOnce();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('listening');
    });

    it('does not scan when the server explicitly disables localServices inventory', async () => {
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // A server that sets the bit false disables inventory scanning for its users.
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { localServices: { enabled: false, inventory: { enabled: false } } },
                    capabilities: {},
                }),
            }),
            scan,
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('stale');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_feature_disabled', severity: 'info' },
        ]);
    });

    it('refreshes inventory through the scanner and normalizes listener process lineage', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'npm run dev', cwd: '/repo/app' }],
                ]),
                workspaces: [{ id: 'workspace-a', path: '/repo' }],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            id: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-unknown',
            port: 5173,
            state: 'listening',
            source: 'detected',
        });
        expect(snapshot.entries[0]?.provenance?.process).toMatchObject({ pid: 400, ppid: 300 });
    });

    it('single-flights concurrent refreshInventoryNow callers onto one coalesced scan', async () => {
        let resolveScan: () => void = () => {};
        const scanGate = new Promise<void>((resolve) => {
            resolveScan = resolve;
        });
        const scan = vi.fn(async () => {
            await scanGate;
            return {
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const, pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 1, command: 'node server.js', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            };
        });
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan,
            now: () => 2_000,
            startLoop: false,
        });

        // Three concurrent refresh requests (e.g. the loop tick + an RPC manual refresh +
        // a bare caller) must share a single in-flight scan rather than stacking machine-wide
        // scans on top of each other.
        const first = runtime.refreshInventoryNow();
        const second = runtime.refreshInventoryNow();
        const third = runtime.refreshInventoryNow();
        resolveScan();
        const [a, b, c] = await Promise.all([first, second, third]);

        expect(scan).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(a.entries).toHaveLength(1);

        // A later refresh, once the first has settled, starts a fresh scan (the guard
        // coalesces overlapping callers, it does not cache forever).
        await runtime.refreshInventoryNow();
        expect(scan).toHaveBeenCalledTimes(2);
    });

    it('shares pending native facts before HTTP presentation but never reuses them for a later Guard read', async () => {
        let releaseWorkspace!: () => void;
        let enterHttp!: () => void;
        let releaseHttp!: () => void;
        const workspaceRead = new Promise<void>(resolve => { releaseWorkspace = resolve; });
        const httpEntered = new Promise<void>(resolve => { enterHttp = resolve; });
        const httpRead = new Promise<void>(resolve => { releaseHttp = resolve; });
        let visitors = 0;
        let scans = 0;
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, workspaceFacts: async () => { await workspaceRead; return []; },
            scan: async () => { scans += 1; return {
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400, establishedConnections: visitors }],
                processes: new Map([[400, { pid: 400, command: 'node server.js' }]]), workspaces: [], diagnostics: [],
            }; },
            endpointEnricher: createLocalServiceEndpointEnricher({ now: () => 2_000, timeoutMs: 250, concurrency: 1,
                successTtlMs: 30_000, failureTtlMs: 5_000, probe: async ({ scheme }) => scheme === 'http' }),
            pageTitleEnricher: createLocalPageTitleEnricher({ timeoutMs: 10_000, maxBodyBytes: 1_024, concurrency: 1,
                successTtlMs: 30_000, failureTtlMs: 5_000, fetch: async () => {
                    enterHttp(); await httpRead;
                    return new Response('<title>Service</title>', { headers: { 'content-type': 'text/html' } });
                } }),
        });
        let fullSettled = false;
        let nativeSnapshot: NormalizedLocalServiceInventorySnapshot | undefined;
        const full = runtime.refreshInventoryNow().then(snapshot => { fullSettled = true; return snapshot; });
        try {
            const native = runtime.refreshInventoryNow({ stage: 'native' }).then(snapshot => { nativeSnapshot = snapshot; return snapshot; });
            visitors = 1;
            releaseWorkspace();
            await httpEntered;
            expect(nativeSnapshot?.entries[0]?.establishedConnections).toBe(1);
            expect(fullSettled).toBe(false);
            expect(runtime.inventoryRegistry.getSnapshot().entries).toHaveLength(0);
            expect(scans).toBe(1);
            visitors = 2;
            const later = runtime.refreshInventoryNow({ stage: 'native' });
            releaseHttp();
            expect((await full).entries[0]).toMatchObject({ establishedConnections: 1, presentation: { pageTitle: 'Service' } });
            expect((await native).entries[0]?.establishedConnections).toBe(1);
            expect((await later).entries[0]?.establishedConnections).toBe(2);
            expect(scans).toBe(2);
        } finally {
            releaseWorkspace(); releaseHttp();
            await full;
            await runtime.stop();
        }
    });

    it('rejects a failed native refresh and admits a later fresh owner read', async () => {
        let fail = true;
        const errors: unknown[] = [];
        const unavailable = new Error('Native socket scan unavailable');
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, onError: error => { errors.push(error); },
            scan: async () => {
                if (fail) throw unavailable;
                return { listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', establishedConnections: 1 }],
                    processes: new Map(), workspaces: [], diagnostics: [] };
            },
        });
        try {
            const full = runtime.refreshInventoryNow();
            void full.catch(() => undefined);
            const native = runtime.refreshInventoryNow({ stage: 'native' });
            await expect(native).rejects.toBe(unavailable);
            await expect(full).rejects.toBe(unavailable);
            fail = false;
            expect((await runtime.refreshInventoryNow({ stage: 'native' })).entries[0]?.establishedConnections).toBe(1);
            expect(errors).toContain(unavailable);
        } finally { await runtime.stop(); }
    });

    it('admits a fresh native successor after the prior presentation probe aborts', async () => {
        const cancellation = new AbortController();
        const errors: unknown[] = [];
        let enterProbe!: () => void;
        let releaseProbe!: () => void;
        const probeEntered = new Promise<void>(resolve => { enterProbe = resolve; });
        const probeRead = new Promise<void>(resolve => { releaseProbe = resolve; });
        let visitors = 0;
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine-a', startLoop: false,
            inventoryEnabled: () => true, onError: error => { errors.push(error); },
            scan: async () => ({ listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', establishedConnections: visitors }],
                processes: new Map(), workspaces: [], diagnostics: [] }),
            endpointEnricher: createLocalServiceEndpointEnricher({ now: () => 2_000, timeoutMs: 250, concurrency: 1,
                successTtlMs: 30_000, failureTtlMs: 5_000, signal: cancellation.signal, probe: async ({ signal }) => {
                    enterProbe(); await probeRead; signal?.throwIfAborted(); return true;
                } }),
        });
        try {
            const native = runtime.refreshInventoryNow({ stage: 'native' });
            const full = runtime.refreshInventoryNow();
            void full.catch(() => undefined);
            expect((await native).entries[0]?.establishedConnections).toBe(0);
            await probeEntered;
            visitors = 1;
            const successor = runtime.refreshInventoryNow({ stage: 'native' });
            const aborted = new Error('HTTP presentation aborted');
            cancellation.abort(aborted);
            releaseProbe();
            await expect(full).rejects.toBe(aborted);
            expect((await successor).entries[0]?.establishedConnections).toBe(1);
            expect(errors).toContain(aborted);
        } finally { releaseProbe(); await runtime.stop(); }
    });

    it('preserves accepted workspace identity over scanner context while normalizing provenance', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'npm run dev -- --token raw-secret', cwd: '/repo/app' }],
                ]),
                workspaces: [{ path: '/repo' }],
                diagnostics: [],
            }),
            workspaceFacts: () => [{ id: 'accepted-workspace', path: '/repo' }],
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.entries[0]).toMatchObject({
            workspaceAssociationConfidence: 'high',
            provenance: {
                workspace: {
                    id: 'accepted-workspace',
                    path: '/repo',
                    association: 'cwd_containment',
                },
            },
        });
        expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('raw-secret');
    });

    it('enriches listening local services with bounded page-title presentation without changing identity', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            pageTitleEnricher: {
                fetchTitle: async (url) => {
                    expect(url).toBe('http://127.0.0.1:5173/');
                    return { title: 'Local Vite App', source: 'html_title' };
                },
            },
            endpointEnricher: createLocalServiceEndpointEnricher({
                now: () => 2_000, timeoutMs: 250, concurrency: 1,
                successTtlMs: 30_000, failureTtlMs: 5_000,
                probe: async ({ scheme }) => scheme === 'http',
            }),
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            id: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-unknown',
            presentation: {
                displayName: 'Vite',
                pageTitle: 'Local Vite App',
                pageTitleSource: 'html_title',
                addressLabel: 'localhost:5173',
            },
        });
    });

    it('owns one registered preview registry and exposes it as a snapshot route', async () => {
        const server = previewServerBoundary();
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            accountId: 'account-a', previewServer: server.input,
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 4_000,
            startLoop: false,
        });

        expect(runtime.previewRegistry).toBeTruthy();
        expect(runtime.previewRoutes).toBeTruthy();

        registerLocalServicePreview(runtime.previewRegistry, {
            previewId: 'preview-b',
            sessionId: 'session-b',
            machineId: 'machine-a',
            owner: { kind: 'agent', id: 'agent-b' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5174 },
            initialPath: { pathname: '/b', search: '' },
            display: { title: 'B', addressLabel: 'localhost:5174' },
            originMode: 'host',
        });
        registerLocalServicePreview(runtime.previewRegistry, {
            previewId: 'preview-a',
            sessionId: 'session-a',
            machineId: 'machine-a',
            owner: { kind: 'plugin', id: 'plugin-a' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '?v=1' },
            display: { title: 'A', addressLabel: 'localhost:5173' },
            originMode: 'host',
        });

        await expect(runtime.previewRoutes.getSnapshot()).resolves.toMatchObject({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 4_000,
            refreshState: 'idle',
            resources: [
                { previewId: 'preview-a' },
                { previewId: 'preview-b' },
            ],
            diagnostics: [],
        });
    });

    it('activates hosted-web static asset previews through the daemon-owned preview registry', async () => {
        const server = previewServerBoundary();
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            accountId: 'account-a', previewServer: server.input,
            inventoryEnabled: () => false,
            now: () => 5_000,
            startLoop: false,
            hostedWebStaticAssets: {
                verifyArtifact: () => ({ ok: true }),
                startServer: async (input) => {
                    const previewId = buildPluginHostedWebStaticAssetPreviewId(input.preview);
                    const previewResource = {
                        previewId,
                        sessionId: input.preview.sessionId,
                        machineId: input.preview.machineId,
                        owner: { kind: 'plugin' as const, id: input.preview.pluginId },
                        target: { scheme: 'http' as const, host: '127.0.0.1', port: 51515 },
                        initialPath: { pathname: '/', search: '' },
                        display: { title: input.preview.title, addressLabel: '127.0.0.1:51515' },
                        originMode: 'host' as const,
                    };
                    return {
                        baseUrl: 'http://127.0.0.1:51515',
                        endpoint: { scheme: 'http', host: '127.0.0.1', port: 51515 },
                        previewResource,
                        previewRegistration: await input.registerPreview?.(previewResource),
                        stop: async () => {
                            await input.unregisterPreview?.(previewId);
                        },
                    };
                },
            },
        });

        const contributions: Parameters<typeof runtime.syncHostedWebStaticAssets>[0] = [{
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            machineId: 'machine-a',
            title: 'Preview web',
            installedRoot: '/plugin/root/dist/happier-plugin-ui',
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web',
                assetRootId: 'hosted-web/preview-web',
            },
            artifactManifest: {
                version: 2,
                entries: [{
                    artifactId: 'preview-web',
                    tier: 'hostedWeb',
                    entry: 'hosted-web/preview-web/index.html',
                    files: [{
                        relativePath: 'hosted-web/preview-web/index.html',
                        digest: `sha256:${'b'.repeat(64)}`,
                        byteSize: 1,
                    }],
                    digest: `sha256:${'a'.repeat(64)}`,
                    builtWith: { staging: 'staticDirectory' },
                    hostUiApiRange: '^1.0.0',
                }],
            },
            security: {
                allowedNavigationOrigins: [],
                allowedCallbackOrigins: [],
                allowedConnectOrigins: [],
                csp: {
                    connectSrc: 'selfOnly',
                    allowDataUrls: false,
                    allowBlobUrls: false,
                    allowInlineStyles: false,
                    allowEval: false,
                },
                sourceMaps: 'disabled',
                mixedContent: 'deny',
            },
        }];

        const result = await runtime.syncHostedWebStaticAssets(contributions);
        expect(result).toMatchObject({ active: [expect.anything()], diagnostics: [] });
        // Explicit activation publishes the registration; observing a snapshot is read-only.
        expect(server.registrations.size).toBe(1);
        expect([...runtime.previewRegistry.previewsById.values()][0]?.accessUrl).toBe('https://preview.example.test/');
        expect(await runtime.syncHostedWebStaticAssets([])).toMatchObject({ active: [], diagnostics: [] });
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);
        expect(await runtime.syncHostedWebStaticAssets(contributions)).toMatchObject({ active: [expect.anything()], diagnostics: [] });
        await runtime.previewRoutes.getSnapshot();
        expect(server.registrations.size).toBe(1);
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([
            expect.objectContaining({
                previewId: 'plugin-static:acme.preview:preview-web:session-a:machine-a',
                sessionId: 'session-a',
                owner: { kind: 'plugin', id: 'acme.preview' },
            }),
        ]);

        await runtime.syncHostedWebStaticAssets([]);
        const publish = server.input.http.post;
        server.input.http.post = async () => { throw new Error('Preview server unavailable'); };
        expect(await runtime.syncHostedWebStaticAssets(contributions)).toMatchObject({
            active: [], diagnostics: [{ code: 'static_asset_server_start_failed' }],
        });
        expect((await runtime.previewRoutes.getSnapshot()).previews).toEqual([
            expect.objectContaining({ accessUrl: null, diagnostics: [expect.objectContaining({ code: 'preview_registration_failed' })] }),
        ]);
        server.input.http.post = publish;
        expect(await runtime.syncHostedWebStaticAssets(contributions)).toMatchObject({ active: [expect.anything()], diagnostics: [] });

        await runtime.stop();
        await expect(runtime.stopHostedWebStaticAssets()).resolves.toBeUndefined();
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);
        expect(server.registrations.size).toBe(0);
    });

    it('scans only while an inventory watch is parked, and serves an unwatched reader on demand', async () => {
        vi.useFakeTimers();
        try {
            const scan = vi.fn(async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [],
            }));
            let clock = 10_000;
            const runtime = createLocalServicesDaemonRuntime({
                machineId: 'machine-a',
                inventoryEnabled: () => true,
                scan,
                now: () => clock,
                refreshIntervalMs: 1_000,
            });

            // Nobody is watching: the machine-wide scan plus its TLS/HEAD probes stay off
            // (tunnels audit 4.6 — this used to run unconditionally for a consumer that never
            // subscribed).
            await vi.advanceTimersByTimeAsync(5_000);
            expect(scan).not.toHaveBeenCalled();

            const parked = runtime.inventoryRoutes.watchSnapshot({ sinceGeneratedAt: 0 });
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(scan.mock.calls.length).toBeGreaterThanOrEqual(1);

            // The fresh initial scan closes the read/watch gap and leaves no parked demand.
            expect((await parked).changed).toBe(true);
            const scansWhileWatched = scan.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5_000);
            expect(scan.mock.calls.length).toBe(scansWhileWatched);

            // A reader with no watch (an agent, or the launcher feed) still gets fresh data.
            clock += 60_000;
            await runtime.inventoryRoutes.getSnapshot();
            expect(scan.mock.calls.length).toBe(scansWhileWatched + 1);

            await runtime.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
