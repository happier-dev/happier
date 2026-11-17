import { describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import { createLocalServicePreviewRoutes as createRoutes } from './routes';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { createLocalServicePreviewRegistry, previewIdForInventoryEntry, registerLocalServicePreview, resolveLocalServicePreviewApplication } from './registry';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { LocalServicePreviewServerInput } from './serverRoutes';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { logger } from '@/ui/logger';
import { spawn } from 'node:child_process';
import { readProcessCensus } from '@/processes/census/processCensus';
import * as processCensusBoundary from '@/processes/census/processCensus';
import { createDeferred } from '@/testkit/async/deferred';
import { localServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { startLocalServicePreviewNativeAdapter } from './nativeAdapter';
import { createLocalServiceEndpointEnricher } from '../inventory/endpoint';
import { registerDaemonLocalServicePreviewSnapshotHandler } from '@/rpc/handlers/daemonLocalServicePreviewSnapshot';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { normalizeLocalServiceScan } from '../inventory/scanner';
import { parseLocalServiceDeclarationPreviewLandingUrlV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { projectWorktreeRuntimeEnvironment } from '@/workspaces/execution/projectWorktreeRuntime';
import { createLocalServiceLauncherFeed } from '../launch/feed';
import { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } from '../../../../../../ui/sources/sync/domains/browser/targets/suggestions';

const MACHINE_ID = 'machine-a';

function createLocalServicePreviewRoutes(
    input: Parameters<typeof createRoutes>[0],
    deletePreview?: NonNullable<LocalServicePreviewServerInput['http']>['delete'],
) {
    let admission = 0;
    // HTTP is the genuine server boundary; inventory, registry and route logic remain real.
    return createRoutes({
        ...input,
        accountId: 'account-1',
        server: {
            token: 'daemon-token',
            serverBaseUrl: 'https://home.example.test',
            http: {
                async post(_url: string, body: unknown) {
                    const resource = body as LocalServicePreviewResourceV1;
                    const url = new URL(`https://${resource.previewId}.preview.example.test${resource.initialPath.pathname}${resource.initialPath.search}`);
                    url.searchParams.set('previewToken', `admission-${++admission}`);
                    return { data: { resource, accessUrl: url.toString(), expiresAt: 61_000 } };
                },
                delete: deletePreview ?? (async () => ({ data: { ok: true } })),
            },
        },
    });
}

function inventoryEntry(overrides: Partial<NormalizedLocalServiceInventoryEntry> = {}): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-vite',
        machineId: MACHINE_ID,
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        endpoint: {
            scheme: 'http',
            host: '127.0.0.1',
            port: 5173,
            probeState: 'ready',
            probedAt: 2_000,
        },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        presentation: { addressLabel: 'localhost:5173', displayName: 'Vite' },
        ...overrides,
    };
}

function inventoryRegistryWith(entries: readonly NormalizedLocalServiceInventoryEntry[]) {
    const registry = createLocalServiceInventoryRegistry();
    registry.replaceSnapshot({
        v: 1,
        machineId: MACHINE_ID,
        generatedAt: 1_000,
        refreshState: 'idle',
        entries,
        diagnostics: [],
    });
    return registry;
}

describe('createLocalServicePreviewRoutes lifecycle', () => {
    it.each([
        { response: 'success', change: 'revoke' },
        { response: 'failure', change: 'revoke' },
        { response: 'success', change: 'replacement' },
        { response: 'failure', change: 'replacement' },
    ] as const)('does not resurrect or overwrite a registration after delayed $response races $change', async ({ response, change }) => {
        const original = createServer((_req, res) => res.end('RACED_A'));
        await new Promise<void>(resolve => original.listen(0, '127.0.0.1', resolve));
        const address = original.address();
        if (!address || typeof address === 'string') throw new Error('missing owned fixture');
        let replacementReads = 0;
        const replacement = createServer((_req, res) => { replacementReads += 1; res.end('REPLACEMENT_B'); });
        let adapter: Awaited<ReturnType<typeof startLocalServicePreviewNativeAdapter>> | undefined;
        const registrationStarted = createDeferred();
        const registrationReply = createDeferred<Readonly<{ data: unknown }>>();
        try {
            const registry = createLocalServicePreviewRegistry();
            const registered = registerLocalServicePreview(registry, {
                previewId: 'raced-preview', machineId: MACHINE_ID, owner: { kind: 'user', id: 'account-1' },
                target: { scheme: 'http', host: '127.0.0.1', port: address.port },
                initialPath: { pathname: '/', search: '' }, display: { title: 'A', addressLabel: 'owned fixture' }, originMode: 'host',
            }, { isCurrent: () => original.listening });
            if (!registered.ok) throw new Error(registered.reasonCode);
            const resource = registered.resource;
            const binding = localServicePreviewDirectBindingV1(resource);
            const routes = createRoutes({ machineId: MACHINE_ID, accountId: 'account-1', registry,
                server: { token: 'fixture-token', serverBaseUrl: 'https://home.example.test', http: {
                    async post() { registrationStarted.resolve(); return registrationReply.promise; },
                    async delete() { return { data: { ok: true } }; },
                } },
            });
            adapter = await startLocalServicePreviewNativeAdapter({ preview: resource, signal: new AbortController().signal,
                resolvePreview: () => routes.resolveApplication(binding) });
            const pending = routes.openOrCreate({ machineId: MACHINE_ID, launchTargetId: resource.previewId });
            await registrationStarted.promise;
            if (change === 'revoke') {
                expect(await routes.revoke({ machineId: MACHINE_ID, previewId: resource.previewId }))
                    .toMatchObject({ ok: true, response: { revoked: true } });
            } else {
                expect(registerLocalServicePreview(registry, { ...resource, sessionId: 'replacement-session',
                    owner: { kind: 'session', id: 'replacement-session' }, display: { title: 'B', addressLabel: 'owned replacement' } },
                { isCurrent: () => replacement.listening }).ok).toBe(true);
            }
            const afterChange = registry.previewsById.get(resource.previewId);
            await new Promise<void>(resolve => original.close(() => resolve()));
            await new Promise<void>(resolve => replacement.listen(address.port, '127.0.0.1', resolve));
            if (response === 'success') registrationReply.resolve({ data: {
                resource, accessUrl: 'https://preview.example.test/', expiresAt: 61_000,
            } });
            else registrationReply.reject(new Error('server registration failed'));
            expect.soft(await pending).toEqual({ ok: false, reasonCode: 'preview_target_unresolved' });
            expect.soft(registry.previewsById.get(resource.previewId)).toBe(afterChange);
            const refused = await fetch(`http://127.0.0.1:${adapter.port}/`, { headers: { connection: 'close' } });
            expect(await refused.text()).not.toContain('REPLACEMENT_B');
            expect(refused.status).toBe(404);
            expect(replacementReads).toBe(0);
            await expect(routes.resolveApplication(binding)).rejects.toMatchObject({ reasonCode: 'preview_not_found' });
            await expect(routes.acquireNativeApplication(binding, 'retained-grant')).rejects.toMatchObject({ reasonCode: 'preview_not_found' });
        } finally {
            registrationReply.reject(new Error('fixture cleanup'));
            await adapter?.close();
            original.closeAllConnections();
            await new Promise<void>(resolve => original.close(() => resolve()));
            replacement.closeAllConnections();
            await new Promise<void>(resolve => replacement.close(() => resolve()));
        }
    });
    it('reopens a stable declaration locator while refusing retained bytes after its exact resource ends', async () => {
        const original = createServer((_request, response) => response.end('PLUGIN_A_BYTES'));
        await new Promise<void>(resolve => original.listen(0, '127.0.0.1', resolve));
        const address = original.address();
        if (!address || typeof address === 'string') throw new Error('missing native fixture address');
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const workspace = { id: 'checkout', serverId: 'home', machineId: MACHINE_ID, rootPath: process.cwd(), createdAtMs: 1 };
        const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'web' } };
        let adapter: Awaited<ReturnType<typeof startLocalServicePreviewNativeAdapter>> | undefined;
        let reopenedAdapter: Awaited<ReturnType<typeof startLocalServicePreviewNativeAdapter>> | undefined;
        let replacement: ReturnType<typeof createServer> | undefined;
        let inspectionUnavailable = false;
        try {
            const environment = projectWorktreeRuntimeEnvironment({ workspace,
                manifest: { version: 1, worktreePorts: { enabled: true, slots: 1 }, services: {
                    web: { source: { kind: 'command', command: 'serve' }, runtime: { primary: true } },
                } }, assignment: { ports: [address.port], listenerPorts: {} } });
            const locator = parseLocalServiceDeclarationPreviewLandingUrlV1(environment.HAPPIER_WORKTREE_URL!);
            expect(locator).toEqual({ serverId: workspace.serverId, machineId: workspace.machineId, targetId: expect.any(String) });
            if (!locator) throw new Error('missing stable worktree locator');
            const launchTargetId = locator.targetId;
            // The external program's native lifecycle is the SDK system boundary.
            // Host supervision, preview registration and HTTP adapters remain real.
            const start = (nativeResourceId: string, resource: typeof original) => owner.superviseProject({ kind: 'workspace', workspace, declaration, cwd: workspace.rootPath,
                serviceId: launchTargetId, specIdentity: 'web', isCurrent: () => true,
                requester: { serverId: 'home', accountId: 'account-1', machineId: MACHINE_ID, installationId: 'installation' },
                processSpec: { mode: { kind: 'native',
                    instance: { adapter: { pluginId: 'external.fixture', localId: 'web' }, nativeResourceId },
                    lifecycle: { inspect: async () => {
                        if (inspectionUnavailable) throw new Error('native observation unavailable');
                        return { phase: resource.listening ? 'running' : 'stopped', readiness: 'ready', endpoint: `http://127.0.0.1:${address.port}` };
                    },
                        stop: async () => ({ status: 'stopped' }) } } },
                authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', ''], env: {}, release: async () => undefined }),
            });
            const handle = await start('exact-A', original);
            const routes = createLocalServicePreviewRoutes({ machineId: MACHINE_ID, registry: createLocalServicePreviewRegistry(), projectManagedServices: owner });
            const opened = await routes.openOrCreate({ machineId: MACHINE_ID, launchTargetId });
            if (!opened.ok) throw new Error(opened.reasonCode);
            const preview = opened.response.preview.resource;
            adapter = await startLocalServicePreviewNativeAdapter({ preview, signal: new AbortController().signal,
                resolvePreview: () => routes.resolveApplication(localServicePreviewDirectBindingV1(preview)) });
            const read = () => fetch(`http://127.0.0.1:${adapter!.port}/`, { headers: { connection: 'close' } });
            expect(await (await read()).text()).toBe('PLUGIN_A_BYTES');
            inspectionUnavailable = true;
            const unavailable = await read();
            expect(unavailable.status).toBe(503);
            await unavailable.arrayBuffer();
            inspectionUnavailable = false;
            expect(await (await read()).text()).toBe('PLUGIN_A_BYTES');
            original.closeAllConnections();
            await new Promise<void>(resolve => original.close(() => resolve()));
            let replacementReads = 0;
            replacement = createServer((_request, response) => { replacementReads += 1; response.end('PLUGIN_B_BYTES'); });
            await new Promise<void>(resolve => replacement!.listen(address.port, '127.0.0.1', resolve));
            const retained = await read();
            expect(retained.status).toBe(404);
            expect(await retained.json()).toMatchObject({ reasonCode: 'preview_not_found' });
            expect(replacementReads).toBe(0);
            // A declared Service may be started and explicitly reopened as a new
            // managed occurrence. That must not revive the retained A view.
            await handle.stop(); // The existing restart path first settles the old starter's custody.
            const restarted = await start('exact-B', replacement);
            expect(await routes.openOrCreate({ machineId: MACHINE_ID, serviceTarget: preview.serviceTarget! }))
                .toMatchObject({ ok: false, reasonCode: 'stale_service' });
            const reopened = await routes.openOrCreate({ machineId: MACHINE_ID, launchTargetId });
            if (!reopened.ok) throw new Error(reopened.reasonCode);
            const newPreview = reopened.response.preview.resource;
            expect(newPreview.previewId).not.toBe(preview.previewId);
            reopenedAdapter = await startLocalServicePreviewNativeAdapter({ preview: newPreview, signal: new AbortController().signal,
                resolvePreview: () => routes.resolveApplication(localServicePreviewDirectBindingV1(newPreview)) });
            expect(await (await fetch(`http://127.0.0.1:${reopenedAdapter.port}/`, { headers: { connection: 'close' } })).text()).toBe('PLUGIN_B_BYTES');
            expect((await read()).status).toBe(404);
            expect(replacementReads).toBe(1);
        } finally {
            await adapter?.close();
            await reopenedAdapter?.close();
            await owner.dispose();
            original.closeAllConnections();
            await new Promise<void>(resolve => original.close(() => resolve()));
            replacement?.closeAllConnections();
            if (replacement) await new Promise<void>(resolve => replacement!.close(() => resolve()));
        }
    });
    it('keeps a real child preview through an origin outage, Forget, stale evidence, Undo and Open, but refuses exit and port takeover', async () => {
        // Real OS/process and HTTP boundaries: no scan refresh, revoke or fake lifecycle owner.
        const child = spawn(process.execPath, ['-e', `
            const http = require('node:http');
            const server = http.createServer((_req, res) => {
                res.setHeader('x-happier-preview-transport-unavailable', '1');
                res.end('EXACT_A_BYTES');
            });
            let port;
            server.listen(0, '127.0.0.1', () => { port = server.address().port; process.send(port); });
            process.on('message', command => {
                if (command === 'pause') server.close(() => process.send('paused'));
                else if (command === 'resume') server.listen(port, '127.0.0.1', () => process.send('resumed'));
                else server.close(() => process.exit(0));
            });
        `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let adapter: Awaited<ReturnType<typeof startLocalServicePreviewNativeAdapter>> | undefined;
        let replacement: ReturnType<typeof createServer> | undefined;
        try {
            const [port] = await once(child, 'message') as [number];
            const census = await readProcessCensus({ freshness: 'fresh', scope: 'all', pids: [child.pid!], fields: [], includeAncestors: false });
            if (census.status !== 'ok') throw new Error('process census unavailable');
            const processStartTimeMs = census.rows.find(row => row.pid === child.pid)?.start.startTimeMs;
            if (processStartTimeMs === undefined) throw new Error('child identity unavailable');
            const scanned = normalizeLocalServiceScan({ machineId: MACHINE_ID, now: Date.now(), previous: null,
                workspaces: [], ownership: [], listeners: [{ address: '127.0.0.1', port, protocol: 'tcp', pid: child.pid }],
                processes: new Map([[child.pid!, { pid: child.pid!, processStartTimeMs, command: 'fixture' }]]) });
            const original = { ...scanned.entries[0]!, endpoint: { scheme: 'http' as const, host: '127.0.0.1', port, probeState: 'ready' as const, probedAt: Date.now() } };
            const registry = createLocalServicePreviewRegistry();
            const inventory = inventoryRegistryWith([original]);
            const routes = createLocalServicePreviewRoutes({ machineId: MACHINE_ID, registry, inventoryRegistry: inventory });
            const opened = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: original.id, sessionId: 'session-a' });
            if (!opened.ok) throw new Error(opened.reasonCode);
            const preview = opened.response.preview.resource;
            adapter = await startLocalServicePreviewNativeAdapter({ preview, signal: new AbortController().signal,
                resolvePreview: () => routes.resolveApplication(localServicePreviewDirectBindingV1(preview)) });
            const read = () => fetch(`http://127.0.0.1:${adapter!.port}/`, { headers: { connection: 'close' } });
            const initialResponse = await read();
            expect(initialResponse.headers.has('x-happier-preview-transport-unavailable')).toBe(false);
            expect(await initialResponse.text()).toBe('EXACT_A_BYTES');
            const paused = once(child, 'message');
            child.send('pause');
            await paused;
            const unreachable = await read();
            expect.soft(unreachable.status).toBe(503);
            expect.soft(unreachable.headers.get('x-happier-preview-transport-unavailable')).toBe('1');
            expect.soft(await unreachable.json()).toMatchObject({ error: 'preview_transport_unavailable' });
            expect.soft(registry.previewsById.get(preview.previewId)?.occurrence?.ended).not.toBe(true);
            expect.soft((await routes.getSnapshot()).resources.some(row => row.previewId === preview.previewId)).toBe(true);
            const resumed = once(child, 'message');
            child.send('resume');
            await resumed;
            expect(await (await read()).text()).toBe('EXACT_A_BYTES');
            const forgotten = inventory.forgetEntry({ inventoryId: original.id, updatedAt: Date.now() });
            if (!forgotten.ok) throw new Error(forgotten.reason);
            expect(inventory.getSnapshot().entries).toHaveLength(0);
            const forgottenReload = await read();
            expect(await forgottenReload.text()).toBe('EXACT_A_BYTES');
            expect(forgottenReload.status).toBe(200);
            expect(inventory.undoForget(forgotten.undoKey).ok).toBe(true);
            const reopened = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: original.id, sessionId: 'session-a' });
            expect(reopened).toMatchObject({ ok: true, response: { status: 'existing', preview: { previewId: preview.previewId } } });
            // Use the scanner's real missing-listener transition: stale and then gone.
            // Neither presentation deadline contradicts fresh exact native evidence.
            const missingScanInput = { machineId: MACHINE_ID, workspaces: [], ownership: [], listeners: [], processes: new Map(), staleAfterMs: 1_000 };
            const stale = normalizeLocalServiceScan({ ...missingScanInput, now: original.lastSeenAt + 1_000,
                previous: { ...scanned, entries: [original] } });
            expect(stale.entries[0]?.state).toBe('stale');
            inventory.replaceSnapshot(stale);
            expect(await (await read()).text()).toBe('EXACT_A_BYTES');
            const gone = normalizeLocalServiceScan({ ...missingScanInput, now: original.lastSeenAt + 2_000, previous: stale });
            expect(gone.entries[0]?.state).toBe('gone');
            inventory.replaceSnapshot(gone);
            expect(await (await read()).text()).toBe('EXACT_A_BYTES');
            inventory.replaceSnapshot({ ...inventory.getSnapshot(), refreshState: 'error' });
            expect(await (await read()).text()).toBe('EXACT_A_BYTES');
            const unavailable = vi.spyOn(processCensusBoundary, 'readProcessCensus')
                .mockRejectedValueOnce(new Error('native observation unavailable'));
            try {
                const refused = await read();
                await refused.arrayBuffer();
                expect(refused.status).toBe(503);
                expect(registry.previewsById.get(preview.previewId)?.occurrence?.ended).not.toBe(true);
            } finally { unavailable.mockRestore(); }
            expect(await (await read()).text()).toBe('EXACT_A_BYTES');
            inventory.replaceSnapshot({ ...scanned, entries: [original] });
            const exited = once(child, 'exit');
            child.send('stop');
            await exited;
            let replacementReads = 0;
            replacement = createServer((_req, res) => { replacementReads += 1; res.end('EXACT_B_BYTES'); });
            await new Promise<void>(resolve => replacement!.listen(port, '127.0.0.1', resolve));
            const retained = await read();
            const body = await retained.text();
            expect(body).not.toContain('EXACT_B_BYTES');
            expect(retained.status).toBe(404);
            expect(JSON.parse(body)).toMatchObject({ error: 'preview_not_found', reasonCode: 'preview_not_found' });
            expect(replacementReads).toBe(0);
        } finally {
            await adapter?.close();
            replacement?.closeAllConnections();
            if (replacement) await new Promise<void>(resolve => replacement!.close(() => resolve()));
            if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('stop'); await exited; }
        }
    });
    it.each([
        { replacement: 'another process', pid: 202, processStartTimeMs: 1_000 },
        { replacement: 'a reused PID', pid: 101, processStartTimeMs: 1_500 },
    ])('does not lend a retained preview or Open again to $replacement on the same port', async ({ pid, processStartTimeMs }) => {
        const scan = (processId: number, startedAt: number) => normalizeLocalServiceScan({
            machineId: MACHINE_ID, now: 2_000, previous: null, workspaces: [], ownership: [],
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: processId }],
            processes: new Map([[processId, { pid: processId, processStartTimeMs: startedAt, command: 'node vite' }]]),
        });
        const originalScan = scan(101, 1_000);
        const original = { ...originalScan.entries[0]!, endpoint: inventoryEntry().endpoint };
        const inventory = inventoryRegistryWith([original]);
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({ machineId: MACHINE_ID, registry, inventoryRegistry: inventory });
        const handlers = new Map<string, (payload: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
        registerDaemonLocalServicePreviewSnapshotHandler({ registerHandler(method, handler) {
            // RPC transport only; the production parser, route and publication owners stay real.
            handlers.set(method, handler as (payload: unknown, context?: RpcHandlerContext) => Promise<unknown>);
        } }, { localServicesPreview: routes });
        const open = handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE)!;
        await open({ machineId: MACHINE_ID, inventoryEntryId: original.id, sessionId: 'session-1' });
        const ended = (await routes.getSnapshot()).resources[0]!.browserTarget!;
        const feed = createLocalServiceLauncherFeed({ machineId: MACHINE_ID, accountId: 'account-1',
            inventoryRegistry: inventory, previewRegistry: registry });
        const before = buildBrowserLaunchpadRows({ launcherSnapshot: await feed.getSnapshot({ scope: 'machine' }) });
        expect(selectRunningServiceForEndedPreview(before, ended)).not.toBeNull();

        // Stop A without revoking, then observe an unrelated occurrence B on the same endpoint.
        inventory.replaceSnapshot({ ...originalScan, entries: [] });
        expect(selectRunningServiceForEndedPreview(buildBrowserLaunchpadRows({
            launcherSnapshot: await feed.getSnapshot({ scope: 'machine' }),
        }), ended)).toBeNull();
        const replacementScan = scan(pid, processStartTimeMs);
        const replacement = { ...replacementScan.entries[0]!, endpoint: original.endpoint };
        expect(replacement.id).not.toBe(original.id);
        inventory.replaceSnapshot({ ...replacementScan, entries: [replacement] });
        const launcher = await feed.getSnapshot({ scope: 'machine' });
        expect.soft(launcher.targets[0]?.browserTarget).toBeUndefined();
        expect.soft(selectRunningServiceForEndedPreview(buildBrowserLaunchpadRows({ launcherSnapshot: launcher }), ended)).toBeNull();
        expect.soft(await open({ machineId: MACHINE_ID, inventoryEntryId: replacement.id })).toMatchObject({ status: 'created' });
        const resources = (await routes.getSnapshot()).resources;
        expect.soft(resources).toHaveLength(2);
        expect.soft(new Set(resources.map(resource => resource.previewId)).size).toBe(2);
        expect(selectRunningServiceForEndedPreview(buildBrowserLaunchpadRows({
            launcherSnapshot: await feed.getSnapshot({ scope: 'machine' }),
        }), ended)).toBeNull();
    });

    it('registers an observed Project endpoint through the existing preview owner and refuses retired exact custody', async () => {
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Project literal launch cannot reach plugin dependency installation.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const workspace = { id: 'checkout', serverId: 'home', machineId: MACHINE_ID, rootPath: process.cwd(), createdAtMs: 1 };
        const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'web' } };
        let stopped = false;
        let finishStop!: () => void;
        let enteredStop!: () => void;
        const stopEntered = new Promise<void>(resolve => { enteredStop = resolve; });
        const stopPending = new Promise<void>(resolve => { finishStop = resolve; });
        const handle = await owner.superviseProject({ kind: 'workspace', workspace, declaration, cwd: workspace.rootPath,
            serviceId: 'web', specIdentity: 'web', isCurrent: () => true,
            requester: { serverId: 'home', accountId: 'account-1', machineId: MACHINE_ID, installationId: 'installation' },
            processSpec: { mode: { kind: 'native',
                instance: { adapter: { pluginId: 'fixture.plugin', localId: 'web' }, nativeResourceId: 'exact-web' },
                lifecycle: { inspect: async () => ({ phase: stopped ? 'stopped' : 'running', readiness: 'ready', endpoint: 'http://127.0.0.1:4312' }),
                    stop: async () => { enteredStop(); await stopPending; stopped = true; return { status: 'stopped' }; } } } },
            authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, release: async () => undefined }),
        });
        const serviceTarget = { kind: 'managed_service' as const, machineId: MACHINE_ID, managedServiceId: handle.instanceId,
            workspaceId: workspace.id, declaration, cwd: workspace.rootPath };
        try {
            const registry = createLocalServicePreviewRegistry();
            const routes = createLocalServicePreviewRoutes({ machineId: MACHINE_ID, registry, projectManagedServices: owner });
            const handlers = new Map<string, (payload: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
            const registrar: RpcHandlerRegistrar = {
                registerHandler(method, handler) {
                    // Genuine RPC transport boundary; the registered parser and route stay real.
                    handlers.set(method, handler as (payload: unknown, context?: RpcHandlerContext) => Promise<unknown>);
                },
            };
            registerDaemonLocalServicePreviewSnapshotHandler(registrar, { localServicesPreview: routes });
            const open = handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE);
            if (!open) throw new Error('Expected preview RPC registration');
            expect(await routes.openOrCreate({ machineId: MACHINE_ID, serviceTarget: { ...serviceTarget, cwd: `${workspace.rootPath}/other` } }))
                .toEqual({ ok: false, reasonCode: 'preview_target_unresolved' });
            const result = await open({ machineId: MACHINE_ID, serviceTarget });
            expect(result).toMatchObject({ status: 'created', preview: { resource: {
                serviceTarget, owner: { kind: 'user', id: 'account-1' }, target: { scheme: 'http', host: '127.0.0.1', port: 4312 },
            }, accessUrl: expect.stringContaining('previewToken=admission-') } });
            // Both selectors resolve to the same retained Service. Optional request
            // qualifiers must not change its server registration binding.
            const unqualifiedServiceTarget = { kind: 'managed_service' as const, machineId: MACHINE_ID,
                managedServiceId: handle.instanceId, declaration, cwd: workspace.rootPath };
            expect.soft(await open({ machineId: MACHINE_ID, serviceTarget: unqualifiedServiceTarget }))
                .toMatchObject({ status: 'existing', preview: { resource: { serviceTarget } } });
            expect((await routes.getSnapshot()).resources).toHaveLength(1);
            const revoke = handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE);
            if (!revoke) throw new Error('Expected preview Revoke RPC registration');
            for (const mismatchedTarget of [undefined, { ...serviceTarget, cwd: `${workspace.rootPath}/other` },
                { ...serviceTarget, workspaceId: 'another-checkout' }]) {
                expect(await revoke({ machineId: MACHINE_ID, previewId: handle.instanceId,
                    ...(mismatchedTarget ? { serviceTarget: mismatchedTarget } : {}) }))
                    .toMatchObject({ ok: false, errorCode: 'preview_service_mismatch' });
                expect((await routes.getSnapshot()).resources).toHaveLength(1);
            }
            expect(await revoke({ machineId: MACHINE_ID, previewId: handle.instanceId, serviceTarget }))
                .toMatchObject({ previewId: handle.instanceId, revoked: true, snapshot: { resources: [], previews: [] } });
            expect(await open({ machineId: MACHINE_ID, serviceTarget })).toMatchObject({ status: 'created' });
            const stopping = handle.stop();
            await stopEntered;
            // Stop withdraws serving authority before native cleanup settles.
            // The exact instance still exists, so this is unresolved, not unknown.
            expect(await routes.openOrCreate({ machineId: MACHINE_ID, serviceTarget }))
                .toEqual({ ok: false, reasonCode: 'preview_target_unresolved' });
            await expect(open({ machineId: MACHINE_ID, serviceTarget })).resolves.toMatchObject({
                ok: false, errorCode: 'preview_target_unresolved',
                error: 'local_service_preview_lifecycle_refused:preview_target_unresolved',
            });
            finishStop();
            await stopping;
            expect(await routes.openOrCreate({ machineId: MACHINE_ID, serviceTarget }))
                .toEqual({ ok: false, reasonCode: 'unknown_managed_service' });
            await expect(open({ machineId: MACHINE_ID, serviceTarget })).resolves.toMatchObject({
                ok: false, errorCode: 'unknown_managed_service',
            });
            // Withdrawal consumes the retained binding even after its live handle
            // has retired; an omitted optional qualifier still selects that Service.
            expect(await revoke({ machineId: MACHINE_ID, previewId: handle.instanceId, serviceTarget: unqualifiedServiceTarget }))
                .toMatchObject({ previewId: handle.instanceId, revoked: true, snapshot: { resources: [], previews: [] } });
        } finally { finishStop(); await handle.stop(); await owner.dispose(); }
    });

    it('refuses foreign Machine actors before exposing or using the custodian HTTP credential', async () => {
        const registry = createLocalServicePreviewRegistry();
        registry.previewsById.set('private-preview', { previewId: 'private-preview', diagnostics: [],
            resource: { previewId: 'private-preview', machineId: MACHINE_ID, owner: { kind: 'user', id: 'account-1' },
                target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
                display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host' },
            accessUrl: 'https://private.example.test/?previewToken=custodian', expiresAt: 61_000 });
        let httpReached = false;
        const routes = createRoutes({ machineId: MACHINE_ID, accountId: 'account-1', registry, server: {
            token: 'custodian-token', http: { async post() { httpReached = true; throw new Error('unexpected credential use'); },
                async delete() { httpReached = true; return { data: { ok: true } }; } },
        } });
        const context: RpcHandlerContext = { signal: new AbortController().signal, machineAdmission: {
            actorAccountId: 'foreign-viewer', custodianAccountId: 'account-1', machineId: MACHINE_ID,
            installationId: 'installation-1', role: 'use', encryptionMode: 'plain' } };
        await expect(routes.getSnapshot(context)).rejects.toThrow('requester_credentials_unavailable');
        expect(await routes.openOrCreate({ machineId: MACHINE_ID, managedServiceId: 'private-preview' }, undefined, context))
            .toEqual({ ok: false, reasonCode: 'requester_credentials_unavailable' });
        expect(await routes.revoke({ machineId: MACHINE_ID, previewId: 'private-preview' }, context))
            .toEqual({ ok: false, reasonCode: 'requester_credentials_unavailable' });
        // The refusal keeps its closed cause privately and logs it once; the public result above is unchanged.
        const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const refused = await routes.revoke({ machineId: MACHINE_ID, previewId: 'private-preview' }, context);
        expect(readActionOutputDiagnostic(refused)).toMatchObject({ phase: 'service.preview.requester_credentials',
            failureCause: { errorClass: 'Error' } });
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0]![1]).toMatchObject({ phase: 'service.preview.requester_credentials' });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/custodian-token|previewToken/u);
        log.mockRestore();
        expect(httpReached).toBe(false);
        expect(registry.previewsById.has('private-preview')).toBe(true);
        const ownContext: RpcHandlerContext = { ...context,
            machineAdmission: { ...context.machineAdmission!, actorAccountId: 'account-1' },
            verifyMachineAdmissionCurrent: async () => true };
        expect((await routes.getSnapshot(ownContext)).previews?.[0]?.accessUrl).toContain('previewToken=custodian');
        // This context already belongs to the admitted finite read. The real
        // registered-RPC cost tests refuse the next request at its own admission.
        expect((await routes.getSnapshot({ ...ownContext, verifyMachineAdmissionCurrent: async () => false }))
            .previews?.[0]?.accessUrl).toContain('previewToken=custodian');
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(routes.getSnapshot({ ...ownContext, signal: cancelled.signal }))
            .rejects.toThrow('requester_credentials_unavailable');
    });
    it('admits publication once and refuses the next request after credential revocation', async () => {
        const registry = createLocalServicePreviewRegistry();
        const resource: LocalServicePreviewResourceV1 = { previewId: 'admitted-preview', machineId: MACHINE_ID,
            owner: { kind: 'user', id: 'account-1' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host' };
        expect(registerLocalServicePreview(registry, resource).ok).toBe(true);
        let current = true;
        const verifyMachineAdmissionCurrent = vi.fn(async () => current);
        const post = vi.fn(async () => {
            current = false;
            return { data: { resource, accessUrl: 'https://preview.example.test/', expiresAt: 61_000 } };
        });
        const routes = createRoutes({ machineId: MACHINE_ID, accountId: 'account-1', registry,
            server: { token: 'fixture-token', serverBaseUrl: 'https://home.example.test', http: { post,
                async delete() { return { data: { ok: true } }; } } } });
        const context: RpcHandlerContext = { signal: new AbortController().signal, verifyMachineAdmissionCurrent,
            machineAdmission: { actorAccountId: 'account-1', custodianAccountId: 'account-1', machineId: MACHINE_ID,
                installationId: 'installation-1', role: 'use', encryptionMode: 'plain' } };
        const request = { machineId: MACHINE_ID, managedServiceId: resource.previewId };
        expect(await routes.openOrCreate(request, undefined, context)).toMatchObject({ ok: true,
            response: { preview: { resource, accessUrl: 'https://preview.example.test/' } } });
        expect(verifyMachineAdmissionCurrent).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledTimes(1);
        expect(await routes.openOrCreate(request, undefined, context))
            .toEqual({ ok: false, reasonCode: 'requester_credentials_unavailable' });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it.each(['owner', 'policy'] as const)('refuses server admission that changes the preview %s binding', async (changed) => {
        const routes = createRoutes({
            machineId: MACHINE_ID, accountId: 'account-1', registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
            server: { token: 'daemon-token', http: {
                async post(_url, body) {
                    const resource = LocalServicePreviewResourceV1Schema.parse(body);
                    return { data: {
                        resource: { ...resource, ...(changed === 'owner'
                            ? { owner: { kind: 'user', id: 'other-account' } }
                            : { policy: { allowedMethods: ['POST'], cookiePolicy: 'drop', compressionPolicy: 'identity',
                                redirectPolicy: 'preserve_host_origin', maxRequestBodyBytes: 1024, maxResponseBodyBytes: 1024 } }) },
                        accessUrl: 'https://other.preview.example.test/?previewToken=wrong-binding', expiresAt: 61_000,
                    } };
                },
                async delete() { return { data: { ok: true } }; },
            } },
        });
        expect(await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' }))
            .toEqual({ ok: false, reasonCode: 'preview_registration_failed' });
        expect((await routes.getSnapshot()).previews?.[0]).toMatchObject({ accessUrl: null, expiresAt: null });
    });

    it('resolves a slow selected loopback endpoint without an inventory probe deadline', async () => {
        let delayResponse = true;
        const target = createServer((_request, response) => {
            if (!delayResponse) { response.end(); return; }
            const timer = setTimeout(() => response.end(), 300);
            response.once('close', () => clearTimeout(timer));
        });
        target.listen(0, '127.0.0.1');
        await once(target, 'listening');
        const address = target.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
        try {
            const endpointEnricher = createLocalServiceEndpointEnricher({
                now: () => 2_000, });
            const registry = inventoryRegistryWith([inventoryEntry({ port: address.port, endpoint: undefined })]);
            expect(registry.getSnapshot().entries[0]?.endpoint).toBeUndefined();
            const routes = createLocalServicePreviewRoutes({
                machineId: MACHINE_ID, registry: createLocalServicePreviewRegistry(), inventoryRegistry: registry, endpointEnricher,
            });
            const opened = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
            expect(opened.ok).toBe(true);
            if (!opened.ok) throw new Error(opened.reasonCode);
            expect(opened.response.preview.resource.target).toEqual({ scheme: 'http', host: '127.0.0.1', port: address.port });
            expect(opened.response.preview.accessUrl).toContain('.preview.example.test/');
            expect(registry.getSnapshot().entries[0]?.endpoint).toBeUndefined();
            delayResponse = false;
        } finally {
            target.closeAllConnections();
            await new Promise<void>((resolve) => target.close(() => resolve()));
        }
    });

    it.each(['direct', 'machineRpc'] as const)('cancels an unresolved %s Open without publishing a preview and permits a later Open', async (transport) => {
        let respond = false;
        let completeResponse: (() => void) | undefined;
        let received: (() => void) | undefined;
        const target = createServer((_request, response) => {
            completeResponse = () => response.end();
            received?.();
            if (respond) response.end();
        });
        target.listen(0, '127.0.0.1');
        await once(target, 'listening');
        const address = target.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
        try {
            const endpointEnricher = createLocalServiceEndpointEnricher({
                now: () => 2_000, });
            const routes = createLocalServicePreviewRoutes({
                machineId: MACHINE_ID, registry: createLocalServicePreviewRegistry(),
                inventoryRegistry: inventoryRegistryWith([inventoryEntry({ port: address.port, endpoint: undefined })]), endpointEnricher,
            });
            const abort = new AbortController();
            const requestSeen = new Promise<void>((resolve) => { received = resolve; });
            const handlers = new Map<string, (payload: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
            const registrar: RpcHandlerRegistrar = {
                registerHandler(method, handler) {
                    // The transport harness invokes only the known registered request shape.
                    handlers.set(method, handler as (payload: unknown, context?: RpcHandlerContext) => Promise<unknown>);
                },
            };
            registerDaemonLocalServicePreviewSnapshotHandler(registrar, { localServicesPreview: routes });
            const request = { machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' };
            const handler = handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE);
            if (!handler) throw new Error('Expected preview RPC registration');
            const pending = transport === 'direct' ? routes.openOrCreate(request, abort.signal) : handler(request, { signal: abort.signal });
            // Race the owner result so pre-fix refusal fails rather than waiting for an absent request.
            expect(await Promise.race([requestSeen.then(() => 'requested'), pending.then(() => 'refused')])).toBe('requested');
            const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            abort.abort();
            completeResponse?.();
            await rejected;
            expect((await routes.getSnapshot()).resources).toEqual([]);
            respond = true;
            expect((await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' })).ok).toBe(true);
        } finally {
            target.closeAllConnections();
            await new Promise<void>((resolve) => target.close(() => resolve()));
        }
    });

    it.each(['http', 'websocket'] as const)('rejects a malformed absolute %s request target and keeps the native adapter live', async (kind) => {
        let upstreamRequests = 0;
        const target = createServer((_request, response) => { upstreamRequests += 1; response.end('alive'); });
        target.listen(0, '127.0.0.1');
        await once(target, 'listening');
        const address = target.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback target');
        const abort = new AbortController();
        const preview: LocalServicePreviewResourceV1 = {
            previewId: 'preview_1', machineId: MACHINE_ID, owner: { kind: 'user', id: 'account-1' },
            target: { scheme: 'http', host: '127.0.0.1', port: address.port },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Preview', addressLabel: 'loopback' }, originMode: 'host',
        };
        const registry = createLocalServicePreviewRegistry();
        expect(registerLocalServicePreview(registry, preview).ok).toBe(true);
        const adapter = await startLocalServicePreviewNativeAdapter({ signal: abort.signal, preview,
            resolvePreview: () => resolveLocalServicePreviewApplication(registry, localServicePreviewDirectBindingV1(preview)) });
        let malformed: ReturnType<typeof httpRequest> | undefined;
        let onUncaught: ((error: Error) => void) | undefined;
        try {
            const outcome = await new Promise<{ status: number } | { failure: Error }>((resolve) => {
                // Observe the real callback failure without substituting an ingress/parser.
                // Vitest still records any uncaught exception as a failing daemon contract.
                onUncaught = (error) => resolve({ failure: error });
                process.once('uncaughtExceptionMonitor', onUncaught);
                malformed = httpRequest({ host: '127.0.0.1', port: adapter.port, method: 'GET', path: 'http://',
                    ...(kind === 'websocket' ? { headers: { connection: 'Upgrade', upgrade: 'websocket',
                        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } } : {}),
                }, (response) => { response.resume(); resolve({ status: response.statusCode ?? 0 }); });
                malformed.once('error', (failure) => resolve({ failure }));
                malformed.end();
            });
            malformed?.destroy();
            expect(outcome).toEqual({ status: 400 });
            expect(upstreamRequests).toBe(0);
            expect(await (await fetch(`http://127.0.0.1:${adapter.port}/`)).text()).toBe('alive');
            expect(upstreamRequests).toBe(1);
        } finally {
            if (onUncaught) process.off('uncaughtExceptionMonitor', onUncaught);
            malformed?.destroy();
            await adapter.close();
            target.closeAllConnections();
            await new Promise<void>((resolve) => target.close(() => resolve()));
        }
    });
    it('projects the access owner no-private-route reason without losing the registration', async () => {
        const routes = createRoutes({
            machineId: MACHINE_ID,
            accountId: 'account-1',
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
            server: {
                token: 'daemon-token',
                http: {
                    async post(_url, body) {
                        return { data: { resource: body, accessUrl: null, expiresAt: null, accessUnavailableReasonCode: 'preview_private_route_unavailable' } };
                    },
                    async delete() { return { data: { ok: true } }; },
                },
            },
        });
        const opened = await routes.openOrCreate({ machineId: MACHINE_ID, sessionId: 'session-1', inventoryEntryId: 'entry-vite' });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(opened.response.preview).toMatchObject({ accessUrl: null, accessUnavailableReasonCode: 'preview_private_route_unavailable' });
        expect((await routes.getSnapshot()).previews).toEqual([opened.response.preview]);
    });
    it('reads preview snapshots without minting new viewer admissions', async () => {
    it.each(['publish', 'revoke'] as const)('retains preview %s transport causes while keeping existing refusal results', async phase => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const registry = createLocalServicePreviewRegistry();
        const resource = LocalServicePreviewResourceV1Schema.parse({ previewId: 'publication-diagnostic', machineId: MACHINE_ID,
            owner: { kind: 'user', id: 'account-1' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/' }, display: { title: 'Preview', addressLabel: 'Loopback' }, originMode: 'host' });
        registerLocalServicePreview(registry, resource);
        const failure = Object.assign(new Error('private preview publication failure'), { code: 'ECONNREFUSED' });
        const routes = createRoutes({ machineId: MACHINE_ID, accountId: 'account-1', registry, server: {
            token: 'daemon-token', serverBaseUrl: 'https://home.example.test', http: {
                async post() { throw failure; }, async delete() { throw failure; },
            },
        } });
        try {
            const result = phase === 'publish'
                ? await routes.openOrCreate({ machineId: MACHINE_ID, launchTargetId: resource.previewId })
                : await routes.revoke({ machineId: MACHINE_ID, previewId: resource.previewId });
            expect(result).toEqual({ ok: false, reasonCode: 'preview_registration_failed' });
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: `local_service.preview.${phase}`, errorClass: 'Error', errorCode: 'ECONNREFUSED',
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private preview publication failure');
            expect(registry.previewsById.has(resource.previewId)).toBe(true);
        } finally { diagnostic.mockRestore(); }
    });

        const routes = createLocalServicePreviewRoutes({ machineId: MACHINE_ID, registry: createLocalServicePreviewRegistry(), inventoryRegistry: inventoryRegistryWith([inventoryEntry()]), now: () => 1_000 });
        const opened = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const first = await routes.getSnapshot();
        const second = await routes.getSnapshot();
        expect(first.previews?.[0]?.accessUrl).toBe(opened.response.preview.accessUrl);
        expect(second.previews?.[0]?.accessUrl).toBe(first.previews?.[0]?.accessUrl);
        expect(second.previews?.[0]?.resource.previewId).toBe(opened.response.preview.resource.previewId);
    });
    it('keeps a failed registration as a typed row without losing healthy preview snapshots', async () => {
        const routes = createRoutes({
            machineId: MACHINE_ID,
            accountId: 'account-1',
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([inventoryEntry(), inventoryEntry({ id: 'entry-bad', port: 5174, endpoint: { scheme: 'http', host: '127.0.0.1', port: 5174, probeState: 'ready', probedAt: 2_000 } })]),
            server: {
                token: 'daemon-token',
                http: {
                    async post(_url, body) {
                        const resource = body as LocalServicePreviewResourceV1;
                        if (resource.target.port === 5174) throw new Error('registration refused');
                        return { data: { resource, accessUrl: 'https://healthy.preview.example.test/?previewToken=one', expiresAt: 61_000 } };
                    },
                    async delete() { return { data: { ok: true } }; },
                },
            },
        });
        expect((await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' })).ok).toBe(true);
        expect(await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-bad' })).toEqual({ ok: false, reasonCode: 'preview_registration_failed' });
        const snapshot = await routes.getSnapshot();
        expect(snapshot.previews).toHaveLength(2);
        expect(snapshot.previews?.find((row) => row.resource.target.port === 5173)?.accessUrl).toContain('healthy.preview.example.test');
        expect(snapshot.previews?.find((row) => row.resource.target.port === 5174)).toMatchObject({ accessUrl: null, expiresAt: null, diagnostics: [{ code: 'preview_registration_failed', severity: 'error', scope: 'privatePreview' }] });
    });
    it('keeps sessionless Machine scope real and does not reuse another Session or path', async () => {
        const routes = createLocalServicePreviewRoutes({ machineId: MACHINE_ID, registry: createLocalServicePreviewRegistry(), inventoryRegistry: inventoryRegistryWith([inventoryEntry()]), now: () => 1_000 });
        const unscoped = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
        const first = await routes.openOrCreate({ machineId: MACHINE_ID, sessionId: 'session-1', inventoryEntryId: 'entry-vite' });
        const other = await routes.openOrCreate({ machineId: MACHINE_ID, sessionId: 'session-2', inventoryEntryId: 'entry-vite', initialPath: { pathname: '/second', search: '?view=2' } });
        expect(unscoped.ok && first.ok && other.ok).toBe(true);
        if (!unscoped.ok || !first.ok || !other.ok) return;
        expect(unscoped.response.preview.resource.sessionId).toBeUndefined();
        expect(unscoped.response.preview.resource.owner).toEqual({ kind: 'user', id: 'account-1' });
        expect(first.response.preview.previewId).not.toBe(other.response.preview.previewId);
        expect(other.response.preview.resource.sessionId).toBe('session-2');
        expect(new URL(other.response.preview.accessUrl ?? '').pathname).toBe('/second');
        const navigated = await routes.openOrCreate({ machineId: MACHINE_ID, sessionId: 'session-1', inventoryEntryId: 'entry-vite', initialPath: { pathname: '/new', search: '?tab=3' } });
        expect(navigated.ok).toBe(true);
        if (navigated.ok) expect(new URL(navigated.response.preview.accessUrl ?? '').pathname).toBe('/new');
    });

    it('reuses an existing Session preview for an unscoped inventory Open without changing its ownership or policy', async () => {
        const registry = createLocalServicePreviewRegistry();
        const previewId = previewIdForInventoryEntry('account-1', MACHINE_ID, 'session-1', 'entry-vite');
        const registration = registerLocalServicePreview(registry, {
            previewId, machineId: MACHINE_ID, sessionId: 'session-1',
            owner: { kind: 'session', id: 'session-1' },
            target: { scheme: 'http', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/dashboard', search: '?view=fixture' },
            display: { title: 'Fixture', addressLabel: 'localhost:5173' }, originMode: 'host',
            policy: { allowedMethods: ['GET'], cookiePolicy: 'drop', compressionPolicy: 'identity',
                redirectPolicy: 'preserve_host_origin', maxRequestBodyBytes: 1024, maxResponseBodyBytes: 1024 },
        });
        expect(registration.ok).toBe(true);
        if (!registration.ok) return;
        const routes = createLocalServicePreviewRoutes({ machineId: MACHINE_ID, registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]) });

        const opened = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });

        expect(opened).toMatchObject({ ok: true, response: {
            status: 'existing', preview: { previewId, resource: registration.resource },
            snapshot: { resources: [registration.resource] },
        } });
        expect(registry.previewsById.size).toBe(1);
    });

    it('openOrCreate registers a loopback inventory entry and mints its accessUrl', async () => {
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
            now: () => 1_000,
        });

        const result = await routes.openOrCreate({
            machineId: MACHINE_ID,
            sessionId: 'session-1',
            inventoryEntryId: 'entry-vite',
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.response.status).toBe('created');
        expect(new URL(result.response.preview.accessUrl ?? '').hostname).toMatch(/\.preview\.example\.test$/);
        expect(result.response.preview.resource.browserTarget?.kind).toBe('localServicePreview');
        // The snapshot now reflects the registered preview.
        expect(result.response.snapshot.previews).toHaveLength(1);
    });

    it('openOrCreate uses the daemon-detected HTTPS endpoint scheme for detected services', async () => {
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry({
                port: 8443,
                presentation: { addressLabel: 'localhost:8443', displayName: 'Secure app' },
                endpoint: {
                    scheme: 'https',
                    host: '127.0.0.1',
                    port: 8443,
                    probeState: 'ready',
                    probedAt: 2_000,
                },
            })]),
            now: () => 1_000,
        });

        const result = await routes.openOrCreate({
            machineId: MACHINE_ID,
            sessionId: 'session-1',
            inventoryEntryId: 'entry-vite',
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(new URL(result.response.preview.accessUrl ?? '').hostname).toMatch(/\.preview\.example\.test$/);
        expect(result.response.preview.resource.target).toMatchObject({
            scheme: 'https',
            host: '127.0.0.1',
            port: 8443,
        });
    });

    it('openOrCreate refuses detected services whose endpoint scheme is still unknown', async () => {
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([inventoryEntry({
                endpoint: {
                    scheme: 'unknown',
                    host: '127.0.0.1',
                    port: 5173,
                    probeState: 'unknown',
                    probedAt: 2_000,
                    reasonCode: 'endpoint_probe_failed',
                },
            })]),
            now: () => 1_000,
        });

        const result = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });

        expect(result).toEqual({ ok: false, reasonCode: 'endpoint_probe_failed' });
    });

    it('openOrCreate is idempotent: a second call returns the existing preview', async () => {
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
            now: () => 1_000,
        });

        await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
        const second = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });

        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.response.status).toBe('existing');
        expect(second.response.snapshot.previews).toHaveLength(1);
    });

    it('openOrCreate refuses an unknown inventory entry', async () => {
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([]),
            now: () => 1_000,
        });

        const result = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'nope' });

        expect(result).toEqual({ ok: false, reasonCode: 'unknown_inventory_entry' });
    });

    it('openOrCreate refuses a cross-machine request', async () => {
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
        });

        const result = await routes.openOrCreate({ machineId: 'other', inventoryEntryId: 'entry-vite' });

        expect(result).toEqual({ ok: false, reasonCode: 'wrong_machine' });
    });

    it('revoke unregisters a preview and reports it gone from the snapshot', async () => {
        const registry = createLocalServicePreviewRegistry();
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry,
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
            now: () => 1_000,
        });
        const created = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const previewId = created.response.preview.previewId;

        const revoked = await routes.revoke({ machineId: MACHINE_ID, previewId });

        expect(revoked.ok).toBe(true);
        if (!revoked.ok) return;
        expect(revoked.response.revoked).toBe(true);
        expect(revoked.response.snapshot.previews).toHaveLength(0);
    });

    it('revoke preserves failures but removes a registration the server confirms absent', async () => {
        let status = 403;
        let reasonCode = 'session_not_authorized';
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            inventoryRegistry: inventoryRegistryWith([inventoryEntry()]),
        }, async () => {
            throw new AxiosError('Preview deletion refused', undefined, undefined, undefined, {
                status,
                statusText: 'Error',
                headers: {},
                config: { headers: new AxiosHeaders() },
                data: { reasonCode },
            });
        });
        const created = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const request = { machineId: MACHINE_ID, previewId: created.response.preview.previewId };

        expect(await routes.revoke(request)).toEqual({ ok: false, reasonCode });
        expect((await routes.getSnapshot()).previews).toHaveLength(1);
        status = 404;
        expect(await routes.revoke(request)).toEqual({ ok: false, reasonCode });
        expect((await routes.getSnapshot()).previews).toHaveLength(1);

        reasonCode = 'preview_not_found';
        const revoked = await routes.revoke(request);
        expect(revoked).toMatchObject({ ok: true, response: { revoked: true, snapshot: { previews: [] } } });
    });

    it('revoke of a non-existent preview reports revoked:false (idempotent)', async () => {
        const routes = createLocalServicePreviewRoutes({
            machineId: MACHINE_ID,
            registry: createLocalServicePreviewRegistry(),
            now: () => 1_000,
        });

        const result = await routes.revoke({ machineId: MACHINE_ID, previewId: 'missing' });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.response.revoked).toBe(false);
    });
});

it('reads only a Use guest’s own Project preview metadata without forwarding viewer credentials', async () => {
    const owner = createManagedServicesOwner({
        processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
        dependencies() { throw new Error('Native Project preview does not install Plugin dependencies'); },
        resolveScope: scope => scope,
    });
    const registry = createLocalServicePreviewRegistry();
    const workspace = { id: 'guest-checkout', serverId: 'home', machineId: MACHINE_ID, rootPath: process.cwd(), createdAtMs: 1 };
    const previewIds: string[] = [];
    try {
        for (const accountId of ['guest', 'custodian']) {
            const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: accountId } };
            const handle = await owner.superviseProject({ kind: 'workspace', workspace, declaration, cwd: workspace.rootPath,
                serviceId: accountId, specIdentity: accountId, isCurrent: () => true,
                requester: { accountId, serverId: 'home', machineId: MACHINE_ID, installationId: 'installation' },
                processSpec: { mode: { kind: 'native',
                    instance: { adapter: { pluginId: 'fixture.plugin', localId: 'web' }, nativeResourceId: accountId },
                    lifecycle: { inspect: async () => ({ phase: 'running', readiness: 'ready', endpoint: 'http://127.0.0.1:42518' }),
                        stop: async () => ({ status: 'stopped' }) } } },
                authorizeLaunch: async () => ({ command: process.execPath, args: [], env: {}, release: async () => undefined }),
            });
            previewIds.push(handle.instanceId);
            const registered = registerLocalServicePreview(registry, { previewId: handle.instanceId, machineId: MACHINE_ID,
                serviceTarget: { kind: 'managed_service', machineId: MACHINE_ID, managedServiceId: handle.instanceId,
                    workspaceId: workspace.id, declaration, cwd: workspace.rootPath },
                owner: { kind: 'user', id: accountId }, target: { scheme: 'http', host: '127.0.0.1', port: 42518 },
                initialPath: { pathname: '/', search: '' }, display: { title: accountId, addressLabel: 'localhost:42518' }, originMode: 'host' });
            if (!registered.ok) throw new Error(registered.reasonCode);
            registry.previewsById.set(handle.instanceId, { ...registry.previewsById.get(handle.instanceId)!,
                accessUrl: 'https://custodian.preview.example.test/', expiresAt: 61_000 });
        }
        const routes = createRoutes({ machineId: MACHINE_ID, serverId: 'home', accountId: 'custodian', registry, projectManagedServices: owner });
        const context: RpcHandlerContext = { signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => true,
            machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'custodian', machineId: MACHINE_ID,
                installationId: 'installation', role: 'use', encryptionMode: 'plain' } };
        const snapshot = await routes.getSnapshot(context);
        expect(snapshot.resources.map(resource => resource.previewId)).toEqual([previewIds[0]]);
        expect(snapshot.previews).toMatchObject([{ previewId: previewIds[0], accessUrl: null, expiresAt: null }]);
        expect(await routes.openOrCreate({ machineId: MACHINE_ID, serviceTarget: snapshot.resources[0]!.serviceTarget }, undefined, context))
            .toEqual({ ok: false, reasonCode: 'requester_credentials_unavailable' });
    } finally { await owner.dispose(); }
});
