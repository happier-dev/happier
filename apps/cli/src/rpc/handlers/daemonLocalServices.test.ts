import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';

import { describe, expect, it, vi } from 'vitest';

import type {
    DaemonLocalServiceLauncherStartResponseV1,
    LocalServiceActionResultV1,
    LocalServiceLauncherSnapshotV1,
    LocalServicePublicExposureV1,
    LocalServicePublicPreviewSnapshotV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServicePreviewRegistry } from '@/daemon/local/services/preview/registry';
import { createLocalServiceLauncherFeed } from '@/daemon/local/services/launch/feed';
import { createLocalServiceLauncherRoutes } from '@/daemon/local/services/launch/routes';
import { createLocalServiceActionRoutes } from '@/daemon/local/services/actions/routes';
import { registerDaemonLocalServicesMachineRpcHandlers } from './daemonLocalServices';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { NormalizedLocalServiceInventorySnapshot } from '@/daemon/local/services/inventory/scanner';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { discoverLocalServiceRunTargets } from '@/daemon/local/services/launch/runTargets';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS, type SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { DEFAULT_LOCAL_SERVICE_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/localServiceCapabilities';

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
    it.each([
        RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
        RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
        RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
    ])('refuses foreign requester disclosure of accepted private Workspace provenance through %s', async method => {
        const workspace = { id: 'private-workspace', serverId: 'private-home', machineId: 'machine_1',
            rootPath: process.cwd(), createdAtMs: 1, projectKey: 'private-project' };
        let current = true;
        let now = 1_000;
        let retireDuringScan = false;
        const runtime = createLocalServicesDaemonRuntime({ machineId: workspace.machineId, startLoop: false,
            processEnv: {}, now: () => now,
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
                    processes: new Map([[1234567, { pid: 1234567, cwd: workspace.rootPath, command: 'private-web', processOwnership: 'self' as const }]]),
                    workspaces: [], diagnostics: [] };
            },
        });
        try {
            await runtime.inventoryRoutes.refreshSnapshot();
            const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, localMachineId: workspace.machineId,
                encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                    machineId: workspace.machineId, resolveCustodianAccountId: async () => 'custodian',
                    resolveInstallationId: () => 'installation_1', verifyMachineAdmission: async () => current,
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
            expect(await rpc.handleRequest(request)).toMatchObject(visible);
            expect(await rpc.invokeLocal(method, params)).toMatchObject(visible);
            expect(await rpc.handleRequest({ method: request.method, params })).toMatchObject(visible);
            expect(await rpc.handleRequest({ ...request, machineAdmission: { ...machineAdmission,
                actorAccountId: 'foreign-account', role: 'use' } })).toMatchObject({ error: 'requester_credentials_unavailable' });
            if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                const pending = rpc.handleRequest({ ...request, params: { machineId: workspace.machineId, sinceGeneratedAt: now } });
                await vi.waitFor(() => expect(runtime.inventoryRoutes.watcherCount()).toBe(1));
                current = false;
                now += 1;
                await runtime.inventoryRoutes.refreshSnapshot();
                expect(await pending).toMatchObject({ error: 'requester_credentials_unavailable' });
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
                // Let an actual awaited OS scan outlive the current Home admission.
                now += DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.refreshIntervalMs;
                retireDuringScan = true;
                expect(await rpc.handleRequest(request)).toMatchObject({ error: 'requester_credentials_unavailable' });
            }
        } finally { await runtime.stop(); }
    });

    it.each([undefined, 'managed_bindings'] as const)(
        'refuses foreign requester disclosure of the private accepted Project feed (projection=%s)',
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
                    version: 1, services: { 'private-web': { source: { kind: 'command', command: 'echo private' } } },
                }));
                const workspace = { id: 'private-workspace', serverId: 'private-home', machineId: 'machine_1',
                    rootPath: root, createdAtMs: 1, projectKey: 'private-project' };
                const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'private-web' } };
                const handle = await owner.superviseProject({
                    workspace, declaration, cwd: root, serviceId: 'private-native-service', specIdentity: 'private-native-effect',
                    requester: { serverId: workspace.serverId, accountId: 'custodian', machineId: workspace.machineId,
                        installationId: 'installation_1' }, isCurrent: () => true,
                    processSpec: { startupTimeoutMs: 1_000, mode: { kind: 'native',
                        instance: { adapter: { pluginId: 'private-native', localId: 'web' }, nativeResourceId: 'private-resource' },
                        // Native inspection and termination are external IO; all owner/feed logic remains real.
                        lifecycle: { inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: 'http://127.0.0.1:43170' }),
                            stop: async () => ({ status: 'stopped' }) },
                    } },
                    authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({ signal, assertCurrent() {},
                        projectLaunch: { status: 'ready', reviewedEffectDigest: 'private-native-effect', environment: {
                            selection: { kind: 'host' }, root, platform: process.platform,
                            io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
                        } }, launch: { command: process.execPath, args: [], cwd: root, env: {} },
                    }),
                });
                const runTargets = await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [workspace] });
                const acceptedDeclaration = runTargets.find(target => 'declaration' in target
                    && target.declaration.selection.kind === 'manifest' && target.declaration.selection.name === 'private-web');
                if (!acceptedDeclaration) throw new Error('The accepted private Project fixture did not produce its declaration');
                const feed = createLocalServiceLauncherFeed({ machineId: workspace.machineId,
                    inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry(),
                    projectManagedServices: owner,
                    runTargets,
                });
                let current = true;
                const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, localMachineId: workspace.machineId,
                    encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                        machineId: workspace.machineId, resolveCustodianAccountId: async () => 'custodian',
                        resolveInstallationId: () => 'installation_1',
                        // Only the current Home admission network boundary is substituted.
                        verifyMachineAdmission: async () => current,
                    }) });
                const boundCredential = { accountId: 'custodian' };
                registerDaemonLocalServicesMachineRpcHandlers(rpc, { ...boundCredential,
                    machineId: workspace.machineId, serverId: workspace.serverId,
                    localServicesLauncher: createLocalServiceLauncherRoutes({ feed }),
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
                expect(await rpc.handleRequest(request)).toMatchObject(visible);
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, params)).toMatchObject(visible);
                expect(await rpc.handleRequest({ method: request.method, params })).toMatchObject(visible);
                current = false;
                expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
                current = true;
                expect(await rpc.handleRequest({ ...request, machineAdmission: { ...machineAdmission,
                    actorAccountId: 'foreign-account', role: 'use' } })).toMatchObject({ error: 'requester_credentials_unavailable' });
            } finally {
                await owner.dispose();
                await rm(root, { recursive: true, force: true });
            }
        },
    );

    it('keeps a host-admitted Agent launcher start waiting on its canonical approval artifact until an actual decision', async () => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine_1', localMachineId: 'machine_1',
            encryptionMode: 'plain', logger: () => {} });
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
        let approvalAction: string | undefined;
        let decide!: () => void;
        const decision = new Promise<void>(resolve => { decide = resolve; });
        let awaitingDecision = false;
        registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: 'machine_1', localServicesLauncher: launcher,
            resolveLauncherActionExecutor: ({ ingress }) => {
                const executor = createActionExecutor({
                isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId,
                    normalizeActionsSettingsV1(null), { surface: context.surface ?? null, authority: context.authority }),
                // Artifact persistence is the external Account boundary. Policy and dispatch remain real.
                approvalsCreate: async ({ request }) => {
                    approvalAction = request.actionId;
                    return { artifactId: 'service-start-approval' };
                },
                approvalsUpdate: async () => {},
                approvalsWaitForDecision: async ({ request }) => {
                    awaitingDecision = true;
                    await decision;
                    return { decision: 'reject' as const, request, decisionAuthority: 'present_user' as const };
                },
                runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({
                    featureGate: gate, ingress, routes: { launcherRoutes: launcher },
                }),
                });
                // The actual receiving credential factory binds this Home, not Action input.
                return { execute: (actionId, input, context) => executor.execute(actionId, input, { serverId: 'home-a', ...context }) };
            },
        });
        let settled = false;
        const pending = rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            { machineId: 'machine_1', targetId: 'unavailable-declaration' },
            { localActionContext: { surface: 'agent', authority: 'account_automation', actionRequestId: 'service-approval-request' } })
            .finally(() => { settled = true; });
        await vi.waitFor(() => expect(awaitingDecision).toBe(true));
        expect(approvalAction).toBe('localServices.launcher.start');
        expect(settled).toBe(false);
        decide();
        expect(await pending).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    });
    it.each(['direct', 'action'] as const)('preserves receiving Machine admission through asynchronous %s launcher resolution', async ingressKind => {
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
        const feed = createLocalServiceLauncherFeed({
            machineId: 'machine_1', inventoryRegistry: createLocalServiceInventoryRegistry(),
            previewRegistry: createLocalServicePreviewRegistry(),
        });
        const launcher = createLocalServiceLauncherRoutes({
            feed,
            async resolveStartTarget(_request, ingress?: RpcHandlerContext) {
                if (!ingress?.machineAdmission || !ingress.verifyMachineAdmissionCurrent) {
                    return { ok: false, reasonCode: 'machine_admission_required' } as const;
                }
                await Promise.resolve();
                current = false;
                return { ok: false, reasonCode: await ingress.verifyMachineAdmissionCurrent()
                    ? 'launcher_target_unknown' : 'machine_admission_changed' } as const;
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
                    return { execute: async (actionId, input, context = {}) => ({ ok: true,
                        result: await execute({ actionId, input, context }),
                    }) };
                };
        if (ingressKind === 'direct') registerDaemonLocalServicesMachineRpcHandlers(rpc, {
            machineId: 'machine_1', localServicesLauncher: launcher, resolveLauncherActionExecutor: resolveActionExecutor,
        });
        else registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['localServices.launcher.start'],
            targetMachineId: 'machine_1', defaultMachineTarget: true, resolveActionExecutor });

        expect(await rpc.handleRequest({
            method: `machine_1:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START}`,
            params: { machineId: 'machine_1', targetId: 'unavailable-declaration' },
            machineAdmission,
        })).toMatchObject({ status: 'denied', reasonCode: 'machine_admission_changed' });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            { machineId: 'machine_1', targetId: 'unavailable-declaration' }))
            .toMatchObject({ status: 'denied', reasonCode: 'machine_admission_required' });
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
        expect(leaves.clearHistory).toHaveBeenCalledWith(historyClearRequest);
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
