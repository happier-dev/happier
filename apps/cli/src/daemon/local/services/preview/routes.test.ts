import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import { createLocalServicePreviewRoutes as createRoutes } from './routes';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { createLocalServicePreviewRegistry } from './registry';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { LocalServicePreviewServerInput } from './serverRoutes';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { startLocalServicePreviewNativeAdapter } from './nativeAdapter';
import { createLocalServiceEndpointEnricher } from '../inventory/endpoint';
import { registerDaemonLocalServicePreviewSnapshotHandler } from '@/rpc/handlers/daemonLocalServicePreviewSnapshot';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';

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
    it('registers an observed Project endpoint through the existing preview owner and refuses retired exact custody', async () => {
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Project literal launch cannot reach plugin dependency installation.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
        });
        const workspace = { id: 'checkout', serverId: 'home', machineId: MACHINE_ID, rootPath: process.cwd(), createdAtMs: 1 };
        const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'web' } };
        let stopped = false;
        const handle = await owner.superviseProject({ workspace, declaration, cwd: workspace.rootPath,
            serviceId: 'web', specIdentity: 'web', isCurrent: () => true,
            requester: { serverId: 'home', accountId: 'account-1', machineId: MACHINE_ID, installationId: 'installation' },
            processSpec: { mode: { kind: 'native',
                instance: { adapter: { pluginId: 'fixture.plugin', localId: 'web' }, nativeResourceId: 'exact-web' },
                lifecycle: { inspect: async () => ({ phase: stopped ? 'stopped' : 'running', readiness: 'ready', endpoint: 'http://127.0.0.1:4312' }),
                    stop: async () => { stopped = true; return { status: 'stopped' }; } } } },
            authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, release: async () => undefined }),
        });
        const serviceTarget = { kind: 'managed_service' as const, machineId: MACHINE_ID, managedServiceId: handle.instanceId,
            workspaceId: workspace.id, declaration, cwd: workspace.rootPath };
        try {
            const registry = createLocalServicePreviewRegistry();
            const routes = createLocalServicePreviewRoutes({ machineId: MACHINE_ID, registry, projectManagedServices: owner });
            expect(await routes.openOrCreate({ machineId: MACHINE_ID, serviceTarget: { ...serviceTarget, cwd: `${workspace.rootPath}/other` } }))
                .toEqual({ ok: false, reasonCode: 'preview_target_unresolved' });
            const result = await routes.openOrCreate({ machineId: MACHINE_ID, serviceTarget });
            expect(result).toMatchObject({ ok: true, response: { status: 'created', preview: { resource: {
                serviceTarget, owner: { kind: 'user', id: 'account-1' }, target: { scheme: 'http', host: '127.0.0.1', port: 4312 },
            }, accessUrl: expect.stringContaining('previewToken=admission-') } } });
            expect((await routes.getSnapshot()).resources).toHaveLength(1);
            await handle.stop();
            expect(await routes.openOrCreate({ machineId: MACHINE_ID, serviceTarget }))
                .toEqual({ ok: false, reasonCode: 'preview_target_unresolved' });
        } finally { await handle.stop(); await owner.dispose(); }
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
        expect(httpReached).toBe(false);
        expect(registry.previewsById.has('private-preview')).toBe(true);
        const ownContext: RpcHandlerContext = { ...context,
            machineAdmission: { ...context.machineAdmission!, actorAccountId: 'account-1' },
            verifyMachineAdmissionCurrent: async () => true };
        expect((await routes.getSnapshot(ownContext)).previews[0]?.accessUrl).toContain('previewToken=custodian');
        await expect(routes.getSnapshot({ ...ownContext, verifyMachineAdmissionCurrent: async () => false }))
            .rejects.toThrow('requester_credentials_unavailable');
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

    it('resolves a slow loopback endpoint after an inconclusive inventory observation before registering Open', async () => {
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
                now: () => 2_000, timeoutMs: 250, concurrency: 1, successTtlMs: 30_000, failureTtlMs: 5_000,
            });
            const registry = inventoryRegistryWith([inventoryEntry({ port: address.port, endpoint: undefined })]);
            registry.replaceSnapshot(await endpointEnricher.enrich(registry.getSnapshot()));
            expect(registry.getSnapshot().entries[0]?.endpoint).toMatchObject({ scheme: 'unknown', probeState: 'unknown' });
            const routes = createLocalServicePreviewRoutes({
                machineId: MACHINE_ID, registry: createLocalServicePreviewRegistry(), inventoryRegistry: registry, endpointEnricher,
            });
            const opened = await routes.openOrCreate({ machineId: MACHINE_ID, inventoryEntryId: 'entry-vite' });
            expect(opened.ok).toBe(true);
            if (!opened.ok) throw new Error(opened.reasonCode);
            expect(opened.response.preview.resource.target).toEqual({ scheme: 'http', host: '127.0.0.1', port: address.port });
            expect(opened.response.preview.accessUrl).toContain('.preview.example.test/');
            expect(registry.getSnapshot().entries[0]?.endpoint?.scheme).toBe('http');
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
                now: () => 2_000, timeoutMs: 250, concurrency: 1, successTtlMs: 30_000, failureTtlMs: 5_000,
            });
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
        const adapter = await startLocalServicePreviewNativeAdapter({ signal: abort.signal, preview: {
            previewId: 'preview_1', machineId: MACHINE_ID, owner: { kind: 'user', id: 'account-1' },
            target: { scheme: 'http', host: '127.0.0.1', port: address.port },
            initialPath: { pathname: '/', search: '' }, display: { title: 'Preview', addressLabel: 'loopback' }, originMode: 'host',
        } });
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

        expect(result).toEqual({ ok: false, reasonCode: 'endpoint_scheme_unknown' });
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
