import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'socket.io-client';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type {
    DaemonLocalServiceLauncherStartResponseV1,
    LocalServiceActionResultV1,
    LocalServiceLauncherSnapshotV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRuntimeActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServiceInventoryRoutes } from '@/daemon/local/services/inventory/routes';
import { createLocalServicePreviewRegistry, registerLocalServicePreview } from '@/daemon/local/services/preview/registry';
import { createLocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import { createLocalServicePublicPreviewServerRoutes } from '@/daemon/local/services/public/routes';
import { createLocalServiceLauncherFeed } from '@/daemon/local/services/launch/feed';
import { createLocalServiceLauncherRoutes } from '@/daemon/local/services/launch/routes';
import { createLocalServiceLauncherHistoryStore, createLocalServiceLauncherLeafRoutes } from '@/daemon/local/services/launch/leaves';
import { createLocalServiceActionRoutes } from '@/daemon/local/services/actions/routes';
import { registerDaemonLocalServicesMachineRpcHandlers } from './daemonLocalServices';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { NormalizedLocalServiceInventorySnapshot } from '@/daemon/local/services/inventory/scanner';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { discoverLocalServiceRunTargets } from '@/daemon/local/services/launch/runTargets';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServiceInventoryLauncherWatchResponseV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { fetchLocalServiceLauncherSnapshotViaMachineRpc } from '../../../../ui/sources/sync/domains/local/services/launch/machineRpc';

const launcherReadTransport = vi.hoisted(() => vi.fn());
// Only the UI's remote Machine transport is replaced; admission, handler, feed,
// native Service ownership and both wire decoders remain real.
vi.mock('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: launcherReadTransport,
}));
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS, type SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { DEFAULT_LOCAL_SERVICE_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/localServiceCapabilities';
import {
    DaemonLocalServiceInventorySnapshotResponseV1Schema,
    DaemonLocalServiceInventoryWatchResponseV1Schema,
} from '@happier-dev/protocol/local/services/inventory/v1';

function createRegistrar(): { handlers: Map<string, (payload: unknown) => Promise<unknown>>; registrar: RpcHandlerRegistrar } {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method, handler) {
                handlers.set(method, handler as (payload: unknown) => Promise<unknown>);
            },
        },
    };
}

const inventorySnapshot: NormalizedLocalServiceInventorySnapshot = {
    v: 1,
    machineId: 'machine_1',
    generatedAt: 1_000,
    refreshState: 'idle',
    entries: [],
    diagnostics: [],
};

const launcherSnapshot: LocalServiceLauncherSnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    updatedAt: 2_000,
    targets: [],
};

const actionResult: LocalServiceActionResultV1 = {
    v: 1,
    requestId: 'request_1',
    action: 'copy_url',
    status: 'succeeded',
    auditEvents: [{
        v: 1,
        eventId: 'request_1:0:succeeded',
        requestId: 'request_1',
        machineId: 'machine_1',
        action: 'copy_url',
        result: 'succeeded',
        recordedAt: 3_000,
    }],
};

const launcherStartResponse: DaemonLocalServiceLauncherStartResponseV1 = {
    protocolVersion: 1,
    machineId: 'machine_1',
    targetId: 'preview:web',
    status: 'denied',
    reasonCode: 'launcher_start_unsupported',
    snapshot: launcherSnapshot,
};

const publicExposure: LocalServicePublicExposureV1 = {
    exposureId: 'public_preview_1',
    previewId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    mode: 'secret_link',
    state: 'active',
    publicUrl: 'https://preview.example.test/s/public_preview_1',
    issuedAt: 1_000,
    expiresAt: 601_000,
    auditEventIds: ['audit_1'],
    rateLimitProfileId: 'default',
};

const publicPreviewSnapshot: LocalServicePublicPreviewSnapshotV1 = {
    v: 1,
    machineId: 'machine_1',
    sessionId: 'session_1',
    previewId: 'preview_1',
    generatedAt: 3_000,
    refreshState: 'idle',
    policy: {
        enabled: true,
        allowedModes: ['secret_link'],
        maxTtlMs: 600_000,
        maxConcurrentExposures: 1,
        dnsTlsRequired: true,
        auditRequired: true,
        rateLimitProfileIds: ['default'],
    },
    exposures: [publicExposure],
    diagnostics: [],
};

describe('daemon local services machine rpc handlers', () => {
    it.each(['preview', 'public'] as const)('admits the %s credential-bound read once, completes its captured response and refuses the next request', async kind => {
        let current = true;
        let withdrawDuringRead = false;
        let admissionRequests = 0;
        let statusRequests = 0;
        const credentialHeaders: Array<string | undefined> = [];
        // Home admission and public status are real HTTP boundaries. The RPC
        // manager, authorization, credential custody and route owners stay real.
        const home = createServer((request, response) => {
            credentialHeaders.push(request.headers.authorization);
            response.setHeader('content-type', 'application/json');
            if (request.headers.authorization !== 'Bearer custodian-token') {
                response.writeHead(401).end(JSON.stringify({ current: false }));
                return;
            }
            if (request.url === '/admission') {
                admissionRequests++;
                const admitted = current;
                if (withdrawDuringRead && kind === 'preview') current = false;
                response.end(JSON.stringify({ current: admitted }));
                return;
            }
            if (request.url === '/v1/local-services/public/status' && request.method === 'POST') {
                statusRequests++;
                if (withdrawDuringRead) current = false;
                response.end(JSON.stringify({ protocolVersion: 1, snapshot: publicPreviewSnapshot }));
                return;
            }
            response.writeHead(404).end('{}');
        });
        await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
        const address = home.address();
        if (!address || typeof address === 'string') throw new Error('Missing admitted Home boundary');
        const serverBaseUrl = `http://127.0.0.1:${address.port}`;
        try {
            const rpc = new RpcHandlerManager({ scopePrefix: 'machine_1', localMachineId: 'machine_1',
                encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                    machineId: 'machine_1', resolveCustodianAccountId: async () => 'custodian',
                    resolveInstallationId: () => 'installation_1', verifyMachineAdmission: async () => {
                        const response = await fetch(`${serverBaseUrl}/admission`, { headers: { Authorization: 'Bearer custodian-token' } });
                        const result: unknown = await response.json();
                        return response.ok && typeof result === 'object' && result !== null && 'current' in result && result.current === true;
                    },
                }) });
            const registry = createLocalServicePreviewRegistry();
            const privatePreview = { previewId: 'preview_1', diagnostics: [],
                resource: { previewId: 'preview_1', machineId: 'machine_1', owner: { kind: 'user' as const, id: 'custodian' },
                    target: { scheme: 'http' as const, host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
                    display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host' as const },
                accessUrl: 'https://private.example.test/?previewToken=held-viewer', expiresAt: 601_000 };
            registry.previewsById.set(privatePreview.previewId, privatePreview);
            registerDaemonLocalServicesMachineRpcHandlers(rpc, { accountId: 'custodian', machineId: 'machine_1',
                ...(kind === 'preview' ? { localServicesPreview: createLocalServicePreviewRoutes({ machineId: 'machine_1',
                    accountId: 'custodian', registry, server: { token: 'custodian-token', serverBaseUrl } }) }
                    : { localServicesPublicPreview: createLocalServicePublicPreviewServerRoutes({ accountId: 'custodian',
                        token: 'custodian-token', serverBaseUrl }) }),
            });
            const method = kind === 'preview' ? RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT
                : RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS;
            const request = { method: `machine_1:${method}`, params: { machineId: 'machine_1',
                ...(kind === 'public' ? { sessionId: 'session_1', previewId: 'preview_1' } : {}) },
                machineAdmission: { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId: 'machine_1',
                    installationId: 'installation_1', role: 'manage', encryptionMode: 'plain' } satisfies SocketRpcMachineAdmissionContextV1 };
            const visible = { protocolVersion: 1, snapshot: kind === 'preview'
                ? { previews: [expect.objectContaining({ resource: privatePreview.resource, accessUrl: privatePreview.accessUrl })] }
                : publicPreviewSnapshot };
            expect(await rpc.handleRequest(request)).toMatchObject(visible);
            expect.soft(admissionRequests).toBe(1);
            expect(statusRequests).toBe(kind === 'public' ? 1 : 0);
            const guest = await rpc.handleRequest({ ...request, machineAdmission: { ...request.machineAdmission,
                actorAccountId: 'foreign-account', role: 'use' } });
            expect(guest).toHaveProperty('error');
            expect(guest).not.toHaveProperty('errorCode', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
            // Public links on this Machine are read with its owner's Account: a guest is told that
            // fact (closed Machine-access vocabulary), before any Home read, whatever the link is.
            if (kind === 'public') expect(guest).toMatchObject({ errorCode: 'custodian_only',
                failureCause: { phase: 'rpc.handler', errorCode: 'custodian_only' } });
            expect(statusRequests).toBe(kind === 'public' ? 1 : 0);
            admissionRequests = 0;
            withdrawDuringRead = true;
            expect.soft(await rpc.handleRequest(request)).toMatchObject(visible);
            expect.soft(admissionRequests).toBe(1);
            expect(current).toBe(false);
            const completedStatusRequests = statusRequests;
            expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
            expect.soft(admissionRequests).toBe(2);
            expect(statusRequests).toBe(completedStatusRequests);
            expect(credentialHeaders.every(header => header === 'Bearer custodian-token')).toBe(true);
        } finally {
            home.closeAllConnections();
            await new Promise<void>(resolve => home.close(() => resolve()));
        }
    });

    it('reads the runtime summary through RPC and Action without scanning or starting observation', async () => {
        const scan = vi.fn(async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }));
        const runtime = createLocalServicesDaemonRuntime({ machineId: 'machine_1', startLoop: false,
            inventoryEnabled: () => true, scan, processEnv: { NODE_ENV: 'test' } });
        try {
            const { handlers, registrar } = createRegistrar();
            registerDaemonLocalServicesMachineRpcHandlers(registrar, { machineId: 'machine_1', localServicesInventory: runtime.inventoryRoutes });
            const expected = { summary: runtime.getSummary() };
            expect(await handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT)?.({ machineId: 'machine_1', projection: 'count' })).toEqual(expected);
            await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT)?.({ machineId: 'machine_other', projection: 'count' })).rejects.toThrow();
            const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
                features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true } } }, capabilities: {} }) }) });
            await featureGate.refresh();
            const execute = createLocalServicesDaemonRuntimeActionExecutor({ routes: { inventoryRoutes: runtime.inventoryRoutes }, featureGate });
            expect(await execute({ actionId: 'localServices.inventory.list', input: { machineId: 'machine_1', projection: 'count' }, context: {} })).toEqual(expected);
            expect(scan).not.toHaveBeenCalled();
            expect(runtime.inventoryRoutes.watcherCount()).toBe(0);
        } finally { await runtime.stop(); }
    });
    it.each([
        RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
        RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
        RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
    ])('admits private Workspace reads once and refuses foreign requester disclosure through %s', async method => {
        const workspace = { id: 'private-workspace', serverId: 'private-home', machineId: 'machine_1',
            rootPath: process.cwd(), createdAtMs: 1, projectKey: 'private-project' };
        let current = true;
        let verificationRequests = 0;
        let now = 1_000;
        let command = 'private-web';
        let retireDuringScan = false;
        const runtime = createLocalServicesDaemonRuntime({ machineId: workspace.machineId, startLoop: false,
            processEnv: { NODE_ENV: 'test' }, now: () => now,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { localServices: { enabled: true, inventory: { enabled: true } } }, capabilities: {},
            }) }),
            // Current accepted Account rows and the OS scan are external boundaries.
            workspaceFacts: () => ({ facts: [{ id: workspace.id, path: workspace.rootPath }],
                acceptedWorkspaceRefs: [workspace], diagnostics: [] }),
            scan: async () => {
                await Promise.resolve();
                if (retireDuringScan) current = false;
                return { listeners: [{ address: '127.0.0.1', port: 43170, protocol: 'tcp' as const, pid: 1234567 }],
                    processes: new Map([[1234567, { pid: 1234567, cwd: workspace.rootPath, command, processOwnership: 'self' as const }]]),
                    workspaces: [], diagnostics: [] };
            },
        });
        try {
            await runtime.inventoryRoutes.refreshSnapshot();
            const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, localMachineId: workspace.machineId,
                encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                    machineId: workspace.machineId, resolveCustodianAccountId: async () => 'custodian',
                    resolveInstallationId: () => 'installation_1', verifyMachineAdmission: async () => { verificationRequests++; return current; },
                }) });
            const boundCredential = { accountId: 'custodian' };
            registerDaemonLocalServicesMachineRpcHandlers(rpc, { ...boundCredential, machineId: workspace.machineId,
                serverId: workspace.serverId, localServicesInventory: runtime.inventoryRoutes });
            const params = { machineId: workspace.machineId,
                ...(method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? { sinceGeneratedAt: 0 } : {}) };
            const machineAdmission = { actorAccountId: 'custodian', custodianAccountId: 'custodian',
                machineId: workspace.machineId, installationId: 'installation_1', role: 'manage', encryptionMode: 'plain' } satisfies SocketRpcMachineAdmissionContextV1;
            const request = { method: `${workspace.machineId}:${method}`, params, machineAdmission };
            const visible = { protocolVersion: 1, snapshot: { entries: [expect.objectContaining({
                provenance: expect.objectContaining({ workspace: { id: workspace.id, path: workspace.rootPath, association: 'cwd_containment' } }),
            })] } };
            const admittedResponse = await rpc.handleRequest(request);
            expect(admittedResponse).toMatchObject(visible);
            expect(verificationRequests).toBe(1);
            const admittedSnapshot = (() => {
                if (method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                    return DaemonLocalServiceInventorySnapshotResponseV1Schema.parse(admittedResponse).snapshot;
                }
                const watchResponse = DaemonLocalServiceInventoryWatchResponseV1Schema.parse(admittedResponse);
                expect(watchResponse.changed).toBe(true);
                if (!watchResponse.changed) throw new Error('Expected the inventory watch to return its newer snapshot');
                return watchResponse.snapshot;
            })();
            expect(admittedSnapshot.entries[0]).not.toHaveProperty('establishedConnections');
            expect(await rpc.invokeLocal(method, params)).toMatchObject(visible);
            expect(await rpc.handleRequest({ method: request.method, params })).toMatchObject(visible);
            expect(await rpc.handleRequest({ ...request, machineAdmission: { ...machineAdmission,
                actorAccountId: 'foreign-account', role: 'use' } })).toMatchObject({
                    error: 'requester_credentials_unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                });
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                verificationRequests = 0;
                const pending = rpc.handleRequest({ ...request, params: { machineId: workspace.machineId, sinceGeneratedAt: now } });
                await vi.waitFor(() => expect(runtime.inventoryRoutes.watcherCount()).toBe(1));
                current = false;
                now += 1;
                command = 'private-web-updated';
                await runtime.inventoryRoutes.refreshSnapshot();
                // This caller holds the current snapshot, so only the changed entry crosses.
                expect(await pending).toMatchObject({ protocolVersion: 1, delta: { upserts: visible.snapshot.entries } });
                expect(verificationRequests).toBe(1);
                expect(runtime.inventoryRoutes.watcherCount()).toBe(0);
                current = true;
                // Socket.IO is the network boundary; its CANCEL event reaches the real Manager and watch owner.
                const socket = Object.assign(new EventEmitter(), { connected: true }) as unknown as Socket;
                rpc.onSocketConnect(socket);
                const cancelled = rpc.handleRequest({ ...request, requestId: 'private-inventory-watch',
                    params: { machineId: workspace.machineId, sinceGeneratedAt: now } });
                await vi.waitFor(() => expect(runtime.inventoryRoutes.watcherCount()).toBe(1));
                socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'private-inventory-watch' });
                expect(await cancelled).toMatchObject({ error: 'requester_credentials_unavailable' });
                expect(runtime.inventoryRoutes.watcherCount()).toBe(0);
            } else {
                // Already admitted reads follow local cancellation through the
                // real scan; later Home state does not trigger another request.
                now += DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.refreshIntervalMs;
                retireDuringScan = true;
                verificationRequests = 0;
                expect(await rpc.handleRequest(request)).toMatchObject(visible);
                expect(verificationRequests).toBe(1);
            }
        } finally { await runtime.stop(); }
    });

    it.each([undefined, 'managed_bindings'] as const)(
        'admits launcher reads once and discloses only the guest requester own managed Services (projection=%s)',
        async projection => {
            const root = await mkdtemp(join(tmpdir(), 'happier-private-project-feed-'));
            const owner = createManagedServicesOwner({
                processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
                // This native resource has no managed dependency. Unexpected dependency access must fail.
                dependencies: () => { throw new Error('Native fixture has no managed dependency'); },
                resolveScope: scope => scope,
            });
            try {
                await mkdir(join(root, '.happier'));
                await writeFile(join(root, '.happier', 'project.json'), JSON.stringify({
                    version: 1, services: {
                        'private-web': { source: { kind: 'command', command: 'echo private' } },
                        'requester-web': { source: { kind: 'command', command: 'echo requester' } },
                    },
                }));
                const workspace = { id: 'private-workspace', serverId: 'private-home', machineId: 'machine_1',
                    rootPath: root, createdAtMs: 1, projectKey: 'private-project' };
                const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'private-web' } };
                const stopped = new Set<string>();
                const supervise = (serviceId: string, accountId: string) => owner.superviseProject({
                    kind: 'workspace',
                    workspace, declaration: accountId === 'custodian' ? declaration : {
                        workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'requester-web' },
                    }, cwd: root, serviceId, specIdentity: 'private-native-effect', execution: 'portable',
                    requester: { serverId: workspace.serverId, accountId, machineId: workspace.machineId,
                        installationId: 'installation_1' }, isCurrent: () => true,
                    processSpec: { startupTimeoutMs: 1_000, mode: { kind: 'native',
                        instance: { adapter: { pluginId: 'private-native', localId: 'web' }, nativeResourceId: serviceId },
                        // Native inspection and termination are external IO; all owner/feed logic remains real.
                        lifecycle: { inspect: async () => ({ phase: stopped.has(serviceId) ? 'stopped' : 'running',
                            readiness: 'not_reported', endpoint: stopped.has(serviceId) ? null : 'http://127.0.0.1:43170' }),
                            stop: async () => { stopped.add(serviceId); return { status: 'stopped' }; } },
                    } },
                    authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({ signal, assertCurrent() {},
                        projectLaunch: { status: 'ready', reviewedEffectDigest: 'private-native-effect', toolchain: {
                            selection: { kind: 'host' }, root, platform: process.platform,
                            io: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
                        } }, launch: { command: process.execPath, args: [], cwd: root, env: {} },
                    }),
                });
                const handle = await supervise('private-native-service', 'custodian');
                const requesterHandle = await supervise('requester-native-service', 'foreign-account');
                expect(requesterHandle.serviceId).not.toBe(handle.serviceId);
                expect(requesterHandle.requester.accountId).toBe('foreign-account');
                const runTargets = (await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [workspace] })).targets;
                const acceptedDeclaration = runTargets.find(target => 'declaration' in target
                    && target.declaration.selection.kind === 'manifest' && target.declaration.selection.name === 'private-web');
                if (!acceptedDeclaration) throw new Error('The accepted private Project fixture did not produce its declaration');
                const previewRegistry = createLocalServicePreviewRegistry();
                expect(registerLocalServicePreview(previewRegistry, {
                    previewId: 'custodian-private-preview', machineId: workspace.machineId,
                    owner: { kind: 'user', id: 'custodian' },
                    serviceTarget: { kind: 'managed_service', machineId: workspace.machineId,
                        workspaceId: workspace.id, managedServiceId: requesterHandle.instanceId, cwd: root,
                        declaration: requesterHandle.declaration },
                    target: { scheme: 'http', host: '127.0.0.1', port: 43170 },
                    initialPath: { pathname: '/private', search: '' },
                    display: { title: 'Custodian private preview', addressLabel: 'localhost:43170' }, originMode: 'host',
                }).ok).toBe(true);
                const inventoryRegistry = createLocalServiceInventoryRegistry();
                const inventoryRoutes = createLocalServiceInventoryRoutes({ registry: inventoryRegistry });
                const feed = createLocalServiceLauncherFeed({ machineId: workspace.machineId,
                    inventoryRegistry, previewRegistry,
                    projectManagedServices: owner,
                    runTargets,
                });
                let current = true;
                let verificationRequests = 0;
                const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, localMachineId: workspace.machineId,
                    encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                        machineId: workspace.machineId, resolveCustodianAccountId: async () => 'custodian',
                        resolveInstallationId: () => 'installation_1',
                        // Only the current Home admission network boundary is substituted.
                        verifyMachineAdmission: async () => { verificationRequests++; return current; },
                    }) });
                const boundCredential = { accountId: 'custodian' };
                const history = createLocalServiceLauncherHistoryStore();
                history.record(handle.serviceId);
                history.record(requesterHandle.serviceId);
                const leaves = createLocalServiceLauncherLeafRoutes({ machineId: workspace.machineId,
                    accountId: 'custodian', serverId: workspace.serverId, feed, history,
                    previewRoutes: createLocalServicePreviewRoutes({ machineId: workspace.machineId, serverId: workspace.serverId,
                        accountId: 'custodian', inventoryRegistry, registry: previewRegistry }),
                });
                registerDaemonLocalServicesMachineRpcHandlers(rpc, { ...boundCredential,
                    machineId: workspace.machineId, serverId: workspace.serverId,
                    localServicesInventory: inventoryRoutes,
                    localServicesLauncher: createLocalServiceLauncherRoutes({ feed, leaves }),
                });
                const params = { machineId: workspace.machineId, scope: 'workspace', workspaceRoot: root,
                    ...(projection ? { projection } : {}) };
                const machineAdmission = { actorAccountId: 'custodian', custodianAccountId: 'custodian',
                    machineId: workspace.machineId, installationId: 'installation_1', role: 'manage', encryptionMode: 'plain' } satisfies SocketRpcMachineAdmissionContextV1;
                const request = { method: `${workspace.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT}`, params, machineAdmission };
                const visible = { protocolVersion: 1, snapshot: { targets: expect.arrayContaining([
                    expect.objectContaining({ source: 'managed_service', declaration, cwd: root,
                        sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId } }),
                    ...(projection ? [] : [expect.objectContaining({ id: acceptedDeclaration.id, declaration,
                        workspace: expect.objectContaining({ workspaceId: workspace.id }) })]),
                ]) } };
                const custodianResponse = await rpc.handleRequest(request);
                expect(custodianResponse).toMatchObject(visible);
                expect(DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(custodianResponse).snapshot.targets
                    .find(target => target.id === requesterHandle.serviceId)?.browserTarget)
                    .toMatchObject({ targetId: 'custodian-private-preview' });
                expect(verificationRequests).toBe(1);
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, params)).toMatchObject(visible);
                expect(await rpc.handleRequest({ method: request.method, params })).toMatchObject(visible);
                current = false;
                expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
                current = true;
                verificationRequests = 0;
                let response: unknown;
                launcherReadTransport.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
                    response = await rpc.handleRequest({ ...request, method: `${workspace.machineId}:${method}`, params: payload,
                        machineAdmission: { ...machineAdmission, actorAccountId: 'foreign-account', role: 'use' } });
                    return response;
                });
                const uiRead = await fetchLocalServiceLauncherSnapshotViaMachineRpc({ ...params, scope: 'workspace',
                    accountId: 'foreign-account', serverId: workspace.serverId });
                const decoded = DaemonLocalServiceLauncherSnapshotResponseV1Schema.safeParse(response);
                expect(decoded.success, JSON.stringify(decoded.success ? null : {
                    response, issues: decoded.error.issues.map(issue => ({ code: issue.code, path: issue.path })),
                })).toBe(true);
                expect(uiRead).toMatchObject({ ok: true, snapshot: { machineId: workspace.machineId } });
                if (!decoded.success) throw new Error('The real launcher read response must satisfy the UI decoder');
                expect(decoded.data.snapshot.machineId).toBe(workspace.machineId);
                expect(decoded.data.snapshot.targets).toEqual([expect.objectContaining({
                    id: requesterHandle.serviceId, startedByAccountId: 'foreign-account',
                    sourceClass: { kind: 'managed_service', managedServiceId: requesterHandle.instanceId },
                    actions: expect.arrayContaining(['manage']),
                })]);
                expect(decoded.data.snapshot.targets[0]?.browserTarget).toMatchObject({
                    kind: 'localServicePreview', targetId: requesterHandle.serviceId, machineId: workspace.machineId,
                });
                expect(JSON.stringify(decoded.data.snapshot)).not.toContain('custodian-private-preview');
                expect(decoded.data.snapshot.targets[0]?.actions).not.toContain('open_preview');
                expect(verificationRequests).toBe(1);
                expect(DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await rpc.handleRequest({
                    ...request, machineAdmission: { ...machineAdmission, actorAccountId: 'unrelated-account', role: 'use' },
                })).snapshot.targets).toEqual([]);
                if (!projection) {
                    const guestRequest = { ...request, machineAdmission: { ...machineAdmission,
                        actorAccountId: 'foreign-account', role: 'use' as const } };
                    for (const method of [RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW,
                        RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW]) {
                        expect.soft(await rpc.handleRequest({ ...guestRequest, method: `${workspace.machineId}:${method}`,
                            params: { machineId: workspace.machineId, targetId: handle.serviceId, scope: 'machine' },
                        })).toMatchObject({ status: 'unavailable', reasonCode: 'launcher_target_unknown' });
                    }
                    expect.soft(await rpc.handleRequest({ ...guestRequest,
                        method: `${workspace.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR}`,
                        params: { machineId: workspace.machineId, scope: 'machine' },
                    })).toMatchObject({ cleared: 1, snapshot: { targets: [expect.objectContaining({ id: requesterHandle.serviceId })] } });
                    expect.soft(history.list()).toEqual([handle.serviceId]);
                    const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
                        status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                            localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true } },
                            browser: { enabled: true, viewTargets: { enabled: true } },
                        }, capabilities: {} }),
                    }) });
                    await gate.refresh();
                    const execute = createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate,
                        routes: { launcherRoutes: createLocalServiceLauncherRoutes({ feed, leaves }) },
                        ingress: { signal: new AbortController().signal, machineAdmission: guestRequest.machineAdmission,
                            verifyMachineAdmissionCurrent: async () => true },
                    });
                    expect.soft(await execute({ actionId: 'localServices.launcher.snapshot',
                        input: { machineId: workspace.machineId, scope: 'machine' }, context: { serverId: workspace.serverId },
                    })).toMatchObject({ targets: [expect.objectContaining({ id: requesterHandle.serviceId })] });
                    history.record(handle.serviceId);
                    history.record(requesterHandle.serviceId);
                    expect.soft(await execute({ actionId: 'localServices.launcher.history.clear',
                        input: { machineId: workspace.machineId, scope: 'machine' }, context: { serverId: workspace.serverId },
                    })).toMatchObject({ cleared: 1, snapshot: { targets: [expect.objectContaining({ id: requesterHandle.serviceId })] } });
                    expect.soft(history.list()).toEqual([handle.serviceId]);
                }
                if (projection === 'managed_bindings') {
                    const guest = { ...machineAdmission, actorAccountId: 'foreign-account', role: 'use' as const };
                    const watch = (targets: LocalServiceLauncherSnapshotV1['targets']) => rpc.handleRequest({
                        method: `${workspace.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH}`,
                        machineAdmission: guest,
                        params: { machineId: workspace.machineId,
                            launcherProjection: { request: { scope: 'workspace', workspaceRoot: root, projection }, targets } },
                    });
                    // The snapshot/watch gap is closed against the caller's admitted projection,
                    // never against the Machine-wide inventory generation.
                    expect(await watch([])).toMatchObject({ protocolVersion: 1, changed: true,
                        snapshot: { targets: [expect.objectContaining({ id: requesterHandle.serviceId })] } });
                    let settled = false;
                    const pending = watch(decoded.data.snapshot.targets).then(value => { settled = true; return value; });
                    await vi.waitFor(() => expect(inventoryRoutes.watcherCount()).toBe(1));
                    inventoryRegistry.invalidate();
                    await new Promise<void>(resolve => setImmediate(resolve));
                    await vi.waitFor(() => expect(inventoryRoutes.watcherCount()).toBe(1));
                    expect(settled).toBe(false);
                    await expect(handle.stop()).resolves.toEqual({ status: 'stopped' });
                    inventoryRegistry.invalidate();
                    await new Promise<void>(resolve => setImmediate(resolve));
                    await vi.waitFor(() => expect(inventoryRoutes.watcherCount()).toBe(1));
                    expect(settled).toBe(false);
                    await expect(requesterHandle.stop()).resolves.toEqual({ status: 'stopped' });
                    inventoryRegistry.invalidate();
                    const change = DaemonLocalServiceInventoryLauncherWatchResponseV1Schema.parse(await pending);
                    expect(change.changed).toBe(true);
                    if (!change.changed) throw new Error('Own Service removal must settle its projected watch');
                    expect(change.snapshot.targets.every(target => target.id === requesterHandle.serviceId)).toBe(true);
                    // Stop can publish its own material transition before cleanup completes.
                    // Re-parking from that snapshot must immediately catch the completed removal.
                    if (change.snapshot.targets.length) {
                        expect(await watch(change.snapshot.targets)).toMatchObject({ protocolVersion: 1, changed: true,
                            snapshot: { targets: [] } });
                    }
                    expect(owner.listProjectServices()).toEqual([]);
                    expect(inventoryRoutes.watcherCount()).toBe(0);
                    expect(await rpc.handleRequest({ method: `${workspace.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH}`,
                        machineAdmission: guest, params: { machineId: workspace.machineId, sinceGeneratedAt: 0 } }))
                        .toMatchObject({ error: 'requester_credentials_unavailable' });
                }
            } finally {
                await owner.dispose();
                await rm(root, { recursive: true, force: true });
            }
        },
    );

    it('refuses an unreviewable host-admitted Agent launcher start before creating an approval artifact', async () => {
        const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine_1',
            installationId: 'installation_1', role: 'use' as const, encryptionMode: 'plain' as const };
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine_1', localMachineId: 'machine_1',
            encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: machineAdmission.machineId, resolveInstallationId: () => machineAdmission.installationId,
                resolveCustodianAccountId: async () => machineAdmission.custodianAccountId,
                resolveHomeServerIdentityId: async () => 'home-a',
                // Only Home's installed-Machine currentness is the substituted boundary.
                verifyMachineAdmission: async () => true,
            }) });
        const feed = createLocalServiceLauncherFeed({ machineId: 'machine_1',
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry() });
        const launcher = createLocalServiceLauncherRoutes({ feed });
        const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
            status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true } },
                browser: { enabled: true, viewTargets: { enabled: true } },
            }, capabilities: {} }),
        }) });
        await gate.refresh();
        let stored: ReturnType<typeof ApprovalRequestV2Schema.parse> | undefined;
        registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: 'machine_1', localServicesLauncher: launcher,
            resolveLauncherActionExecutor: ({ ingress }) => {
                const executor = createActionExecutor({
                ...createUnavailableActionTransportDeps(),
                readActionsSettings: () => normalizeActionsSettingsV1(null),
                // Artifact persistence is the external Account boundary. Policy and dispatch remain real.
                approvalsCreate: async ({ request }) => {
                    stored = ApprovalRequestV2Schema.parse(request);
                    return { artifactId: 'service-start-approval' };
                },
                approvalsGet: async () => stored ?? null,
                approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
                runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({
                    featureGate: gate, ingress, routes: { launcherRoutes: launcher },
                }),
                });
                // The actual receiving credential factory binds this Home, not Action input.
                return { execute: (actionId, input, context) => executor.execute(actionId, input, { serverId: 'home-a', ...context }) };
            },
        });
        const proposed = await rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            { machineId: 'machine_1', targetId: 'unavailable-declaration' },
            { signal: new AbortController().signal, rpcContext: { machineAdmission,
                verifyMachineAdmissionCurrent: async () => true, callerAuthority: 'account_automation' },
                localActionContext: { surface: 'agent', authority: 'account_automation', actionRequestId: 'service-approval-request' } });
        expect(proposed).toEqual({ ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' });
        expect(stored).toBeUndefined();
    });
    it.each(['direct', 'action'] as const)('finishes admitted %s launcher resolution and refuses the next arrival after withdrawal', async ingressKind => {
        const machineAdmission = {
            actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'machine_1',
            installationId: 'installation_1', role: 'use' as const, encryptionMode: 'plain' as const,
        };
        // The authenticated Home/OS identity boundary can retire while resolution prepares.
        let current = true;
        const rpc = new RpcHandlerManager({
            scopePrefix: 'machine_1', localMachineId: 'machine_1', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: 'machine_1', resolveCustodianAccountId: async () => 'custodian',
                resolveInstallationId: () => 'installation_1', verifyMachineAdmission: async () => current,
            }),
        });
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies: () => { throw new Error('No managed dependency expected'); }, resolveScope: scope => scope,
        });
        onTestFinished(() => owner.dispose());
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine_1', inventoryRegistry: createLocalServiceInventoryRegistry(),
            previewRegistry: createLocalServicePreviewRegistry(), projectManagedServices: owner,
        });
        const launcher = createLocalServiceLauncherRoutes({
            feed,
            async resolveStartTarget(_request, ingress?: RpcHandlerContext) {
                if (!ingress?.machineAdmission) {
                    return { ok: false, reasonCode: 'machine_admission_required' } as const;
                }
                await Promise.resolve();
                current = false;
                return { ok: false, reasonCode: 'launcher_target_unknown' } as const;
            },
        });
            const featureGate = createLocalServicesDaemonFeatureGate({ env: {},
                resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                    features: { localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true } },
                        browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {},
                }) }),
            });
            await featureGate.refresh();
            const resolveActionExecutor: NonNullable<Parameters<typeof registerActionSpecRpcHandlers>[0]['resolveActionExecutor']> = ({ ingress }) => {
                    const execute = createLocalServicesDaemonRuntimeActionExecutor({
                        routes: { launcherRoutes: launcher }, featureGate, ingress,
                    });
                    return { execute: async (actionId, input, context = {}) => {
                        if (!isRuntimeActionIdV1(actionId)) throw new Error('Fixture only dispatches runtime Actions');
                        return { ok: true, result: await execute({ actionId, input, context: { serverId: 'home-a', ...context } }) };
                    } };
                };
        if (ingressKind === 'direct') registerDaemonLocalServicesMachineRpcHandlers(rpc, {
            machineId: 'machine_1', localServicesLauncher: launcher, resolveLauncherActionExecutor: resolveActionExecutor,
        });
        else registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['localServices.launcher.start'],
            targetMachineId: 'machine_1', defaultMachineTarget: true, resolveActionExecutor });

        const request = {
            method: `machine_1:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START}`,
            params: { machineId: 'machine_1', targetId: 'unavailable-declaration' },
            machineAdmission,
        };
        const admitted = await rpc.handleRequest(request);
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ status: 'denied', reasonCode: 'launcher_target_unknown' });
        expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            { machineId: 'machine_1', targetId: 'unavailable-declaration' }))
            .toMatchObject({ status: 'denied', reasonCode: 'machine_admission_required' });
    });

    it('answers a parked inventory watch with only the entries that changed since the held snapshot', async () => {
        const entry = (id: string, port: number, lastSeenAt: number) => ({
            id, machineId: 'machine_1', address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' }, port,
            protocol: 'tcp', detectedAt: 1_000, lastSeenAt, state: 'listening', source: 'detected', labels: [],
            confidence: 'high', processOwnershipConfidence: 'medium', workspaceAssociationConfidence: 'high', diagnostics: [],
        }) as const;
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot({ ...inventorySnapshot,
            entries: [entry('entry-1', 3001, 1_000), entry('entry-2', 3002, 1_000), entry('entry-3', 3003, 1_000)] });
        const held = registry.getSnapshot().generatedAt;
        const { handlers, registrar } = createRegistrar();
        registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesInventory: createLocalServiceInventoryRoutes({ registry }),
        });
        const watch = handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH)!;

        const pending = watch({ machineId: 'machine_1', sinceGeneratedAt: held });
        await Promise.resolve();
        // One material change (entry-2 went stale) and one removal; every scan observation moved.
        registry.replaceSnapshot({ ...inventorySnapshot, generatedAt: 2_000,
            entries: [entry('entry-1', 3001, 2_000), { ...entry('entry-2', 3002, 2_000), state: 'stale' }] });
        const response = DaemonLocalServiceInventoryWatchResponseV1Schema.parse(await pending);

        expect(response).not.toHaveProperty('snapshot');
        expect(response).toMatchObject({ changed: true, delta: {
            baseGeneratedAt: held, generatedAt: registry.getSnapshot().generatedAt, machineId: 'machine_1',
            removedIds: ['entry-3'], upserts: [expect.objectContaining({ id: 'entry-2', state: 'stale' })],
        } });
        expect((response as { delta: { upserts: unknown[] } }).delta.upserts).toHaveLength(1);
        // A caller whose held snapshot the daemon no longer has still receives the whole snapshot.
        const stale = DaemonLocalServiceInventoryWatchResponseV1Schema.parse(await watch({ machineId: 'machine_1', sinceGeneratedAt: held }));
        expect(stale).toMatchObject({ changed: true, snapshot: { entries: [{ id: 'entry-1' }, { id: 'entry-2' }] } });
    });

    it('serves inventory, launcher, and action routes through one daemon-owned registration point', async () => {
        const module = await import('./daemonLocalServices').catch(() => null);

        expect(module?.registerDaemonLocalServicesMachineRpcHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicesMachineRpcHandlers) return;

        const inventoryRoutes = {
            getSnapshot: vi.fn(async () => inventorySnapshot),
            refreshSnapshot: vi.fn(async () => ({ ...inventorySnapshot, generatedAt: 1_500 })),
        };
        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
        };
        const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine_1',
            inventoryRegistry: createLocalServiceInventoryRegistry() });
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesInventory: inventoryRoutes,
            localServicesLauncher: launcherRoutes,
            localServicesActions: actionRoutes,
        });

        expect([...handlers.keys()].sort()).toEqual([
            RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
        ].sort());
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT)?.({
            machineId: 'machine_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot: inventorySnapshot,
        });
        expect(inventoryRoutes.getSnapshot).toHaveBeenCalledOnce();

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)?.({
            machineId: 'machine_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot: { ...inventorySnapshot, generatedAt: 1_500 },
        });
        expect(inventoryRoutes.refreshSnapshot).toHaveBeenCalledOnce();

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)?.({
            machineId: 'machine_1',
            sessionId: 'session_1',
            scope: 'machine',
            workspaceRoot: '/repo/web',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot: launcherSnapshot,
        });
        expect(launcherRoutes.getSnapshot).toHaveBeenCalledOnce();
        expect(launcherRoutes.getSnapshot).toHaveBeenCalledWith({
            sessionId: 'session_1',
            scope: 'machine',
            workspaceRoot: '/repo/web',
        });

        // A raw effect route without the receiving host's policy executor cannot become Start authority.
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START)).toBe(false);
        expect(launcherRoutes.startTarget).not.toHaveBeenCalled();

        const request = {
            requestId: 'request_1',
            target: { kind: 'inventory_entry' as const, inventoryEntryId: 'entry_1', machineId: 'machine_1' },
            action: 'copy_url' as const,
            force: false,
        };
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE)?.(request)).resolves.toMatchObject({
            ok: false,
            errorCode: 'local_service_action_executor_unavailable',
        });
    });

    it('serves the LSV-1 launcher leaf routes (openPreview/registerPreview/history.clear) when leaf routes are available', async () => {
        const module = await import('./daemonLocalServices').catch(() => null);

        expect(module?.registerDaemonLocalServicesMachineRpcHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicesMachineRpcHandlers) return;

        const openPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'opened' as const,
            targetId: 'preview:web',
        };
        const registerPreviewResponse = {
            protocolVersion: 1 as const,
            status: 'registered' as const,
            targetId: 'inventory:entry_1',
            previewId: 'preview_1',
        };
        const historyClearResponse = {
            protocolVersion: 1 as const,
            cleared: 3,
            snapshot: launcherSnapshot,
        };
        const leaves = {
            openPreview: vi.fn(async () => openPreviewResponse),
            registerPreview: vi.fn(async () => registerPreviewResponse),
            clearHistory: vi.fn(async () => historyClearResponse),
        };
        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
            leaves,
        };
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesLauncher: launcherRoutes,
        });

        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW)).toBe(true);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW)).toBe(true);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR)).toBe(true);

        const openPreviewRequest = { machineId: 'machine_1', targetId: 'preview:web', sessionId: 'session_1' };
        await expect(
            handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW)?.(openPreviewRequest),
        ).resolves.toEqual(openPreviewResponse);
        expect(leaves.openPreview).toHaveBeenCalledWith(openPreviewRequest, undefined);

        const registerPreviewRequest = { machineId: 'machine_1', targetId: 'inventory:entry_1' };
        await expect(
            handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW)?.(registerPreviewRequest),
        ).resolves.toEqual(registerPreviewResponse);

        const historyClearRequest = { machineId: 'machine_1' };
        await expect(
            handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR)?.(historyClearRequest),
        ).resolves.toEqual(historyClearResponse);
        expect(leaves.clearHistory).toHaveBeenCalledWith(historyClearRequest, undefined);
    });

    it('omits the LSV-1 launcher leaf routes when no leaf routes are wired', async () => {
        const module = await import('./daemonLocalServices').catch(() => null);

        expect(module?.registerDaemonLocalServicesMachineRpcHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicesMachineRpcHandlers) return;

        const launcherRoutes = {
            getSnapshot: vi.fn(async () => launcherSnapshot),
            startTarget: vi.fn(async () => launcherStartResponse),
        };
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesLauncher: launcherRoutes,
        });

        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW)).toBe(false);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW)).toBe(false);
        expect(handlers.has(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR)).toBe(false);
    });

    it('serves public-preview status/create/revoke routes through the daemon-owned registration point', async () => {
        const module = await import('./daemonLocalServices').catch(() => null);

        expect(module?.registerDaemonLocalServicesMachineRpcHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonLocalServicesMachineRpcHandlers) return;

        const publicPreviewRoutes = {
            getStatus: vi.fn(async () => publicPreviewSnapshot),
            createExposure: vi.fn(async () => ({
                protocolVersion: 1 as const,
                exposure: publicExposure,
                snapshot: publicPreviewSnapshot,
            })),
            revokeExposure: vi.fn(async () => ({
                protocolVersion: 1 as const,
                exposureId: 'public_preview_1',
                revokedAt: 3_100,
                snapshot: {
                    ...publicPreviewSnapshot,
                    exposures: [{ ...publicExposure, state: 'revoked' as const, revokedAt: 3_100 }],
                },
            })),
            copyUrl: vi.fn(async () => ({
                protocolVersion: 1 as const,
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
                publicUrl: 'https://preview.example.test/s/public_preview_1',
            })),
        };
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonLocalServicesMachineRpcHandlers(registrar, {
            localServicesPublicPreview: publicPreviewRoutes,
        } as never);

        expect([...handlers.keys()].sort()).toEqual([
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
            RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
        ].sort());

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS)?.({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            snapshot: publicPreviewSnapshot,
        });
        expect(publicPreviewRoutes.getStatus).toHaveBeenCalledWith({
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
        }, undefined);

        // UX-5: a create request WITHOUT the acknowledged confirmation token must be rejected at this
        // direct RPC chokepoint (no UI-only bypass) and must NOT reach createExposure.
        const unconfirmedCreateRequest = {
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            mode: 'secret_link' as const,
            ttlMs: 600_000,
        };
        await expect(
            handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE)?.(unconfirmedCreateRequest),
        ).rejects.toThrow('local_services_public_preview_confirmation_required');
        expect(publicPreviewRoutes.createExposure).not.toHaveBeenCalled();

        const createRequest = {
            ...unconfirmedCreateRequest,
            confirmation: { acknowledged: true as const },
        };
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE)?.(createRequest)).resolves.toEqual({
            protocolVersion: 1,
            exposure: publicExposure,
            snapshot: publicPreviewSnapshot,
        });
        expect(publicPreviewRoutes.createExposure).toHaveBeenCalledWith(createRequest, undefined);

        const revokeRequest = {
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
        };
        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE)?.(revokeRequest)).resolves.toMatchObject({
            protocolVersion: 1,
            exposureId: 'public_preview_1',
            revokedAt: 3_100,
        });
        expect(publicPreviewRoutes.revokeExposure).toHaveBeenCalledWith(revokeRequest, undefined);

        await expect(handlers.get(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL)?.(revokeRequest)).resolves.toEqual({
            protocolVersion: 1,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            publicUrl: 'https://preview.example.test/s/public_preview_1',
        });
        expect(publicPreviewRoutes.copyUrl).toHaveBeenCalledWith(revokeRequest, undefined);
    });
});
