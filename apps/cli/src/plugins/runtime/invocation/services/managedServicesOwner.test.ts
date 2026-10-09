import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';

import { PROVIDER_WIRE_PROTOCOL_LIMITS_V1 } from '@happier-dev/protocol/providers/capabilities/v1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { PluginError } from '@happier-dev/plugin-sdk';

import type {
    ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    ManagedServiceHandle,
    ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import type {
    ExecService,
    PluginProcessHandle,
    PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';

import type {
    ManagedServiceProcessHandle,
    ManagedServiceProcessSupervisor,
    ManagedServiceProcessSupervisorHost,
} from './managedProcessSupervisor';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import type {
    ManagedProviderRuntimeInvocationBinding,
    ManagedProviderRequestAuthCapabilityPathBinding,
    ManagedServiceCredentialFileOwner,
} from './managedServicesAdapter';
import { createManagedServicesOwner, type ProjectManagedServiceSupervisionInput } from './managedServicesOwner';
import { createLocalServiceActionRoutes } from '@/daemon/local/services/actions/routes';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { createLocalServiceInventoryRegistry } from '@/daemon/local/services/inventory/registry';
import { createLocalServicePreviewRegistry, registerLocalServicePreview } from '@/daemon/local/services/preview/registry';
import { createLocalServiceLauncherFeed } from '@/daemon/local/services/launch/feed';
import { createLocalServiceLauncherHistoryStore, createLocalServiceLauncherLeafRoutes } from '@/daemon/local/services/launch/leaves';
import { createLocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import { registerDaemonLocalServicePreviewSnapshotHandler } from '@/rpc/handlers/daemonLocalServicePreviewSnapshot';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createRunnerManagedServiceEndpointProjectionBinding } from './createRunnerManagedServiceInvocationOwner';
import { createProviderCliAttachSurface } from '@/session/attach/providerCliAttach';
import {
    resolveOpenCodeAttachTarget,
    createOpenCodeAttachArgs,
} from '../../../../../../../packages/plugins/opencode/src/agent/surfaces/sessions/attach/descriptor';
import {
    createManagedServiceEndpointProjectionV1,
} from './managedServiceEndpointProjection';
import { createStablePluginEventsBroker } from './events';
import {
    authorizeResolvedProjectExecLaunchForHost,
    createProjectNativeEnvironmentIoForHost,
    createStablePluginExecService,
} from './exec';
import { associateSupervisedPluginProcessHandleForHost, readSupervisedPluginProcessIdForHost } from '../../exec/processSupervisor';
import * as processTreeBoundary from '@/agent/runtime/process/killProcessTree';
import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createPluginInvocationServicesFactory,
} from './factory';
import { withPluginInvocationServiceBindingAvailability } from './unavailable';

type CredentialFileMaterializeInput = Parameters<
    ManagedServiceCredentialFileOwner['materialize']
>[0];

const exec = Object.freeze({}) as ExecService;

const MANAGED_SERVICE_CLEAN_EXIT: PluginProcessResult = Object.freeze({
    termination: Object.freeze({
        observed: Object.freeze({ kind: 'exit', exitCode: 0 }),
        requestedBy: Object.freeze({ kind: 'none' }),
    }),
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    stdoutTruncated: false,
    stderrTruncated: false,
});

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return Object.freeze({ promise, resolve });
}

function explicitStartOutcome(cleanup: () => void | Promise<void> = () => {}) {
    return Object.freeze({
        status: 'running' as const,
        projection: Object.freeze({
            access: Object.freeze({
                endpointUrl: () => 'http://127.0.0.1:43120/v1',
                request: async () => Object.freeze({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: Object.freeze({}),
                    body: null,
                }),
            }),
            isCurrent: () => true,
            cleanup,
        }),
    });
}

function createLifecycleProcess(
    pid: number,
    onDispose?: () => void | Promise<void>,
): PluginProcessHandle & Readonly<{
    dispose: ReturnType<typeof vi.fn>;
}> {
    const exit = deferred<PluginProcessResult>();
    const dispose = vi.fn(async () => {
        await onDispose?.();
        exit.resolve(MANAGED_SERVICE_CLEAN_EXIT);
    });
    const process = Object.freeze({
        write: vi.fn(async () => undefined),
        closeStdin: vi.fn(async () => undefined),
        wait: vi.fn(async () => await exit.promise),
        onOutput: vi.fn(() => Object.freeze({ dispose() {} })),
        dispose,
    });
    associateSupervisedPluginProcessHandleForHost(process, { pid });
    return process;
}

function createLifecycleExec(
    processes: PluginProcessHandle[],
): ExecService & Readonly<{
    spawn: ReturnType<typeof vi.fn>;
}> {
    const spawn = vi.fn(async () => (
        processes.shift() ?? createLifecycleProcess(9_999)
    ));
    return Object.freeze({
        spawn,
        run: vi.fn(async () => MANAGED_SERVICE_CLEAN_EXIT),
    }) as unknown as ExecService & Readonly<{
        spawn: ReturnType<typeof vi.fn>;
    }>;
}

function lifecycleSpec(input: Readonly<{
    id: string;
    port?: number;
    args?: readonly string[];
    environment?: Readonly<Record<string, string>>;
}>): Extract<ManagedServiceSpec, { mode: Readonly<{ kind: 'spawn' }> }> {
    return Object.freeze({
        id: input.id,
        mode: Object.freeze({
            kind: 'spawn' as const,
            launch: Object.freeze({
                executable: {} as never,
                ...(input.args ? { args: input.args } : {}),
                ...(input.environment
                    ? { env: input.environment }
                    : {}),
            }),
            endpoint: Object.freeze({
                kind: 'assignAndInject' as const,
                port: input.port === undefined
                    ? Object.freeze({ kind: 'allocated' as const })
                    : Object.freeze({
                        kind: 'fixed' as const,
                        port: input.port,
                    }),
            }),
        }),
        healthCheck: Object.freeze({ kind: 'none' as const }),
    });
}

function lifecycleScope(input: Readonly<{
    occurrenceId: string;
    contributionQualifiedId?: string;
    sessionId?: string;
    operationId?: string;
    signal?: AbortSignal;
    isOccurrenceCurrent?: () => boolean;
}>) {
    return Object.freeze({
        occurrenceId: input.occurrenceId,
        pluginId: 'acme.providers',
        contributionQualifiedId: input.contributionQualifiedId
            ?? 'acme.providers/providers/gateway',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        isOccurrenceCurrent:
            input.isOccurrenceCurrent ?? (() => true),
    });
}

function createLifecycleHarness(
    processes: PluginProcessHandle[] = [],
    custodyOwner: 'daemon' | 'sessionRunner' = 'sessionRunner',
    boundaryOptions: Pick<Parameters<typeof createManagedServicesOwner>[0], 'fetch' | 'registerRawForRedaction' | 'resolveNativeLifecycle'> = {},
) {
    let nextInstance = 0;
    const processSupervisorHost = createManagedServiceProcessSupervisorHost({
        custodyOwner,
        createInstanceId: () => `owner-lifecycle-${++nextInstance}`,
        ...(custodyOwner === 'sessionRunner'
            ? {
                authorizeRunnerSupervision: async (request) => (
                    request.mode === 'managedSpawn'
                        ? Object.freeze({
                            mode: 'managedSpawn' as const,
                            launch: Object.freeze({
                                kind: 'daemonResolved' as const,
                                value: Object.freeze({
                                    command: '/managed/lifecycle-fixture',
                                }),
                            }),
                        })
                        : Object.freeze({
                            mode: 'externalAttach' as const,
                        })
                ),
                installPreauthorizedSpawn: () =>
                    Object.freeze({ dispose() {} }),
                captureProcessStartIdentity: async () =>
                    'owner-lifecycle-process-start',
            }
            : {}),
    });
    const owner = createManagedServicesOwner({
        ...boundaryOptions,
        processSupervisorHost,
        dependencies: Object.freeze({}) as never,
        resolveScope: (scope) => scope,
    });
    return Object.freeze({
        exec: createLifecycleExec(processes),
        owner,
    });
}

function createConnectedAccounts(
    materialize: ConnectedAccountsService['materialize'],
): ConnectedAccountsService {
    return Object.freeze({
        getBinding: vi.fn(),
        requestSelection: vi.fn(),
        materialize,
        listAccounts: async () => {
            throw new Error('Connected Account listing is outside this fixture');
        },
        materializeListedAccount: async () => {
            throw new Error('Exact-listed Connected Account materialization is outside this fixture');
        },
        watch: vi.fn(() => Object.freeze({ dispose() {} })),
    });
}

function createHarness(
    hostFetch?: typeof globalThis.fetch,
    registerRawForRedaction: (input: Readonly<{
        occurrenceId: string;
        pluginId: string;
        contributionQualifiedId: string;
        sessionId?: string;
        operationId?: string;
    }>, value: string) => void = vi.fn(),
    custodyOwner: 'daemon' | 'sessionRunner' = 'sessionRunner',
) {
    const legacySnapshot = Object.freeze({
        id: 'gateway',
        instanceId: 'instance-one',
        state: 'healthy' as const,
        mode: 'managedSpawn' as const,
        baseUrl: 'http://127.0.0.1:4312',
        port: 4312,
        pid: 12,
        startedAtMs: 1,
        lastHealthyAtMs: 10,
        diagnostics: Object.freeze([]),
        diagnosticsTruncated: false,
    });
    let currentSnapshot: ReturnType<ManagedServiceProcessHandle['snapshot']> =
        legacySnapshot;
    const stop = vi.fn<ManagedServiceProcessHandle['stop']>(
        async () => Object.freeze({ status: 'stopped' as const }),
    );
    const legacyHandle = Object.freeze({
        snapshot: () => currentSnapshot,
        observe: vi.fn(() => Object.freeze({ dispose() {} })),
        waitUntilHealthy: vi.fn(async () => legacySnapshot),
        stop,
        dispose: vi.fn(async () => undefined),
    }) satisfies ManagedServiceProcessHandle;
    const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>(
        async () => legacyHandle,
    );
    const owner = createManagedServicesOwner({
        processSupervisorHost: Object.freeze({
            custodyOwner,
            bind: vi.fn(() => Object.freeze({ supervise })),
        }),
        dependencies: Object.freeze({}) as never,
        resolveScope: (scope) => scope,
        ...(hostFetch ? { fetch: hostFetch } : {}),
        registerRawForRedaction,
    });
    const authorization = { current: true };
    const scope = {
        occurrenceId: 'provider-p',
        pluginId: 'acme.providers',
        contributionQualifiedId:
            'acme.providers/providers/gateway',
        sessionId: 'session-one',
        signal: new AbortController().signal,
        isOccurrenceCurrent: () => authorization.current,
    };
    return {
        authorization,
        legacyHandle,
        owner,
        scope,
        supervise,
        registerRawForRedaction,
        moveHealthyEndpoint(
            baseUrl: string,
            port: number,
            startedAtMs: number | null = legacySnapshot.startedAtMs,
        ) {
            currentSnapshot = Object.freeze({
                ...legacySnapshot,
                baseUrl,
                port,
                startedAtMs,
            });
        },
    };
}

function createManagedProviderBinding(
    isCurrent: () => boolean = () => true,
    requestAuth: ManagedProviderRequestAuthCapabilityPathBinding | null = null,
): ManagedProviderRuntimeInvocationBinding {
    return Object.freeze({
        realm: 'managedProviderStart' as const,
        providerLocalId: 'gateway',
        requestAuth,
        isCurrent,
    });
}

function createProjectLifecycleInput(options: Readonly<{
    isCurrent?: () => boolean;
    signal?: AbortSignal;
}> = {}): ProjectManagedServiceSupervisionInput {
    const isCurrent = options.isCurrent ?? (() => true);
    const workspace = {
        id: 'workspace-one', serverId: 'server-one', machineId: 'machine-one',
        rootPath: process.cwd(), createdAtMs: 1,
    };
    const declaration = {
        workspaceRefId: workspace.id,
        selection: { kind: 'manifest' as const, name: 'worker' },
    };
    const requester = {
        serverId: workspace.serverId, accountId: 'requester-one',
        machineId: workspace.machineId, installationId: 'installation-one',
    };
    return {
        workspace, declaration, requester, cwd: workspace.rootPath,
        serviceId: 'project:workspace-one:manifest:worker',
        specIdentity: 'reviewed-worker-effect',
        ...(options.signal ? { signal: options.signal } : {}),
        isCurrent,
        processSpec: {
            mode: { kind: 'managedSpawn', endpointNone: true },
            startupTimeoutMs: 1_000,
        },
        authorizeLaunch: ({ signal }) =>
            authorizeResolvedProjectExecLaunchForHost({
                signal,
                assertCurrent() {
                    if (!isCurrent()) {
                        throw new PluginError({
                            code: 'plugin_managed_service_unavailable',
                            message: 'Project authority retired',
                        });
                    }
                },
                projectLaunch: {
                    status: 'ready', reviewedEffectDigest: 'reviewed-worker-effect',
                    environment: {
                        selection: { kind: 'host' }, root: workspace.rootPath,
                        platform: process.platform,
                        io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
                    },
                },
                launch: {
                    command: process.execPath,
                    args: ['-e', 'setInterval(() => {}, 1000)'],
                    cwd: workspace.rootPath, env: {}, release() {},
                },
            }),
    };
}

describe('managed-services SVC09 owner', () => {
    it('awaits the real final launch capture when Project access retires before tuple handoff', async () => {
        const { owner } = createLifecycleHarness([], 'daemon');
        let admitted = true;
        const input = createProjectLifecycleInput({ isCurrent: () => admitted });
        const executable = { kind: 'systemTool', id: 'fixture.native-helper' } as const;
        const helper = await createStablePluginExecService({ allowedExecutables: [executable], signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: process.execPath }),
            resolvePath: async () => input.cwd }).spawn({ executable, args: ['-e', 'setInterval(()=>{},1000)'] });
        const pid = readSupervisedPluginProcessIdForHost(helper);
        if (!pid) throw new Error('Expected an actual captured native helper');
        const settlement = deferred<void>();
        let cleanupStarted = false;
        let establishmentFinished = false;
        const terminate = processTreeBoundary.killProcessTree;
        const boundary = vi.spyOn(processTreeBoundary, 'killProcessTree').mockImplementation(async (...args) => {
            if (args[0].pid === pid) { cleanupStarted = true; await settlement.promise; }
            await terminate(...args);
        });
        const establishment = owner.superviseProject({ ...input, authorizeLaunch: async ({ signal }) => {
            const launch = await authorizeResolvedProjectExecLaunchForHost({ signal, assertCurrent() {},
                projectLaunch: { status: 'ready', reviewedEffectDigest: input.specIdentity,
                    environment: { selection: { kind: 'host' }, root: input.cwd, platform: process.platform,
                        io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }) } },
                launch: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: input.cwd, env: {} } });
            // Current requester access changes after the real final authorizer
            // returned, before the owner can hand that tuple to its supervisor.
            admitted = false;
            // Match the Service starter's retained final-capture composition:
            // this is genuine Exec disposal, not a mocked release or terminator.
            return { ...launch, async release() { await launch.release(); await helper.dispose(); } };
        } });
        const observed = establishment.then(() => { establishmentFinished = true; }, error => { establishmentFinished = true; return error; });
        try {
            await vi.waitFor(() => expect(cleanupStarted).toBe(true));
            expect(process.kill(pid, 0)).toBe(true);
            expect(establishmentFinished).toBe(false);
            expect(owner.readRetainedSemanticCustodyCount()).toBeGreaterThan(0);
            settlement.resolve();
            expect(await observed).toBeInstanceOf(Error);
            expect(() => process.kill(pid, 0)).toThrow();
            expect(owner.listProjectServices()).toEqual([]);
            expect(owner.readRetainedSemanticCustodyCount()).toBe(0);
        } finally {
            settlement.resolve();
            boundary.mockRestore();
            await helper.dispose();
            await observed;
            await owner.dispose();
        }
    });

    it('rechecks authenticated access loss after establishment before stopping an exact native service', async () => {
        const { owner } = createLifecycleHarness([], 'daemon');
        const input = createProjectLifecycleInput();
        let stopped = false;
        // Native resource inspection and termination are external boundaries.
        const handle = await owner.superviseProject({ ...input, processSpec: { ...input.processSpec,
            mode: { kind: 'native', instance: { adapter: { pluginId: 'native', localId: 'worker' },
                nativeResourceId: 'exact-resource' }, lifecycle: {
                inspect: async () => ({ phase: stopped ? 'stopped' : 'running', readiness: 'not_reported', endpoint: null }),
                stop: async () => { stopped = true; return { status: 'stopped' }; },
            } },
        } });
        try {
            expect(await owner.stopForAccessLoss(input.requester, { verifyCurrentMachineAdmission: async () => false }))
                .toMatchObject([{ status: 'termination_incomplete', instanceId: handle.instanceId }]);
            expect(handle.retirementSignal.aborted).toBe(false);
            let checks = 0;
            expect(await owner.stopForAccessLoss(input.requester, { verifyCurrentMachineAdmission: async () => ++checks === 1 }))
                .toMatchObject([{ status: 'termination_incomplete', instanceId: handle.instanceId }]);
            expect(stopped).toBe(false);
            expect(handle.snapshot().state).toBe('running');
            expect(await owner.stopForAccessLoss(input.requester, { verifyCurrentMachineAdmission: async () => true }))
                .toMatchObject([{ status: 'stopped', instanceId: handle.instanceId }]);
            expect(stopped).toBe(true);
        } finally { await owner.dispose(); }
    });
    it('projects material Project service preparation and real lifetime without a public port', async () => {
        const { owner } = createLifecycleHarness([], 'daemon');
        const input = createProjectLifecycleInput();
        const inspected = deferred<void>();
        let stopped = false;
        const edges: unknown[] = [];
        const unsubscribe = owner.activity.subscribe(() => edges.push(owner.activity.read()));
        const establishment = owner.superviseProject({ ...input, processSpec: { ...input.processSpec,
            mode: { kind: 'native', instance: { adapter: { pluginId: 'native', localId: 'worker' },
                nativeResourceId: 'exact-resource' }, lifecycle: {
                inspect: async () => { await inspected.promise; return { phase: stopped ? 'stopped' : 'running', readiness: 'not_reported', endpoint: null }; },
                stop: async () => { stopped = true; return { status: 'stopped' }; },
            } },
        } });
        try {
            expect(owner.activity.read()).toMatchObject({ coverage: 'complete', items: [
                { category: 'service', attribution: input.requester, state: 'active' },
            ] });
            inspected.resolve();
            const handle = await establishment;
            expect(handle.snapshot().baseUrl).toBeNull();
            expect(owner.activity.read()).toMatchObject({ coverage: 'complete', items: [
                { category: 'service', ownerRef: handle.instanceId, state: 'active' },
            ] });
            await handle.stop();
            expect(owner.activity.read()).toEqual({ coverage: 'complete', items: [] });
            expect(edges).toContainEqual({ coverage: 'complete', items: [] });
        } finally {
            inspected.resolve();
            unsubscribe();
            await establishment.catch(() => undefined);
            await owner.dispose();
        }
    });

    it('retains an admitted Project service in the same custody owner independently of its joined caller', async () => {
        const { owner } = createLifecycleHarness([], 'daemon');
        let admitted = true;
        const caller = new AbortController();
        const input = createProjectLifecycleInput({ isCurrent: () => admitted, signal: caller.signal });
        const { workspace, declaration, requester } = input;
        try {
            const handle = await owner.superviseProject(input);
            expect(handle).toMatchObject({
                instanceId: 'owner-lifecycle-1', serviceId: input.serviceId,
                workspace, declaration, requester, cwd: workspace.rootPath,
            });
            expect(handle.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
            const target = {
                kind: 'managed_service' as const,
                managedServiceId: handle.instanceId,
                machineId: workspace.machineId,
                declaration,
                cwd: workspace.rootPath,
            };
            expect(owner.listProjectServices()).toEqual([handle]);
            expect(owner.resolveProjectService(target)).toEqual({ status: 'found', handle });
            expect(owner.resolveProjectService({ ...target, managedServiceId: input.serviceId })).toEqual({ status: 'unknown' });
            expect(owner.resolveProjectService({ ...target, machineId: 'other-machine' })).toEqual({ status: 'mismatch' });
            expect(owner.resolveProjectService({ ...target, cwd: `${workspace.rootPath}/other` })).toEqual({ status: 'mismatch' });
            expect(owner.resolveProjectService({ ...target, declaration: undefined })).toEqual({ status: 'mismatch' });
            expect(owner.resolveProjectService({ ...target, declaration: {
                ...declaration, selection: { kind: 'manifest', name: 'other' },
            } })).toEqual({ status: 'mismatch' });
            await expect(owner.superviseProject({ ...input, specIdentity: 'different-reviewed-effect' }))
                .rejects.toMatchObject({ code: 'plugin_managed_service_spec_conflict' });
            caller.abort();
            expect(await owner.superviseProject({ ...input, signal: undefined })).toBe(handle);
            expect(owner.readRetainedSemanticCustodyCount()).toBe(1);
            for (const field of ['serverId', 'accountId', 'machineId', 'installationId'] as const) {
                expect(await owner.stopForAccessLoss({ ...requester, [field]: 'other' })).toEqual([]);
                expect(handle.snapshot().state).toBe('running');
            }
            admitted = false;
            expect(await owner.stopForAccessLoss(requester)).toMatchObject([
                { status: 'stopped', instanceId: handle.instanceId, requester, serviceId: input.serviceId },
            ]);
            expect(handle.snapshot().state).toBe('stopped');
            expect(owner.readRetainedSemanticCustodyCount()).toBe(0);
            expect(owner.resolveProjectService(target)).toEqual({ status: 'unknown' });
        } finally {
            await owner.dispose();
        }
    });

    it('revokes Project serving immediately while retaining uncertain exact native custody', async () => {
        const { owner } = createLifecycleHarness([], 'daemon');
        const input = createProjectLifecycleInput();
        const endpoint = 'http://127.0.0.1:43170';
        let stoppable = false;
        const instance = {
            adapter: { pluginId: 'acme.native', localId: 'compose' },
            nativeResourceId: 'exact-project-resource',
        };
        // Native resource inspection and termination are genuine external IO.
        const handle = await owner.superviseProject({
            ...input,
            processSpec: {
                ...input.processSpec,
                mode: {
                    kind: 'native',
                    instance,
                    lifecycle: {
                        inspect: async observed => {
                            expect(observed).toEqual(instance);
                            return { phase: 'running', readiness: 'not_reported', endpoint };
                        },
                        stop: async observed => {
                            expect(observed).toEqual(instance);
                            return { status: stoppable ? 'stopped' : 'unsupported' };
                        },
                    },
                },
            },
        });
        try {
            const inventoryRegistry = createLocalServiceInventoryRegistry();
            const feed = createLocalServiceLauncherFeed({
                machineId: input.workspace.machineId,
                inventoryRegistry,
                previewRegistry: createLocalServicePreviewRegistry(),
                projectManagedServices: owner,
            });
            expect((await feed.getSnapshot()).targets[0]?.endpointUrl).toBe(endpoint);
            const result = await owner.stopForAccessLoss(input.requester);
            expect(result).toMatchObject([{
                status: 'unsupported', instanceId: handle.instanceId,
                snapshot: { mode: 'native', state: 'running' },
            }]);
            expect(handle.retirementSignal.aborted).toBe(true);
            expect(handle.isCurrent()).toBe(false);
            expect(owner.listProjectServices()).toEqual([handle]);
            expect(owner.readRetainedSemanticCustodyCount()).toBe(1);
            expect(owner.activity.read()).toMatchObject({ coverage: 'complete', items: [
                { category: 'service', ownerRef: handle.instanceId, state: 'active', attribution: input.requester },
            ] });
            await expect(handle.request({ pathAndQuery: '/' })).rejects
                .toMatchObject({ code: 'plugin_managed_service_unavailable' });
            const retainedTarget = (await feed.getSnapshot()).targets[0];
            expect(retainedTarget).toMatchObject({
                source: 'managed_service',
                serviceState: 'running',
                sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId },
            });
            expect(retainedTarget?.endpointUrl).toBeUndefined();
            expect(retainedTarget?.actions).toEqual(['manage']);
            stoppable = true;
            // The protected Machine Action path retains exact-instance Stop
            // custody even though serving and requester access have retired.
            const routes = createLocalServiceActionRoutes({
                machineId: input.workspace.machineId,
                inventoryRegistry,
                projectManagedServices: owner,
                verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request),
            });
            const request = {
                requestId: 'retained-native-stop',
                target: {
                    kind: 'managed_service' as const,
                    machineId: input.workspace.machineId,
                    managedServiceId: handle.instanceId,
                    workspaceId: input.workspace.id,
                    declaration: input.declaration,
                    cwd: input.cwd,
                },
                action: 'stop_managed' as const,
                force: false,
            };
            expect(await routes.execute({
                ...request,
                confirmationNonce: createLocalServiceActionConfirmationNonceV1(request),
            })).toMatchObject({ status: 'succeeded' });
            expect(handle.snapshot().state).toBe('stopped');
            expect(owner.listProjectServices()).toEqual([]);
            expect(owner.readRetainedSemanticCustodyCount()).toBe(0);
        } finally {
            stoppable = true;
            await owner.dispose();
        }
    });

    it.each([true, false])('does not report acquired native preparation as unstarted cancellation (stoppable=%s)', async (initiallyStoppable) => {
        const { owner } = createLifecycleHarness([], 'daemon');
        const input = createProjectLifecycleInput();
        const inspection = deferred<void>();
        let inspecting = false;
        let stoppable = initiallyStoppable;
        const establishment = owner.superviseProject({
            ...input,
            processSpec: {
                ...input.processSpec,
                mode: {
                    kind: 'native',
                    instance: {
                        adapter: { pluginId: 'acme.native', localId: 'compose' },
                        nativeResourceId: 'acquired-before-initial-inspection',
                    },
                    // Delay only the genuine native inspection IO, not the owner.
                    lifecycle: {
                        inspect: async () => {
                            inspecting = true;
                            await inspection.promise;
                            return { phase: 'running', readiness: 'not_reported', endpoint: null };
                        },
                        stop: async () => ({ status: stoppable ? 'stopped' : 'unsupported' }),
                    },
                },
            },
        });
        const failedEstablishment = establishment.catch(error => error);
        try {
            await vi.waitFor(() => expect(inspecting).toBe(true));
            const feed = createLocalServiceLauncherFeed({ machineId: input.workspace.machineId,
                inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry(),
                projectManagedServices: owner });
            const bindingRead = { projection: 'managed_bindings' as const, workspaceRoot: input.workspace.rootPath };
            expect((await feed.getSnapshot({ ...bindingRead, workspaceRoot: '/unrelated-workspace' })).targets).toEqual([]);
            await expect(feed.getSnapshot(bindingRead)).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
            const loss = owner.stopForAccessLoss(input.requester);
            inspection.resolve();
            await failedEstablishment;
            expect(await loss).toMatchObject([{
                status: initiallyStoppable ? 'stopped' : 'termination_incomplete',
                instanceId: 'owner-lifecycle-1',
            }]);
            expect(owner.readRetainedSemanticCustodyCount()).toBe(initiallyStoppable ? 0 : 1);
            if (initiallyStoppable) expect((await feed.getSnapshot(bindingRead)).targets).toEqual([]);
            else await expect(feed.getSnapshot(bindingRead)).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
        } finally {
            inspection.resolve();
            stoppable = true;
            await owner.stopForAccessLoss(input.requester);
            await owner.dispose();
        }
    });

    it.skipIf(process.platform !== 'linux')('settles access loss as cancelled preparation only before process custody exists', async () => {
        const { owner } = createLifecycleHarness([], 'daemon');
        const input = createProjectLifecycleInput();
        const toolResolution = deferred<void>();
        let resolving = false;
        const establishment = owner.superviseProject({
            ...input,
            authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
                signal,
                assertCurrent() {},
                projectLaunch: {
                    status: 'ready', reviewedEffectDigest: input.specIdentity,
                    environment: {
                        selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
                        root: input.cwd,
                        platform: 'linux',
                        io: createProjectNativeEnvironmentIoForHost({
                            // Suspend only installed-tool resolution, a genuine OS boundary.
                            resolveTool: async () => {
                                resolving = true;
                                await toolResolution.promise;
                                return null;
                            },
                        }),
                    },
                },
                launch: {
                    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
                    cwd: input.cwd, env: {}, release() {},
                },
            }),
        });
        const failedEstablishment = establishment.catch(error => error);
        try {
            await vi.waitFor(() => expect(resolving).toBe(true));
            const loss = owner.stopForAccessLoss(input.requester);
            toolResolution.resolve();
            await failedEstablishment;
            expect(await loss).toMatchObject([{
                status: 'cancelled_preparation', instanceId: null,
                requester: input.requester,
            }]);
            expect(owner.listProjectServices()).toEqual([]);
            expect(owner.readRetainedSemanticCustodyCount()).toBe(0);
        } finally {
            toolResolution.resolve();
            await owner.dispose();
        }
    });

    it('supervises a URL-less worker through the public owner and refuses HTTP-only operations', async () => {
        const { owner, exec: lifecycleExec } = createLifecycleHarness([createLifecycleProcess(77)], 'daemon');
        const services = owner.bindScope(lifecycleScope({ occurrenceId: 'worker' }), lifecycleExec);
        const handle = await services.supervise({
            id: 'worker',
            mode: { kind: 'spawn', launch: { executable: { kind: 'systemTool', id: 'fixture.server' } }, endpoint: { kind: 'none' } },
        });
        expect(handle.snapshot()).toMatchObject({ state: 'running', mode: 'spawn', baseUrl: null, lastHealthyAtMs: null });
        await expect(handle.request({ pathAndQuery: '/health' })).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
        await expect(handle.waitUntilHealthy()).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
        expect(await handle.stop()).toEqual({ status: 'stopped' });
        expect(handle.snapshot().state).toBe('stopped');
        await owner.dispose();
    });

    it('refuses a native start without a currently declared lifecycle before spawning', async () => {
        const { owner, exec: lifecycleExec } = createLifecycleHarness([], 'daemon');
        const services = owner.bindScope(lifecycleScope({ occurrenceId: 'native' }), lifecycleExec);
        await expect(services.supervise({
            id: 'compose',
            mode: { kind: 'native', launch: { executable: { kind: 'systemTool', id: 'fixture.server' } },
                instance: { adapter: { pluginId: 'acme.providers', localId: 'compose' }, nativeResourceId: 'exact-project' } },
        })).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
        expect(lifecycleExec.spawn).not.toHaveBeenCalled();
        await owner.dispose();
    });

    it('keeps a native owner binding when stop is unsupported and permits the exact later stopped witness', async () => {
        let stoppable = false;
        const { owner, exec: lifecycleExec } = createLifecycleHarness([createLifecycleProcess(78)], 'daemon', {
            // Native inspection/control is an OS/tool boundary; the owner and supervisor remain real.
            resolveNativeLifecycle: async () => ({
                inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }),
                stop: async () => ({ status: stoppable ? 'stopped' : 'unsupported' }),
            }),
        });
        const services = owner.bindScope(lifecycleScope({ occurrenceId: 'native' }), lifecycleExec);
        const spec: ManagedServiceSpec = {
            id: 'compose',
            mode: { kind: 'native', launch: { executable: { kind: 'systemTool', id: 'fixture.server' } },
                instance: { adapter: { pluginId: 'acme.providers', localId: 'compose' }, nativeResourceId: 'exact-project' } },
        };
        const handle = await services.supervise(spec);
        expect(handle.snapshot()).toMatchObject({ mode: 'native', state: 'running', readiness: 'not_reported', baseUrl: null });
        await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
        expect(handle.snapshot().state).toBe('running');
        expect(await services.supervise(spec)).toBe(handle);
        await expect(handle.dispose()).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
        expect(handle.snapshot().state).toBe('running');
        expect(owner.readRetainedSemanticCustodyCount()).toBe(1);
        stoppable = true;
        expect(await handle.stop()).toEqual({ status: 'stopped' });
        await owner.dispose();
    });
    it.each([false, true])('resolves projected Session access by exact native instance without replacing runtime occurrence (retireBeforeSpawn=%s)', async (retireBeforeSpawn) => {
        const hostFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
        const harness = createLifecycleHarness([createLifecycleProcess(42)], 'sessionRunner', {
            fetch: hostFetch, registerRawForRedaction: () => {},
        });
        const scope = lifecycleScope({ occurrenceId: 'original-runtime-occurrence', sessionId: 'session-one' });
        const handle = await harness.owner.bindScope(scope, harness.exec).supervise({
            ...lifecycleSpec({ id: 'opencode-server', port: 4312 }),
            clientAccess: { kind: 'hostBasic', username: 'opencode', injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD' },
        });
        const identity = { sessionId: 'session-one', pluginId: scope.pluginId,
            contributionQualifiedId: scope.contributionQualifiedId, serviceId: 'opencode-server' };
        // The genuine process-supervisor identity issuer in createLifecycleHarness owns this value.
        const instanceId = 'owner-lifecycle-1';
        try {
            const original = await harness.owner.materializeSessionManagedServiceClientEnvironment({
                ...identity, occurrenceId: scope.occurrenceId, environmentKey: 'OPENCODE_SERVER_PASSWORD',
            });
            expect(original?.OPENCODE_SERVER_PASSWORD).toEqual(expect.any(String));
            const projected = await harness.owner.materializeSessionManagedServiceClientEnvironment({
                ...identity, instanceId, environmentKey: 'OPENCODE_SERVER_PASSWORD',
            });
            expect(projected === null).toBe(false);
            expect(projected?.OPENCODE_SERVER_PASSWORD === original?.OPENCODE_SERVER_PASSWORD).toBe(true);
            expect(await harness.owner.materializeSessionManagedServiceClientEnvironment({
                ...identity, instanceId: 'wrong-native-instance', environmentKey: 'OPENCODE_SERVER_PASSWORD',
            })).toBeNull();
            expect(await harness.owner.materializeSessionManagedServiceClientEnvironment({
                ...identity, sessionId: 'different-session', instanceId, environmentKey: 'OPENCODE_SERVER_PASSWORD',
            })).toBeNull();
            const request = harness.owner.bindSessionManagedServiceRequest({ ...identity, instanceId });
            expect(request).not.toBeNull();
            expect((await request!({ method: 'GET', pathAndQuery: '/global/health' })).ok).toBe(true);
            expect(hostFetch).toHaveBeenCalledTimes(1);
            const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'retained-generation', installSource: 'localPath' as const };
            const binding = createRunnerManagedServiceEndpointProjectionBinding({
                // This is the daemon publication transport boundary; identity is still issued by the real projector.
                publishEndpointProjection: async (input) => createManagedServiceEndpointProjectionV1(input).projectionToken,
                releaseEndpointProjection: async () => true,
            }, {
                resolveProjectedManagedServiceRequest: (projection) => harness.owner.bindSessionManagedServiceRequest({
                    ...identity, instanceId: projection.instanceId,
                }),
                materializeProjectedManagedServiceClientEnvironment: (projection, environmentKey, signal) =>
                    harness.owner.materializeSessionManagedServiceClientEnvironment({
                        ...identity, instanceId: projection.instanceId, environmentKey, signal,
                    }),
            });
            const projectionInput = {
                sessionId: identity.sessionId, pluginId: identity.pluginId, contributionId: identity.contributionQualifiedId,
                serverId: identity.serviceId, instanceId, sourceCustody, custodyOwner: 'sessionRunner' as const,
                mode: 'managedSpawn' as const,
                endpoint: { baseUrl: 'http://127.0.0.1:4312', host: '127.0.0.1' as const, port: 4312 },
                process: { pid: 42, startIdentity: 'owner-lifecycle-process-start' }, createdAtMs: 1,
            };
            const projectionToken = await binding.publishEndpointProjection(projectionInput);
            const localRequest = {
                identity: { pluginId: identity.pluginId, contributionId: identity.contributionQualifiedId,
                    sessionId: identity.sessionId, sourceCustody },
                targetBaseUrl: 'http://127.0.0.1:4312', environmentKey: 'OPENCODE_SERVER_PASSWORD',
                signal: new AbortController().signal,
            };
            const localAccess = await binding.resolveLocalClientAccess(localRequest);
            expect(localAccess === null).toBe(false);
            expect(localAccess?.childEnvironment.OPENCODE_SERVER_PASSWORD === original?.OPENCODE_SERVER_PASSWORD).toBe(true);
            expect(localAccess?.isCurrent()).toBe(true);
            let attached = false;
            const surface = createProviderCliAttachSurface({
                agentId: 'opencode', resolveTarget: resolveOpenCodeAttachTarget,
                createArgs: createOpenCodeAttachArgs,
                managedServiceTargetBaseUrl: (target) => target.baseUrl,
                managedServiceCredentialEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
                managedServiceCredentialEnvironmentAliases: ['OPENCODE_PASSWORD'],
                env: { OPENCODE_SERVER_PASSWORD: 'ambient-wrong', OPENCODE_PASSWORD: 'ambient-wrong' },
                // A harmless native child checks private environment inheritance, without printing the credential.
                resolveLaunchSpec: async () => {
                    if (retireBeforeSpawn) await handle.dispose();
                    return {
                        source: 'managed' as const, resolvedPath: process.execPath, command: process.execPath,
                        args: ['-e', 'process.exit(process.env.OPENCODE_SERVER_PASSWORD && process.env.OPENCODE_SERVER_PASSWORD !== "ambient-wrong" && process.env.OPENCODE_PASSWORD === process.env.OPENCODE_SERVER_PASSWORD ? 0 : 42)', '--'],
                    };
                },
            });
            const attachRequest = {
                sessionId: identity.sessionId,
                metadata: { path: '/repo', runtimeDescriptorV1: { v: 1 as const, agentId: 'opencode',
                    agent: { backendMode: 'server', providerSessionId: 'native-one', serverBaseUrl: localRequest.targetBaseUrl, serverBaseUrlExplicit: true } } },
                onAttached: async () => { attached = true; },
                resolveManagedServiceAccess: async (input: Readonly<{ sessionId: string; targetBaseUrl: string; environmentKey: string; signal?: AbortSignal }>) =>
                    binding.resolveLocalClientAccess({ ...input, identity: localRequest.identity }),
            };
            const attachedResult = await surface.attachManaged(attachRequest);
            expect(attachedResult).toMatchObject(retireBeforeSpawn
                ? { ok: false, code: 'attach_failed' }
                : { ok: true, value: { exitCode: 0 } });
            expect(attached).toBe(!retireBeforeSpawn);
            await handle.dispose();
            // Local process retirement is authoritative even before daemon projection withdrawal settles.
            expect(localAccess?.isCurrent()).toBe(false);
            expect(await binding.resolveLocalClientAccess(localRequest)).toBeNull();
            await binding.releaseEndpointProjection({ instanceId, projectionToken, sessionId: identity.sessionId, pluginId: identity.pluginId });
            expect(await binding.resolveLocalClientAccess(localRequest)).toBeNull();
            expect(await harness.owner.materializeSessionManagedServiceClientEnvironment({
                ...identity, instanceId, environmentKey: 'OPENCODE_SERVER_PASSWORD',
            })).toBeNull();
            await expect(request!({ method: 'GET', pathAndQuery: '/global/health' })).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
            expect(hostFetch).toHaveBeenCalledTimes(1);
        } finally {
            await harness.owner.dispose();
        }
    });

    it('canonicalizes omitted public timeout, health-policy, and durable-log defaults before supervision', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec);

        const handle = await services.supervise({
            id: 'public-defaults',
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4_312 },
                },
            },
            healthCheck: {
                kind: 'http',
                target: { kind: 'servicePath', path: '/healthz' },
            },
            durableLog: { enabled: true },
        });

        expect(harness.supervise).toHaveBeenCalledWith(
            expect.objectContaining({
                startupTimeoutMs: 30_000,
                healthCheck: expect.objectContaining({
                    timeoutMs: 5_000,
                }),
                watchdog: {
                    intervalMs: 5_000,
                    missedIntervals: 2,
                },
                durableLog: {
                    enabled: true,
                    keepCount: 50,
                },
            }),
            expect.any(Object),
        );

        await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
            id: 'gateway',
            state: 'healthy',
        });
        expect(harness.legacyHandle.waitUntilHealthy).toHaveBeenCalledWith({
            timeoutMs: 30_000,
        });
    });

    it.each([
        ['startup minimum', { startupTimeoutMs: 1 }, 'startupTimeoutMs', 1],
        ['startup maximum', { startupTimeoutMs: 300_000 }, 'startupTimeoutMs', 300_000],
        ['health timeout minimum', {
            healthCheck: { kind: 'http', timeoutMs: 1 },
        }, 'healthCheck.timeoutMs', 1],
        ['health timeout maximum', {
            healthCheck: { kind: 'http', timeoutMs: 60_000 },
        }, 'healthCheck.timeoutMs', 60_000],
        ['health interval minimum', {
            healthPolicy: { intervalMs: 250, consecutiveFailures: 2 },
        }, 'watchdog.intervalMs', 250],
        ['health interval maximum', {
            healthPolicy: { intervalMs: 300_000, consecutiveFailures: 2 },
        }, 'watchdog.intervalMs', 300_000],
        ['consecutive failures minimum', {
            healthPolicy: { intervalMs: 5_000, consecutiveFailures: 1 },
        }, 'watchdog.missedIntervals', 1],
        ['consecutive failures maximum', {
            healthPolicy: { intervalMs: 5_000, consecutiveFailures: 20 },
        }, 'watchdog.missedIntervals', 20],
        ['durable keep-count minimum', {
            durableLog: { enabled: true, keepCount: 1 },
        }, 'durableLog.keepCount', 1],
        ['durable keep-count maximum', {
            durableLog: { enabled: true, keepCount: 50 },
        }, 'durableLog.keepCount', 50],
    ] as const)(
        'accepts the public %s boundary',
        async (_label, partial, path, expected) => {
            const harness = createHarness();
            const services = harness.owner.bindScope(harness.scope, exec);

            await services.supervise({
                id: 'public-boundary',
                mode: {
                    kind: 'spawn',
                    launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4_312 },
                    },
                },
                healthCheck: { kind: 'http' },
                ...partial,
            } as ManagedServiceSpec);

            const translated = harness.supervise.mock.calls[0]?.[0] as
                | Record<string, unknown>
                | undefined;
            const actual = path.split('.').reduce<unknown>(
                (value, key) => value && typeof value === 'object'
                    ? (value as Record<string, unknown>)[key]
                    : undefined,
                translated,
            );
            expect(actual).toBe(expected);
        },
    );

    it.each([
        ['startup below minimum', { startupTimeoutMs: 0 }],
        ['startup above maximum', { startupTimeoutMs: 300_001 }],
        ['health timeout below minimum', {
            healthCheck: { kind: 'http', timeoutMs: 0 },
        }],
        ['health timeout above maximum', {
            healthCheck: { kind: 'http', timeoutMs: 60_001 },
        }],
        ['health interval below minimum', {
            healthPolicy: { intervalMs: 249, consecutiveFailures: 2 },
        }],
        ['health interval above maximum', {
            healthPolicy: { intervalMs: 300_001, consecutiveFailures: 2 },
        }],
        ['consecutive failures below minimum', {
            healthPolicy: { intervalMs: 5_000, consecutiveFailures: 0 },
        }],
        ['consecutive failures above maximum', {
            healthPolicy: { intervalMs: 5_000, consecutiveFailures: 21 },
        }],
        ['durable keep-count below minimum', {
            durableLog: { enabled: true, keepCount: 0 },
        }],
        ['durable keep-count above maximum', {
            durableLog: { enabled: true, keepCount: 51 },
        }],
    ] as const)(
        'rejects the public %s neighbor before request auth, credentials, files, allocation, or spawn',
        async (_label, partial) => {
            const harness = createHarness();
            const materialize = vi.fn();
            const materializeFiles = vi.fn();
            const services = harness.owner.bindScope(harness.scope, exec, {
                connectedAccounts: createConnectedAccounts(materialize),
                credentialFiles: Object.freeze({
                    materialize: materializeFiles,
                }),
            });

            await expect(services.supervise({
                id: 'public-invalid-neighbor',
                requestAuth: {
                    kind: 'connectedAccountCapabilityPath',
                    injectEnvironmentKey: 'REQUEST_AUTH_CAPABILITY',
                },
                credentialBindings: [{
                    purpose: 'provider.inference',
                    request: { kind: 'files', fileIds: ['config'] },
                    injection: {
                        kind: 'files',
                        pathsByFileId: {
                            config: { environmentKey: 'UPSTREAM_CONFIG' },
                        },
                    },
                }],
                mode: {
                    kind: 'spawn',
                    launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4_312 },
                    },
                },
                ...partial,
            } as ManagedServiceSpec)).rejects.toMatchObject({
                code: 'plugin_managed_service_spec_invalid',
            });
            expect(materialize).not.toHaveBeenCalled();
            expect(materializeFiles).not.toHaveBeenCalled();
            expect(harness.supervise).not.toHaveBeenCalled();
        },
    );

    it('rejects bare attach durable logging before downstream effects', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec);
        // Intentional public-input boundary cast: runtime JavaScript can violate
        // the attach branch's `durableLog?: never` discriminated contract.
        const invalidAttachSpec = Object.freeze({
            id: 'public-invalid-attach-durable-log',
            mode: Object.freeze({
                kind: 'attach' as const,
                baseUrl: 'http://127.0.0.1:4312',
            }),
            durableLog: Object.freeze({ enabled: true }),
        }) as unknown as ManagedServiceSpec;

        await expect(services.supervise(invalidAttachSpec)).rejects
            .toMatchObject({
                code: 'plugin_managed_service_spec_invalid',
            });
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('bounds public healthy waits and defaults them to the validated startup timeout', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec);
        const handle = await services.supervise({
            id: 'public-wait-timeout',
            startupTimeoutMs: 12_345,
            mode: {
                kind: 'attach',
                baseUrl: 'http://127.0.0.1:4312',
            },
            healthCheck: { kind: 'http' },
        });

        await handle.waitUntilHealthy();
        await handle.waitUntilHealthy({ timeoutMs: 1 });
        await handle.waitUntilHealthy({ timeoutMs: 300_000 });
        expect(harness.legacyHandle.waitUntilHealthy.mock.calls).toEqual([
            [{ timeoutMs: 12_345 }],
            [{ timeoutMs: 1 }],
            [{ timeoutMs: 300_000 }],
        ]);

        await expect(handle.waitUntilHealthy({ timeoutMs: 0 }))
            .rejects.toMatchObject({
                code: 'plugin_managed_service_spec_invalid',
            });
        await expect(handle.waitUntilHealthy({ timeoutMs: 300_001 }))
            .rejects.toMatchObject({
                code: 'plugin_managed_service_spec_invalid',
            });
        expect(harness.legacyHandle.waitUntilHealthy).toHaveBeenCalledTimes(3);
    });

    it('rejects host-bearer custody outside an exact current managed Provider invocation before spawn', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec);

        await expect(services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBearer',
                injectEnvironmentKey: 'DOWNSTREAM_BEARER',
                headerName: 'authorization',
                scheme: 'Bearer',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('owns Session-scoped host-Basic occurrenceId, spawn injection, redaction, and exact-handle requests without disclosure', async () => {
        const hostFetch = vi.fn<typeof globalThis.fetch>(async (
            request,
            init,
        ) => {
            expect(request.toString()).toBe(
                'http://127.0.0.1:4312/session/message?stream=true',
            );
            expect(init?.method).toBe('POST');
            expect(new Headers(init?.headers).get('content-type'))
                .toBe('application/json');
            expect(new Headers(init?.headers).get('authorization'))
                .toMatch(/^Basic [A-Za-z0-9+/]+=*$/u);
            expect(init?.body).toBeInstanceOf(Uint8Array);
            expect(init?.body as Uint8Array)
                .toEqual(new TextEncoder().encode('{"hello":true}'));
            return new Response('event: ready\n\n', {
                status: 200,
                headers: {
                    'content-type': 'text/event-stream',
                    'x-request-id': 'request-one',
                },
            });
        });
        const registerRawForRedaction = vi.fn();
        const harness = createHarness(hostFetch, registerRawForRedaction);
        const services = harness.owner.bindScope(harness.scope, exec);

        const handle = await services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic',
                username: 'opencode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
            healthCheck: {
                kind: 'http',
                target: {
                    kind: 'servicePath',
                    path: '/global/health',
                },
                timeoutMs: 5_000,
            },
        });

        const ownedSpec = harness.supervise.mock.calls[0]?.[0];
        const password = ownedSpec?.mode.kind === 'managedSpawn'
            ? ownedSpec.mode.credential?.environment?.value
            : null;
        const authorization = ownedSpec?.mode.kind === 'managedSpawn'
            ? ownedSpec.mode.credential?.httpHeader?.value
            : null;
        expect(password).toEqual(expect.any(String));
        expect(ownedSpec?.launch?.env ?? {}).not.toHaveProperty(
            'OPENCODE_SERVER_PASSWORD',
        );
        expect(ownedSpec?.mode).toMatchObject({
            credential: {
                environment: {
                    name: 'OPENCODE_SERVER_PASSWORD',
                    value: password,
                },
                httpHeader: {
                    name: 'authorization',
                    value: authorization,
                },
            },
        });
        const usernameAndPassword = `opencode:${password}`;
        const basicPayload = Buffer.from(usernameAndPassword).toString('base64');
        expect(authorization).toBe(`Basic ${basicPayload}`);
        expect(ownedSpec?.healthCheck).toMatchObject({
            kind: 'http',
            headers: { authorization },
        });
        expect(registerRawForRedaction.mock.calls.map(([, value]) => value))
            .toEqual([
                password,
                usernameAndPassword,
                basicPayload,
                authorization,
            ]);

        const response = await handle.request({
            pathAndQuery: '/session/message?stream=true',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode('{"hello":true}'),
            timeoutMs: 10_000,
        });
        expect(response).toMatchObject({
            ok: true,
            status: 200,
            headers: {
                'content-type': 'text/event-stream',
                'x-request-id': 'request-one',
            },
        });
        expect(new TextDecoder().decode(
            (await response.body!.getReader().read()).value,
        )).toBe('event: ready\n\n');
        expect(JSON.stringify(handle)).not.toContain(password!);
        expect(JSON.stringify(handle)).not.toContain(authorization!);
        expect(JSON.stringify(handle.snapshot())).not.toContain(password!);
        expect(JSON.stringify(response)).not.toContain(password!);
        expect(JSON.stringify(response)).not.toContain(
            harness.scope.sessionId,
        );
    });

    it('routes an External Sessions projection read through the canonical Session handle request owner', async () => {
        const canonicalFetch = vi.fn<typeof globalThis.fetch>(async (
            request,
            init,
        ) => {
            expect(request.toString()).toBe(
                'http://127.0.0.1:4312/global/event',
            );
            expect(init?.method).toBe('GET');
            expect(new Headers(init?.headers).get('authorization'))
                .toMatch(/^Basic [A-Za-z0-9+/]+=*$/u);
            return new Response('event: ready\n\n', {
                status: 200,
                headers: {
                    'content-type': 'text/event-stream',
                },
            });
        });
        const directFetch = vi.fn<typeof globalThis.fetch>(async () => {
            throw new Error('projection direct fetch must not execute');
        });
        vi.stubGlobal('fetch', directFetch);
        try {
            const harness = createHarness(canonicalFetch);
            const services = harness.owner.bindScope(harness.scope, exec);
            await services.supervise({
                id: 'gateway',
                clientAccess: {
                    kind: 'hostBasic',
                    username: 'opencode',
                    injectPasswordEnvironmentKey:
                        'OPENCODE_SERVER_PASSWORD',
                },
                mode: {
                    kind: 'spawn',
                    launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4312 },
                    },
                },
                healthCheck: { kind: 'none' },
            });
            const projectionInput = {
                sessionId: harness.scope.sessionId,
                pluginId: harness.scope.pluginId,
                contributionId:
                    harness.scope.contributionQualifiedId,
                serverId: 'gateway',
                instanceId: 'instance-one',
                sourceCustody: {
                    kind: 'managed' as const,
                    immutableGenerationId: harness.scope.occurrenceId,
                    installSource: 'localPath' as const,
                },
                custodyOwner: 'sessionRunner' as const,
                mode: 'managedSpawn' as const,
                endpoint: {
                    baseUrl: 'http://127.0.0.1:4312',
                    host: '127.0.0.1' as const,
                    port: 4312,
                },
                process: {
                    pid: 12,
                    startIdentity: 'process-start-one',
                },
                createdAtMs: 1,
            };
            const projection = createManagedServiceEndpointProjectionV1(
                projectionInput,
            );
            const binding = createRunnerManagedServiceEndpointProjectionBinding({
                publishEndpointProjection: async (input) =>
                    createManagedServiceEndpointProjectionV1(input)
                        .projectionToken,
                releaseEndpointProjection: async () => true,
            }, {
                claimEndpointRead: async () => ({
                    daemonCapability: 'daemon-capability',
                }),
                validateEndpointRead: async () => true,
                resolveProjectedManagedServiceRequest: (candidate) =>
                    harness.owner.bindSessionManagedServiceRequest({
                        sessionId: candidate.sessionId,
                        occurrenceId: harness.scope.occurrenceId,
                        pluginId: candidate.pluginId,
                        contributionQualifiedId:
                            candidate.contributionId,
                        serviceId: candidate.serverId,
                    }),
            });
            await binding.publishEndpointProjection(projectionInput);

            const route = Object.freeze({
                kind: 'endpointProjection' as const,
                projection,
            });
            const opened = await binding.endpointReadPort.open({
                v: 1,
                requestId: '00000000-0000-4000-8000-000000000021',
                route,
                pathAndQuery: '/global/event',
                headers: {},
            });
            expect(opened).toMatchObject({
                status: 'opened',
                response: { status: 200, hasBody: true },
            });
            await expect(binding.endpointReadPort.next({
                v: 1,
                requestId: '00000000-0000-4000-8000-000000000021',
                route: {
                    kind: 'endpointProjection',
                    projectionToken: projection.projectionToken,
                },
            })).resolves.toMatchObject({
                status: 'chunk',
                dataBase64: Buffer.from('event: ready\n\n')
                    .toString('base64'),
            });
            expect(canonicalFetch).toHaveBeenCalledOnce();
            expect(directFetch).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each([
        ['attach', lifecycleScope({ occurrenceId: 'provider-p', sessionId: 'session-one' }), {
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic', username: 'opencode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: { kind: 'attach', baseUrl: 'http://127.0.0.1:4312' },
        }],
        ['non-Session', lifecycleScope({ occurrenceId: 'provider-p' }), {
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic', username: 'opencode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn', launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        }],
        ['colon username', lifecycleScope({ occurrenceId: 'provider-p', sessionId: 'session-one' }), {
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic', username: 'open:code',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn', launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        }],
        ['control username', lifecycleScope({ occurrenceId: 'provider-p', sessionId: 'session-one' }), {
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic', username: 'open\ncode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn', launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        }],
        ['invalid environment key', lifecycleScope({ occurrenceId: 'provider-p', sessionId: 'session-one' }), {
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic', username: 'opencode',
                injectPasswordEnvironmentKey: 'OPEN-CODE-PASSWORD',
            },
            mode: {
                kind: 'spawn', launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        }],
    ])('rejects host-Basic %s before effects', async (_label, scope, spec) => {
        const harness = createHarness();
        const services = harness.owner.bindScope(scope, exec);
        await expect(services.supervise(spec as ManagedServiceSpec))
            .rejects.toMatchObject({
                code: 'plugin_managed_service_spec_invalid',
            });
        expect(harness.supervise).not.toHaveBeenCalled();
        expect(harness.registerRawForRedaction).not.toHaveBeenCalled();
    });

    it('admits host-Basic for a sessionless daemon-custody spawn the daemon mints and holds', async () => {
        const registerRawForRedaction = vi.fn();
        const harness = createHarness(
            undefined,
            registerRawForRedaction,
            'daemon',
        );
        const services = harness.owner.bindScope(
            lifecycleScope({ occurrenceId: 'provider-p', operationId: 'browse-one' }),
            exec,
        );

        const handle = await services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic',
                username: 'opencode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });

        expect(harness.supervise).toHaveBeenCalledOnce();
        const ownedSpec = harness.supervise.mock.calls[0]?.[0];
        const password = ownedSpec?.mode.kind === 'managedSpawn'
            ? ownedSpec.mode.credential?.environment?.value
            : null;
        expect(password).toEqual(expect.any(String));
        expect(ownedSpec?.mode).toMatchObject({
            credential: {
                environment: { name: 'OPENCODE_SERVER_PASSWORD' },
                httpHeader: { name: 'authorization' },
            },
        });
        expect(ownedSpec?.launch?.env ?? {}).not.toHaveProperty(
            'OPENCODE_SERVER_PASSWORD',
        );
        expect(registerRawForRedaction).toHaveBeenCalled();
        await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
            id: 'gateway',
            state: 'healthy',
        });
    });

    it('rejects daemon host-Basic supervision without an exact operation lifecycle', async () => {
        const registerRawForRedaction = vi.fn();
        const harness = createHarness(
            undefined,
            registerRawForRedaction,
            'daemon',
        );
        const services = harness.owner.bindScope(
            lifecycleScope({ occurrenceId: 'provider-p' }),
            exec,
        );

        await expect(services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic',
                username: 'opencode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
        expect(registerRawForRedaction).not.toHaveBeenCalled();
    });

    it('still requires an exact Session scope for host-Basic under Session-runner custody', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(
            lifecycleScope({ occurrenceId: 'provider-p', operationId: 'browse-one' }),
            exec,
        );

        await expect(services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic',
                username: 'opencode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
        expect(harness.registerRawForRedaction).not.toHaveBeenCalled();
    });

    it('admits host-Basic for managed Provider supervision under exact Session-runner custody', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec, {
            managedProvider: createManagedProviderBinding(),
        });

        const handle = await services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic',
                username: 'opencode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });

        expect(harness.supervise).toHaveBeenCalledOnce();
        await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
            id: 'gateway',
            state: 'healthy',
        });
        expect(harness.registerRawForRedaction).toHaveBeenCalled();
    });

    it('rejects a static HTTP health authorization collision with host-Basic before effects', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec);

        await expect(services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic',
                username: 'opencode',
                injectPasswordEnvironmentKey:
                    'OPENCODE_SERVER_PASSWORD',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
            healthCheck: {
                kind: 'http',
                target: {
                    kind: 'servicePath',
                    path: '/global/health',
                },
                headers: { Authorization: 'Basic author-owned' },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
        expect(harness.registerRawForRedaction).not.toHaveBeenCalled();
    });

    it('rejects request escapes, caller authentication, redirects, and stale handles before endpoint effects', async () => {
        const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response(null, {
                status: 302,
                headers: { location: 'http://127.0.0.1:4999/escape' },
            }));
        const harness = createHarness(hostFetch);
        const handle = await harness.owner.bindScope(harness.scope, exec)
            .supervise({
                id: 'gateway',
                mode: {
                    kind: 'spawn', launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4312 },
                    },
                },
            });

        for (const pathAndQuery of [
            'https://example.com/',
            '//example.com/',
            '//user@example.com/',
            '/fragment#escape',
            '/a/../admin',
            '/a/%2e%2e/admin',
            '/a%2fadmin',
            '/a%5cadmin',
            '/a%00admin',
            '/a\\admin',
        ]) {
            await expect(handle.request({ pathAndQuery }))
                .rejects.toMatchObject({
                    code: 'plugin_managed_service_unavailable',
                });
        }
        const rejectedHeaders: readonly Readonly<Record<string, string>>[] = [
            { Authorization: 'Bearer caller' },
            { 'pRoXy-AuThOrIzAtIoN': 'Basic caller' },
            { 'Content-Length': '0' },
            { 'X-Api-Key': 'caller-secret' },
        ];
        for (const headers of rejectedHeaders) {
            await expect(handle.request({
                pathAndQuery: '/session',
                headers,
            })).rejects.toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });
        }
        // The caller cancelled itself. Reporting that as service unavailability would tell the
        // plugin its endpoint, credentials or occurrenceId are gone and invite re-establishment.
        const aborted = new AbortController();
        aborted.abort('caller canceled');
        await expect(handle.request({
            pathAndQuery: '/session',
            signal: aborted.signal,
        })).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });
        expect(hostFetch).not.toHaveBeenCalled();

        await expect(handle.request({ pathAndQuery: '/session' }))
            .rejects.toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });
        expect(hostFetch).toHaveBeenCalledOnce();

        harness.authorization.current = false;
        await expect(handle.request({ pathAndQuery: '/session' }))
            .rejects.toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });
        expect(hostFetch).toHaveBeenCalledOnce();
    });

    it('revalidates final request header count and bytes after injecting host-Basic authorization', async () => {
        const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response(null, { status: 200 }));
        const harness = createHarness(hostFetch);
        const handle = await harness.owner.bindScope(harness.scope, exec)
            .supervise({
                id: 'gateway',
                clientAccess: {
                    kind: 'hostBasic',
                    username: 'opencode',
                    injectPasswordEnvironmentKey:
                        'OPENCODE_SERVER_PASSWORD',
                },
                mode: {
                    kind: 'spawn',
                    launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4312 },
                    },
                },
            });
        const countLimitedHeaders = Object.fromEntries(
            Array.from({ length: 64 }, (_, index) => [
                `x-public-${index}`,
                'value',
            ]),
        );
        const byteLimitedHeaders = Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [
                `x-b${index}`,
                'x'.repeat(8_180),
            ]),
        );

        for (const headers of [countLimitedHeaders, byteLimitedHeaders]) {
            await expect(handle.request({
                pathAndQuery: '/session',
                headers,
            })).rejects.toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });
        }
        expect(hostFetch).not.toHaveBeenCalled();
    });

    // Cancellation provenance while response headers are still outstanding. Both cases fail at the
    // same owner statement, so they are only distinguishable if that statement reads the caller's
    // own signal instead of the composed lifetime.
    it.each([
        {
            label: 'the caller cancels',
            expectedCode: 'plugin_operation_aborted',
            end: (input: Readonly<{
                caller: AbortController;
                authorization: { current: boolean };
                settle: () => void;
            }>) => input.caller.abort('caller canceled'),
        },
        {
            label: 'the occurrenceId stops being current',
            expectedCode: 'plugin_managed_service_unavailable',
            end: (input: Readonly<{
                caller: AbortController;
                authorization: { current: boolean };
                settle: () => void;
            }>) => {
                input.authorization.current = false;
                input.settle();
            },
        },
    ])('reports establishment failure as $expectedCode when $label', async ({ expectedCode, end }) => {
        let settleFetch!: () => void;
        const hostFetch = vi.fn<typeof globalThis.fetch>((_request, init) =>
            new Promise<Response>((resolve, reject) => {
                settleFetch = () => resolve(new Response(null, { status: 204 }));
                init?.signal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('The operation was aborted.', 'AbortError')),
                    { once: true },
                );
            }));
        const harness = createHarness(hostFetch);
        const handle = await harness.owner.bindScope(
            harness.scope,
            exec,
        ).supervise({
            id: 'gateway',
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });
        const caller = new AbortController();
        const pending = handle.request({
            pathAndQuery: '/session',
            signal: caller.signal,
        });
        await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledOnce());

        end({ caller, authorization: harness.authorization, settle: () => settleFetch() });

        await expect(pending).rejects.toMatchObject({ code: expectedCode });
        harness.authorization.current = true;
        await handle.dispose();
    });

    it.each(['stop', 'dispose'] as const)(
        'cancels an active exact-handle response stream when %s retires the handle',
        async (operation) => {
            const cancel = vi.fn(async () => undefined);
            const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
                new Response(new ReadableStream<Uint8Array>({
                    cancel,
                })));
            const harness = createHarness(hostFetch);
            const handle = await harness.owner.bindScope(
                harness.scope,
                exec,
            ).supervise({
                id: 'gateway',
                mode: {
                    kind: 'spawn', launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4312 },
                    },
                },
            });
            const response = await handle.request({
                pathAndQuery: '/session/events',
            });

            await handle[operation]();

            await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
            await expect(response.body!.getReader().read()).rejects
                .toMatchObject({
                    code: 'plugin_managed_service_unavailable',
                });
        },
    );

    it('bounds response establishment without timing out a healthy default-timeout stream', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn(async () => undefined);
        let sourceController:
            | ReadableStreamDefaultController<Uint8Array>
            | undefined;
        let handle: ManagedServiceHandle | undefined;
        try {
            const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
                new Response(new ReadableStream<Uint8Array>({
                    start(controller) {
                        sourceController = controller;
                    },
                    cancel,
                })));
            const harness = createHarness(hostFetch);
            handle = await harness.owner.bindScope(
                harness.scope,
                exec,
            ).supervise({
                id: 'gateway',
                mode: {
                    kind: 'spawn', launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4312 },
                    },
                },
            });
            const caller = new AbortController();
            const response = await handle.request({
                pathAndQuery: '/session/events',
                signal: caller.signal,
            });
            const reader = response.body!.getReader();

            await vi.advanceTimersByTimeAsync(300_001);

            expect(cancel).not.toHaveBeenCalled();
            sourceController!.enqueue(new Uint8Array([1]));
            await expect(reader.read()).resolves.toEqual({
                done: false,
                value: new Uint8Array([1]),
            });

            const next = reader.read();
            caller.abort('caller canceled');
            await expect(next).rejects.toMatchObject({
                code: 'plugin_operation_aborted',
            });
            await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        } finally {
            await handle?.dispose();
            vi.useRealTimers();
        }
    });

    it('applies the default timeout while response headers remain unavailable', async () => {
        vi.useFakeTimers();
        let fetchSignal: AbortSignal | undefined;
        let handle: ManagedServiceHandle | undefined;
        try {
            const hostFetch = vi.fn<typeof globalThis.fetch>(async (
                _request,
                init,
            ) => await new Promise<Response>((_resolve, reject) => {
                fetchSignal = init?.signal ?? undefined;
                if (!fetchSignal) {
                    reject(new Error('fetch signal missing'));
                    return;
                }
                const abort = (): void => reject(fetchSignal?.reason);
                fetchSignal.addEventListener('abort', abort, { once: true });
                if (fetchSignal.aborted) abort();
            }));
            const harness = createHarness(hostFetch);
            handle = await harness.owner.bindScope(
                harness.scope,
                exec,
            ).supervise({
                id: 'gateway',
                mode: {
                    kind: 'spawn', launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4312 },
                    },
                },
            });
            const result = expect(handle.request({
                pathAndQuery: '/session/events',
            })).rejects.toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });

            await vi.advanceTimersByTimeAsync(300_000);

            expect(fetchSignal?.aborted).toBe(true);
            await result;
        } finally {
            await handle?.dispose();
            vi.useRealTimers();
        }
    });

    it('keeps the establishment timeout active through response-header validation', async () => {
        vi.useFakeTimers();
        let fetchSignal: AbortSignal | undefined;
        let handle: ManagedServiceHandle | undefined;
        try {
            const hostFetch = vi.fn<typeof globalThis.fetch>(async (
                _request,
                init,
            ) => {
                fetchSignal = init?.signal ?? undefined;
                const response = new Response(null, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                });
                const forEach = response.headers.forEach.bind(
                    response.headers,
                );
                vi.spyOn(response.headers, 'forEach').mockImplementation(
                    (callback, thisArg) => {
                        vi.advanceTimersByTime(5);
                        forEach(callback, thisArg);
                    },
                );
                return response;
            });
            const harness = createHarness(hostFetch);
            handle = await harness.owner.bindScope(
                harness.scope,
                exec,
            ).supervise({
                id: 'gateway',
                mode: {
                    kind: 'spawn', launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4312 },
                    },
                },
            });

            await expect(handle.request({
                pathAndQuery: '/session/events',
                timeoutMs: 5,
            })).rejects.toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });
            expect(fetchSignal?.aborted).toBe(true);
        } finally {
            await handle?.dispose();
            vi.useRealTimers();
        }
    });

    it('cancels an active exact-handle response stream when its scope becomes stale', async () => {
        const cancel = vi.fn(async () => undefined);
        let sourceController:
            | ReadableStreamDefaultController<Uint8Array>
            | undefined;
        const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    sourceController = controller;
                },
                cancel,
            })));
        const harness = createHarness(hostFetch);
        const handle = await harness.owner.bindScope(harness.scope, exec)
            .supervise({
                id: 'gateway',
                mode: {
                    kind: 'spawn', launch: { executable: {} as never },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'fixed', port: 4312 },
                    },
                },
            });
        const response = await handle.request({
            pathAndQuery: '/session/events',
        });

        harness.authorization.current = false;
        sourceController!.enqueue(new Uint8Array([1]));

        await expect(response.body!.getReader().read()).rejects
            .toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        await handle.dispose();
    });

    it('injects an authorized broker capability path before the managed Provider child effect without conflating the downstream bearer', async () => {
        const harness = createHarness();
        const capabilityPath = '/private/runtime/request-auth-capability.json';
        const binding = Object.freeze({
            realm: 'managedProviderStart' as const,
            capabilityPath,
            requestAuthUses: Object.freeze([Object.freeze({
                purpose: 'provider.inference',
                materialization: Object.freeze({
                    kind: 'httpHeaders' as const,
                    origin: 'https://api.openai.com',
                    headerNames: Object.freeze(['authorization']),
                }),
            })]),
            isCurrent: () => true,
        }) satisfies ManagedProviderRequestAuthCapabilityPathBinding;
        const services = harness.owner.bindScope(harness.scope, exec, {
            managedProvider: createManagedProviderBinding(
                () => true,
                binding,
            ),
            requestAuth: binding,
        });

        const handle = await services.supervise({
            id: 'gateway',
            requestAuth: {
                kind: 'connectedAccountCapabilityPath',
                injectEnvironmentKey: 'UPSTREAM_REQUEST_AUTH_CAPABILITY',
            },
            clientAccess: {
                kind: 'hostBearer',
                injectEnvironmentKey: 'DOWNSTREAM_BEARER',
                headerName: 'authorization',
                scheme: 'Bearer',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });

        expect(harness.supervise).toHaveBeenCalledOnce();
        const ownedSpec = harness.supervise.mock.calls[0]?.[0];
        expect(ownedSpec?.launch?.env).toMatchObject({
            UPSTREAM_REQUEST_AUTH_CAPABILITY: capabilityPath,
        });
        expect(Object.entries(ownedSpec?.launch?.env ?? {}).filter(
            ([, value]) => value === capabilityPath,
        )).toEqual([
            ['UPSTREAM_REQUEST_AUTH_CAPABILITY', capabilityPath],
        ]);
        const downstreamBearer = ownedSpec?.mode.kind === 'managedSpawn'
            ? ownedSpec.mode.credential?.environment?.value
            : undefined;
        expect(downstreamBearer).toEqual(expect.any(String));
        expect(downstreamBearer).not.toBe(capabilityPath);
        expect(JSON.stringify(handle.snapshot())).not.toContain(capabilityPath);
        expect(JSON.stringify(handle.snapshot())).not.toContain(downstreamBearer!);
    });

    it('projects exact endpoint-bounded authenticated fetch without disclosing its host bearer', async () => {
        const hostFetch = vi.fn<typeof globalThis.fetch>(async (
            _input: string | URL | Request,
            _init?: RequestInit,
        ) => new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const harness = createHarness(
            hostFetch as unknown as typeof globalThis.fetch,
        );
        const provider = createManagedProviderBinding();
        const services = harness.owner.bindScope(harness.scope, exec, {
            managedProvider: provider,
        });
        const handle = await services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBearer',
                injectEnvironmentKey: 'DOWNSTREAM_BEARER',
                headerName: 'authorization',
                scheme: 'Bearer',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });
        const projection = await harness.owner
            .projectManagedProviderEndpointAccess!({
                service: handle,
                endpoints: [{
                    endpointTemplateId: 'responses',
                    servicePath: '/v1',
                }],
                signal: new AbortController().signal,
                isCurrent: () => true,
            });

        expect(projection).not.toBeNull();
        if (!projection) return;
        expect(projection.access.endpointUrl('responses')).toBe(
            'http://127.0.0.1:4312/v1',
        );
        expect(projection.access.endpointUrl('unknown')).toBeNull();
        const response = await projection.access.request({
            pathAndQuery: '/v1/models?limit=1',
            method: 'GET',
            timeoutMs: 5_000,
        });
        expect(response.status).toBe(200);
        expect(hostFetch).toHaveBeenCalledTimes(1);
        const fetchInit = hostFetch.mock.calls[0]?.[1];
        const injectedAuthorization = new Headers(
            fetchInit?.headers,
        ).get('authorization');
        const ownedSpec = harness.supervise.mock.calls[0]?.[0];
        const privateAuthorization = ownedSpec?.mode.kind === 'managedSpawn'
            ? ownedSpec.mode.credential?.httpHeader?.value
            : null;
        expect(injectedAuthorization).toBe(privateAuthorization);
        expect(JSON.stringify(projection.access)).not.toContain(
            privateAuthorization!,
        );
        await expect(projection.access.request({
            pathAndQuery: '/admin',
            method: 'GET',
            timeoutMs: 5_000,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(hostFetch).toHaveBeenCalledTimes(1);

        harness.moveHealthyEndpoint('http://127.0.0.1:4312', 4312, 2);
        expect(projection.access.endpointUrl('responses')).toBeNull();
        await expect(projection.access.request({
            pathAndQuery: '/v1/models?limit=2',
            method: 'GET',
            timeoutMs: 5_000,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(hostFetch).toHaveBeenCalledTimes(1);

        await projection.cleanup();
        expect(projection.isCurrent()).toBe(false);
        expect(projection.access.endpointUrl('responses')).toBeNull();
        await expect(projection.access.request({
            pathAndQuery: '/v1/models',
            method: 'GET',
            timeoutMs: 5_000,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('projects every endpoint the Protocol lets one Provider declare', async () => {
        const endpointTemplateIds = Object.freeze(
            Array.from(
                {
                    length: PROVIDER_WIRE_PROTOCOL_LIMITS_V1
                        .maxProtocolsPerDeclaration,
                },
                (_unused, index) => `endpoint-${index}`,
            ),
        );
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec, {
            managedProvider: createManagedProviderBinding(),
        });
        const handle = await services.supervise({
            id: 'gateway',
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });
        const projection = await harness.owner
            .projectManagedProviderEndpointAccess!({
                service: handle,
                endpoints: endpointTemplateIds.map((endpointTemplateId) => ({
                    endpointTemplateId,
                    servicePath: `/${endpointTemplateId}`,
                })),
                signal: new AbortController().signal,
                isCurrent: () => true,
            });

        expect(endpointTemplateIds.length).toBeGreaterThan(4);
        expect(projection).not.toBeNull();
        expect(endpointTemplateIds.map(
            (endpointTemplateId) =>
                projection?.access.endpointUrl(endpointTemplateId),
        )).toEqual(endpointTemplateIds.map(
            (endpointTemplateId) =>
                `http://127.0.0.1:4312/${endpointTemplateId}`,
        ));
    });

    it('materializes an exact Session-runner host-Basic Provider binding through the public projection without disclosing its credential', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec, {
            managedProvider: createManagedProviderBinding(),
        });
        const handle = await services.supervise({
            id: 'gateway',
            clientAccess: {
                kind: 'hostBasic',
                username: 'happier',
                injectPasswordEnvironmentKey: 'DOWNSTREAM_PASSWORD',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });
        const projection = await harness.owner
            .projectManagedProviderEndpointAccess!({
                service: handle,
                endpoints: [{
                    endpointTemplateId: 'responses',
                    servicePath: '/v1',
                }],
                signal: new AbortController().signal,
                isCurrent: () => true,
            });

        expect(projection).not.toBeNull();
        if (!projection) return;
        const ownedSpec = harness.supervise.mock.calls[0]?.[0];
        const credential = ownedSpec?.mode.kind === 'managedSpawn'
            ? ownedSpec.mode.credential
            : undefined;
        const rawPassword = credential?.environment?.value;
        const renderedAuthorization = credential?.httpHeader?.value;
        expect(rawPassword).toEqual(expect.any(String));
        expect(renderedAuthorization).toEqual(expect.stringMatching(/^Basic /u));

        let publicMaterializeInput: Readonly<{
            endpointUrl: string;
            credentialPlaceholder: string | null;
        }> | null = null;
        const materialized = await harness.owner
            .materializeManagedProviderAgentBinding!({
                service: handle,
                projection,
                endpointTemplateId: 'responses',
                materialize: async (input) => {
                    publicMaterializeInput = input;
                    if (input.credentialPlaceholder === null) {
                        throw new Error('Expected the managed spawn credential placeholder');
                    }
                    const renderedPlaceholder = `Basic ${Buffer.from(
                        `happier:${input.credentialPlaceholder}`,
                        'utf8',
                    ).toString('base64')}`;
                    return {
                        v: 1,
                        kind: 'spawnEnv',
                        env: [{
                            name: 'AGENT_PROVIDER_AUTHORIZATION',
                            value: renderedPlaceholder,
                            source: 'provider',
                        }],
                        additionalRedactionValues: [renderedPlaceholder],
                    };
                },
            });

        expect(materialized).not.toBeNull();
        if (!materialized || !publicMaterializeInput) return;
        const publicProjectionJson = JSON.stringify({
            access: projection.access,
            materializeInput: publicMaterializeInput,
            materialization: materialized.materialization,
        });
        expect(publicProjectionJson).not.toContain(rawPassword!);
        expect(publicProjectionJson).not.toContain(renderedAuthorization!);
        expect(materialized.materialization.additionalRedactionValues)
            .toBeUndefined();
        expect(materialized.transformLaunchEnvironment({
            AGENT_PROVIDER_AUTHORIZATION:
                materialized.materialization.env[0]!.value!,
        })).toEqual({
            AGENT_PROVIDER_AUTHORIZATION: renderedAuthorization,
        });
        expect(materialized.redactionValues).toEqual([
            rawPassword,
            `happier:${rawPassword}`,
            Buffer.from(`happier:${rawPassword}`, 'utf8').toString('base64'),
            renderedAuthorization,
        ]);
    });

    it.each([
        ['ordinary invocation', undefined],
        ['wrong realm', {
            realm: 'ordinaryInvocation',
            capabilityPath: '/private/runtime/request-auth-capability.json',
            requestAuthUses: [{
                purpose: 'provider.inference',
                materialization: {
                    kind: 'httpHeaders',
                    origin: 'https://api.openai.com',
                    headerNames: ['authorization'],
                },
            }],
            isCurrent: () => true,
        }],
        ['missing purpose', {
            realm: 'managedProviderStart',
            capabilityPath: '/private/runtime/request-auth-capability.json',
            requestAuthUses: [],
            isCurrent: () => true,
        }],
        ['stale broker authority', {
            realm: 'managedProviderStart',
            capabilityPath: '/private/runtime/request-auth-capability.json',
            requestAuthUses: [{
                purpose: 'provider.inference',
                materialization: {
                    kind: 'httpHeaders',
                    origin: 'https://api.openai.com',
                    headerNames: ['authorization'],
                },
            }],
            isCurrent: () => false,
        }],
    ])('rejects request-auth capability injection for %s before spawn', async (_label, requestAuth) => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec, {
            managedProvider: createManagedProviderBinding(),
            requestAuth: requestAuth as ManagedProviderRequestAuthCapabilityPathBinding,
        });

        await expect(services.supervise({
            id: 'gateway',
            requestAuth: {
                kind: 'connectedAccountCapabilityPath',
                injectEnvironmentKey: 'UPSTREAM_REQUEST_AUTH_CAPABILITY',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('rechecks request-auth currentness immediately before the child effect', async () => {
        const harness = createHarness();
        let currentnessChecks = 0;
        const services = harness.owner.bindScope(harness.scope, exec, {
            managedProvider: createManagedProviderBinding(),
            requestAuth: {
                realm: 'managedProviderStart',
                capabilityPath: '/private/runtime/request-auth-capability.json',
                requestAuthUses: [{
                    purpose: 'provider.inference',
                    materialization: {
                        kind: 'httpHeaders',
                        origin: 'https://api.openai.com',
                        headerNames: ['authorization'],
                    },
                }],
                isCurrent: () => ++currentnessChecks === 1,
            },
        });

        await expect(services.supervise({
            id: 'gateway',
            requestAuth: {
                kind: 'connectedAccountCapabilityPath',
                injectEnvironmentKey: 'UPSTREAM_REQUEST_AUTH_CAPABILITY',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(currentnessChecks).toBeGreaterThanOrEqual(2);
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it.each([
        ['attach', {
            mode: {
                kind: 'attach' as const,
                baseUrl: 'http://127.0.0.1:4312',
            },
        }],
        ['destination collision', {
            mode: {
                kind: 'spawn' as const,
                launch: {
                    executable: {} as never,
                    env: { UPSTREAM_REQUEST_AUTH_CAPABILITY: 'author-value' },
                },
                endpoint: {
                    kind: 'assignAndInject' as const,
                    port: { kind: 'fixed' as const, port: 4312 },
                },
            },
        }],
        ['Windows case-insensitive destination collision', {
            mode: {
                kind: 'spawn' as const,
                launch: {
                    executable: {} as never,
                    env: { upstream_request_auth_capability: 'author-value' },
                },
                endpoint: {
                    kind: 'assignAndInject' as const,
                    port: { kind: 'fixed' as const, port: 4312 },
                },
            },
        }],
    ])('rejects request-auth capability injection with %s before spawn', async (_label, partial) => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec, {
            managedProvider: createManagedProviderBinding(),
            requestAuth: {
                realm: 'managedProviderStart',
                capabilityPath: '/private/runtime/request-auth-capability.json',
                requestAuthUses: [{
                    purpose: 'provider.inference',
                    materialization: {
                        kind: 'httpHeaders',
                        origin: 'https://api.openai.com',
                        headerNames: ['authorization'],
                    },
                }],
                isCurrent: () => true,
            },
        });

        await expect(services.supervise({
            id: 'gateway',
            requestAuth: {
                kind: 'connectedAccountCapabilityPath',
                injectEnvironmentKey: 'UPSTREAM_REQUEST_AUTH_CAPABILITY',
            },
            ...partial,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('rejects a plugin-supplied capability path instead of treating it as host authority', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec, {
            requestAuth: {
                realm: 'managedProviderStart',
                capabilityPath: '/private/runtime/host-capability.json',
                requestAuthUses: [{
                    purpose: 'provider.inference',
                    materialization: {
                        kind: 'httpHeaders',
                        origin: 'https://api.openai.com',
                        headerNames: ['authorization'],
                    },
                }],
                isCurrent: () => true,
            },
        });

        await expect(services.supervise({
            id: 'gateway',
            requestAuth: {
                kind: 'connectedAccountCapabilityPath',
                injectEnvironmentKey: 'UPSTREAM_REQUEST_AUTH_CAPABILITY',
                capabilityPath: '/private/runtime/forged-capability.json',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        } as never)).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('maps the public attach contract and public snapshots through the existing lifecycle owner', async () => {
        const legacySnapshot = Object.freeze({
            id: 'gateway',
            instanceId: 'instance-one',
            state: 'healthy' as const,
            mode: 'externalAttach' as const,
            baseUrl: 'http://127.0.0.1:4312',
            port: 4312,
            pid: null,
            startedAtMs: null,
            lastHealthyAtMs: 10,
            diagnostics: Object.freeze([
                Object.freeze({
                    code: 'first_failure',
                    severity: 'error' as const,
                }),
                Object.freeze({
                    code: 'second_failure',
                    severity: 'error' as const,
                }),
            ]),
            diagnosticsTruncated: true,
        });
        const legacyHandle = Object.freeze({
            snapshot: () => legacySnapshot,
            observe: vi.fn(() => Object.freeze({ dispose() {} })),
            waitUntilHealthy: vi.fn(async () => legacySnapshot),
            stop: vi.fn(async () => Object.freeze({
                status: 'detached' as const,
            })),
            dispose: vi.fn(async () => undefined),
        }) satisfies ManagedServiceProcessHandle;
        const supervise = vi.fn(async () => legacyHandle);
        const processSupervisorHost = Object.freeze({
            custodyOwner: 'daemon' as const,
            bind: vi.fn(() => Object.freeze({ supervise })),
        }) satisfies ManagedServiceProcessSupervisorHost;
        const owner = createManagedServicesOwner({
            processSupervisorHost,
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const services = owner.bindScope({
            occurrenceId: 'provider-p',
            pluginId: 'acme.providers',
            contributionQualifiedId:
                'acme.providers/providers/gateway',
            sessionId: 'session-one',
            operationId: 'mcp:session-one:attach-inspection',
            isOccurrenceCurrent: () => true,
        }, exec);

        const handle = await services.supervise({
            id: 'gateway',
            mode: {
                kind: 'attach',
                baseUrl: 'http://127.0.0.1:4312',
            },
            healthCheck: {
                kind: 'http',
                target: {
                    kind: 'servicePath',
                    path: '/healthz',
                },
                timeoutMs: 2_000,
            },
            healthPolicy: {
                intervalMs: 5_000,
                consecutiveFailures: 3,
            },
        });

        expect(supervise).toHaveBeenCalledWith({
            id: 'gateway',
            mode: {
                kind: 'externalAttach',
                baseUrl: 'http://127.0.0.1:4312',
            },
            healthCheck: {
                kind: 'http',
                target: {
                    kind: 'serverPath',
                    path: '/healthz',
                },
                timeoutMs: 2_000,
            },
            watchdog: {
                intervalMs: 5_000,
                missedIntervals: 3,
            },
            startupTimeoutMs: 30_000,
        }, expect.objectContaining({
            signal: expect.objectContaining({ aborted: false }),
            registerEstablishmentCleanup: expect.any(Function),
        }));
        expect(handle.snapshot()).toEqual({
            id: 'gateway',
            state: 'healthy',
            mode: 'attach',
            baseUrl: 'http://127.0.0.1:4312',
            startedAtMs: null,
            lastHealthyAtMs: 10,
            diagnostics: [
                { code: 'first_failure', severity: 'error' },
                { code: 'second_failure', severity: 'error' },
            ],
            diagnosticsTruncated: true,
        });
        await expect(handle.stop()).resolves.toEqual({
            status: 'detached',
        });
        expect(legacyHandle.stop).toHaveBeenCalledOnce();
    });

    it('materializes environment and private files before the owned spawn and releases file leases with the handle', async () => {
        const harness = createHarness();
        const connectedAccounts = createConnectedAccounts(vi.fn(async (_purpose, request) => (
            request.kind === 'environment'
                ? Object.freeze({
                    kind: 'environment' as const,
                    env: Object.freeze({ TOKEN: 'environment-secret' }),
                })
                : Object.freeze({
                    kind: 'files' as const,
                    files: Object.freeze({
                        config: new TextEncoder().encode('file-secret'),
                    }),
                })
        )));
        const releaseFiles = vi.fn(async () => undefined);
        const materializeFiles = vi.fn(async ({ retainCleanup }:
            CredentialFileMaterializeInput) => {
            const lease = Object.freeze({
                pathsByFileId: Object.freeze({
                    config: '/private/session-one/config',
                }),
                dispose: releaseFiles,
            });
            retainCleanup(lease);
            return lease;
        });
        const services = harness.owner.bindScope(
            harness.scope,
            exec,
            {
                connectedAccounts,
                credentialFiles: Object.freeze({
                    materialize: materializeFiles,
                }),
            },
        );

        const handle = await services.supervise({
            id: 'gateway',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: {
                    kind: 'environment',
                    keys: ['TOKEN'],
                },
                injection: {
                    kind: 'environment',
                    targetEnvironmentKeysByMaterializedKey: {
                        TOKEN: 'UPSTREAM_TOKEN',
                    },
                },
            }, {
                purpose: 'provider.inference',
                request: {
                    kind: 'files',
                    fileIds: ['config'],
                },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: {
                    executable: {} as never,
                    env: { ORDINARY: 'value' },
                },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });

        expect(harness.supervise).toHaveBeenCalledWith(
            expect.objectContaining({
                launch: expect.objectContaining({
                    env: {
                        ORDINARY: 'value',
                        UPSTREAM_TOKEN: 'environment-secret',
                        UPSTREAM_CONFIG: '/private/session-one/config',
                    },
                }),
            }),
            expect.objectContaining({
                signal: expect.any(AbortSignal),
                registerEstablishmentCleanup: expect.any(Function),
            }),
        );
        expect(materializeFiles).toHaveBeenCalledWith(expect.objectContaining({
            files: expect.objectContaining({ config: expect.any(Uint8Array) }),
            scope: expect.objectContaining({ sessionId: 'session-one' }),
        }));
        await handle.dispose();
        expect(releaseFiles).toHaveBeenCalledTimes(1);
    });

    it('permanently retires retained Session services, fences late admission, and awaits cleanup', async () => {
        const harness = createHarness();
        const childCleanup = deferred<void>();
        const credentialCleanup = deferred<void>();
        harness.legacyHandle.dispose.mockImplementationOnce(
            async () => {
                await childCleanup.promise;
                return undefined;
            },
        );
        const releaseFiles = vi.fn(
            async () => await credentialCleanup.promise,
        );
        const connectedMaterialize = vi.fn(async () => Object.freeze({
            kind: 'files' as const,
            files: Object.freeze({
                config: new Uint8Array([1]),
            }),
        }));
        const materializeFiles = vi.fn(async ({ retainCleanup }:
            CredentialFileMaterializeInput) => {
            const lease = Object.freeze({
                pathsByFileId: Object.freeze({
                    config: '/private/session-one/config',
                }),
                dispose: releaseFiles,
            });
            retainCleanup(lease);
            return lease;
        });
        const services = harness.owner.bindScope(
            harness.scope,
            exec,
            {
                connectedAccounts: createConnectedAccounts(
                    connectedMaterialize,
                ),
                credentialFiles: Object.freeze({
                    materialize: materializeFiles,
                }),
            },
        );
        await services.supervise({
            id: 'generic-session-service',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4_312 },
                },
            },
        });

        let disposalSettled = false;
        const disposal = harness.owner.dispose().then(() => {
            disposalSettled = true;
        });
        await vi.waitFor(() => {
            expect(harness.legacyHandle.dispose).toHaveBeenCalledOnce();
        });
        expect(releaseFiles).not.toHaveBeenCalled();
        expect(disposalSettled).toBe(false);

        const lateHandle = Object.freeze({
            ...harness.legacyHandle,
            dispose: vi.fn(async () => undefined),
        }) satisfies ManagedServiceProcessHandle;
        harness.supervise.mockResolvedValueOnce(lateHandle);
        const lateSupervision = services.supervise({
            id: 'late-session-service',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4_313 },
                },
            },
        }).then(
            (handle) => Object.freeze({
                status: 'admitted' as const,
                handle,
            }),
            (error: unknown) => Object.freeze({
                status: 'rejected' as const,
                error,
            }),
        );

        childCleanup.resolve(undefined);
        await vi.waitFor(() => expect(releaseFiles).toHaveBeenCalledOnce());
        expect(disposalSettled).toBe(false);

        credentialCleanup.resolve(undefined);
        await disposal;
        expect(disposalSettled).toBe(true);
        await expect(lateSupervision).resolves.toMatchObject({
            status: 'rejected',
            error: { code: 'plugin_managed_service_unavailable' },
        });
        expect(harness.supervise).toHaveBeenCalledOnce();
        expect(connectedMaterialize).toHaveBeenCalledOnce();
        expect(materializeFiles).toHaveBeenCalledOnce();
        expect(lateHandle.dispose).not.toHaveBeenCalled();
    });

    it('retains post-supervise cleanup custody when invalidation rollback fails and retries it on permanent disposal', async () => {
        const returnedHandle = deferred<ManagedServiceProcessHandle>();
        const stop = vi.fn()
            .mockRejectedValueOnce(new Error('/private/stop-secret'))
            .mockResolvedValue(Object.freeze({ status: 'stopped' as const }));
        const dispose = vi.fn()
            .mockRejectedValueOnce(new Error('/private/dispose-secret'))
            .mockResolvedValue(undefined);
        const handle = Object.freeze({
            snapshot: () => Object.freeze({
                id: 'late-invalidated',
                instanceId: 'late-invalidated-instance',
                state: 'healthy' as const,
                mode: 'managedSpawn' as const,
                baseUrl: 'http://127.0.0.1:4312',
                port: 4_312,
                pid: 12,
                startedAtMs: 1,
                lastHealthyAtMs: 1,
                diagnostics: Object.freeze([]),
                diagnosticsTruncated: false,
            }),
            observe: vi.fn(() => Object.freeze({ dispose() {} })),
            waitUntilHealthy: vi.fn(),
            stop,
            dispose,
        }) satisfies ManagedServiceProcessHandle;
        const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>(
            async () => await returnedHandle.promise,
        );
        let current = true;
        const owner = createManagedServicesOwner({
            processSupervisorHost: Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: () => Object.freeze({ supervise }),
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const services = owner.bindScope(lifecycleScope({
            occurrenceId: 'occurrenceId-late-invalidated',
            sessionId: 'session-late-invalidated',
            operationId:
                'session-demand:session-late-invalidated:provider-p',
            isOccurrenceCurrent: () => current,
        }), exec);

        const supervision = services.supervise(lifecycleSpec({
            id: 'late-invalidated',
            port: 4_312,
        }));
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());
        const firstPermanentDisposal = owner.dispose();
        current = false;
        returnedHandle.resolve(handle);

        const supervisionFailure = await supervision.then(
            () => null,
            (error: unknown) => error,
        );
        const firstDisposalFailure = await firstPermanentDisposal.then(
            () => null,
            (error: unknown) => error,
        );

        expect(supervisionFailure).toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(firstDisposalFailure).toBeInstanceOf(AggregateError);
        expect((firstDisposalFailure as AggregateError).errors).toHaveLength(2);
        expect(String(supervisionFailure)).not.toMatch(/private|secret/u);
        expect(String(firstDisposalFailure)).not.toMatch(/private|secret/u);
        expect(
            (firstDisposalFailure as AggregateError).errors
                .map(String)
                .join('\n'),
        ).not.toMatch(/private|secret/u);
        expect(stop).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();

        await expect(owner.dispose()).resolves.toBeUndefined();
        await expect(owner.dispose()).resolves.toBeUndefined();
        expect(stop).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['authority/currentness', 'authority'],
        ['credential attachment', 'credentials'],
    ] as const)(
        'ordinary retirement retries retained process cleanup after %s invalidation',
        async (_label, invalidationKind) => {
            const returnedHandle = deferred<ManagedServiceProcessHandle>();
            const stop = vi.fn()
                .mockRejectedValueOnce(new Error('/private/stop-secret'));
            const dispose = vi.fn()
                .mockRejectedValueOnce(
                    new Error('/private/rollback-dispose-secret'),
                )
                .mockRejectedValueOnce(
                    new Error('/private/retirement-dispose-secret'),
                )
                .mockResolvedValue(undefined);
            const handle = Object.freeze({
                snapshot: () => Object.freeze({
                    id: `late-${invalidationKind}`,
                    instanceId: `late-${invalidationKind}-instance`,
                    state: 'healthy' as const,
                    mode: 'managedSpawn' as const,
                    baseUrl: 'http://127.0.0.1:4313',
                    port: 4_313,
                    pid: 13,
                    startedAtMs: 1,
                    lastHealthyAtMs: 1,
                    diagnostics: Object.freeze([]),
                    diagnosticsTruncated: false,
                }),
                observe: vi.fn(() => Object.freeze({ dispose() {} })),
                waitUntilHealthy: vi.fn(),
                stop,
                dispose,
            }) satisfies ManagedServiceProcessHandle;
            const supervise = vi.fn<
                ManagedServiceProcessSupervisor['supervise']
            >(async () => await returnedHandle.promise);
            const initialResyncDelivered = deferred<void>();
            let invalidateCredentials: (() => void) | null = null;
            const disposeWatch = vi.fn();
            const connectedAccounts = Object.freeze({
                getBinding: vi.fn(),
                requestSelection: vi.fn(),
                materialize: vi.fn(async () => Object.freeze({
                    kind: 'environment' as const,
                    env: Object.freeze({ TOKEN: 'credential-secret' }),
                })),
                listAccounts: async () => {
                    throw new Error('Connected Account listing is outside this fixture');
                },
                materializeListedAccount: async () => {
                    throw new Error('Exact-listed Connected Account materialization is outside this fixture');
                },
                watch: vi.fn((_purpose, listener) => {
                    invalidateCredentials = () => listener(
                        Object.freeze({ kind: 'resync' }),
                    );
                    queueMicrotask(() => {
                        listener(Object.freeze({ kind: 'resync' }));
                        initialResyncDelivered.resolve(undefined);
                    });
                    return Object.freeze({ dispose: disposeWatch });
                }),
            }) satisfies ConnectedAccountsService;
            let current = true;
            const scope = lifecycleScope({
                occurrenceId: `occurrenceId-late-${invalidationKind}`,
                sessionId: `session-late-${invalidationKind}`,
                operationId:
                    `session-demand:session-late-${invalidationKind}:provider-p`,
                isOccurrenceCurrent: () => current,
            });
            const owner = createManagedServicesOwner({
                processSupervisorHost: Object.freeze({
                    custodyOwner: 'daemon' as const,
                    bind: () => Object.freeze({ supervise }),
                }),
                dependencies: Object.freeze({}) as never,
                resolveScope: (candidate) => candidate,
            });
            const services = owner.bindScope(scope, exec, {
                connectedAccounts,
            });
            const supervision = services.supervise({
                ...lifecycleSpec({
                    id: `late-${invalidationKind}`,
                    port: 4_313,
                }),
                credentialBindings: [{
                    purpose: 'provider.inference',
                    request: {
                        kind: 'environment',
                        keys: ['TOKEN'],
                    },
                    injection: {
                        kind: 'environment',
                        targetEnvironmentKeysByMaterializedKey: {
                            TOKEN: 'UPSTREAM_TOKEN',
                        },
                    },
                }],
            });
            await initialResyncDelivered.promise;
            await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());
            if (invalidationKind === 'authority') {
                current = false;
            } else {
                invalidateCredentials!();
            }
            returnedHandle.resolve(handle);

            const supervisionFailure = await supervision.then(
                () => null,
                (error: unknown) => error,
            );
            expect(supervisionFailure).toMatchObject({
                code: 'plugin_managed_service_establishment_failed',
            });
            expect(String(supervisionFailure)).not.toMatch(
                /private|secret/u,
            );
            expect(stop).toHaveBeenCalledOnce();
            expect(dispose).toHaveBeenCalledOnce();
            expect(disposeWatch).toHaveBeenCalledOnce();

            const firstRetirementFailure = await owner.retireGeneration!(
                scope.occurrenceId,
                scope.pluginId,
            ).then(
                () => null,
                (error: unknown) => error,
            );
            expect(firstRetirementFailure).toBeInstanceOf(AggregateError);
            expect(
                (firstRetirementFailure as AggregateError).errors,
            ).toHaveLength(1);
            expect(String(firstRetirementFailure)).not.toMatch(
                /private|secret/u,
            );
            expect(
                (firstRetirementFailure as AggregateError).errors
                    .map(String)
                    .join('\n'),
            ).not.toMatch(/private|secret/u);
            expect(stop).toHaveBeenCalledOnce();
            expect(dispose).toHaveBeenCalledTimes(2);
            expect(disposeWatch).toHaveBeenCalledOnce();

            await expect(owner.retireGeneration!(
                scope.occurrenceId,
                scope.pluginId,
            )).resolves.toBeUndefined();
            await expect(owner.retireGeneration!(
                scope.occurrenceId,
                scope.pluginId,
            )).resolves.toBeUndefined();
            expect(stop).toHaveBeenCalledOnce();
            expect(dispose).toHaveBeenCalledTimes(3);
            expect(disposeWatch).toHaveBeenCalledOnce();
        },
    );

    it('preserves __proto__ environment destinations as own data properties', async () => {
        const harness = createHarness();
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(vi.fn(async () =>
                Object.freeze({
                    kind: 'environment' as const,
                    env: Object.freeze({ TOKEN: 'environment-secret' }),
                }),
            )),
        });

        const handle = await services.supervise({
            id: 'prototype-environment-destination',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'environment', keys: ['TOKEN'] },
                injection: {
                    kind: 'environment',
                    targetEnvironmentKeysByMaterializedKey: {
                        TOKEN: '__proto__',
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4_312 },
                },
            },
        });

        const processSpec = harness.supervise.mock.calls[0]![0];
        const environment = processSpec.launch?.env ?? {};
        expect(Object.hasOwn(environment, '__proto__')).toBe(true);
        expect(environment.__proto__).toBe('environment-secret');
        await handle.dispose();
    });

    it('injects materialized HTTP headers only into the supported health-request consumer', async () => {
        const harness = createHarness();
        const materialize = vi.fn(async () => Object.freeze({
            kind: 'httpHeaders' as const,
            headers: Object.freeze({ authorization: 'Bearer health-secret' }),
        }));
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(materialize),
        });

        await services.supervise({
            id: 'gateway',
            credentialBindings: [{
                purpose: 'provider.health',
                request: {
                    kind: 'httpHeaders',
                    origin: 'http://127.0.0.1:4312',
                    headerNames: ['authorization'],
                },
                injection: {
                    kind: 'httpHeaders',
                    target: 'healthRequests',
                },
            }],
            mode: {
                kind: 'attach',
                baseUrl: 'http://127.0.0.1:4312',
            },
            healthCheck: {
                kind: 'http',
                target: { kind: 'servicePath', path: '/healthz' },
            },
        });

        expect(harness.supervise).toHaveBeenCalledWith(
            expect.objectContaining({
                healthCheck: expect.objectContaining({
                    headers: { authorization: 'Bearer health-secret' },
                }),
            }),
            expect.objectContaining({
                signal: expect.any(AbortSignal),
                registerEstablishmentCleanup: expect.any(Function),
            }),
        );
    });

    it('preserves __proto__ health headers on initial materialization and refresh', async () => {
        const harness = createHarness();
        let headerValue = 'header-secret-a';
        const watchState: { deliverResync?: () => void } = {};
        const connectedAccounts = Object.freeze({
            getBinding: vi.fn(),
            requestSelection: vi.fn(),
            materialize: vi.fn(async () => Object.freeze({
                kind: 'httpHeaders' as const,
                headers: Object.freeze(Object.fromEntries([
                    ['__proto__', headerValue],
                ])),
            })),
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn((_purpose, listener) => {
                watchState.deliverResync = () => listener(
                    Object.freeze({ kind: 'resync' }),
                );
                queueMicrotask(() => listener(
                    Object.freeze({ kind: 'resync' }),
                ));
                return Object.freeze({ dispose() {} });
            }),
        }) satisfies ConnectedAccountsService;
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts,
        });

        const handle = await services.supervise({
            id: 'prototype-health-header',
            credentialBindings: [{
                purpose: 'provider.health',
                request: {
                    kind: 'httpHeaders',
                    origin: 'http://127.0.0.1:4312',
                    headerNames: ['__proto__'],
                },
                injection: {
                    kind: 'httpHeaders',
                    target: 'healthRequests',
                },
            }],
            mode: {
                kind: 'attach',
                baseUrl: 'http://127.0.0.1:4312',
            },
            healthCheck: {
                kind: 'http',
                target: { kind: 'servicePath', path: '/healthz' },
            },
        });

        const processSpec = harness.supervise.mock.calls[0]![0];
        if (processSpec.healthCheck?.kind !== 'http') {
            throw new Error('expected an HTTP health check');
        }
        expect(Object.hasOwn(
            processSpec.healthCheck.headers ?? {},
            '__proto__',
        )).toBe(true);
        expect(processSpec.healthCheck.headers?.__proto__)
            .toBe('header-secret-a');

        headerValue = 'header-secret-b';
        if (!watchState.deliverResync) {
            throw new Error('watch was not registered');
        }
        watchState.deliverResync();
        const refreshed = await processSpec.healthCheck.resolveHeaders?.();
        expect(Object.hasOwn(refreshed?.headers ?? {}, '__proto__')).toBe(true);
        expect(refreshed?.headers.__proto__).toBe('header-secret-b');
        await handle.dispose();
    });

    it('registers credential invalidation before materialization and fences the owned handle after the initial resync', async () => {
        const harness = createHarness();
        let deliverResync: (() => void) | null = null;
        const disposeWatch = vi.fn();
        const connectedAccounts = Object.freeze({
            getBinding: vi.fn(),
            requestSelection: vi.fn(),
            materialize: vi.fn(async () => Object.freeze({
                kind: 'environment' as const,
                env: Object.freeze({ TOKEN: 'secret' }),
            })),
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn((_purpose, listener) => {
                deliverResync = () => listener(Object.freeze({ kind: 'resync' }));
                queueMicrotask(() => listener(Object.freeze({ kind: 'resync' })));
                return Object.freeze({ dispose: disposeWatch });
            }),
        }) satisfies ConnectedAccountsService;
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts,
        });

        await services.supervise({
            id: 'gateway',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'environment', keys: ['TOKEN'] },
                injection: {
                    kind: 'environment',
                    targetEnvironmentKeysByMaterializedKey: {
                        TOKEN: 'UPSTREAM_TOKEN',
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });

        expect(connectedAccounts.watch).toHaveBeenCalledBefore(
            connectedAccounts.materialize,
        );
        expect(deliverResync).not.toBeNull();
        deliverResync!();
        await vi.waitFor(() => {
            expect(harness.legacyHandle.stop).toHaveBeenCalledTimes(1);
            expect(disposeWatch).toHaveBeenCalledTimes(1);
        });
    });

    it.each([
        ['launch environment', {
            mode: {
                kind: 'spawn' as const,
                launch: {
                    executable: {} as never,
                    env: { UPSTREAM_TOKEN: 'ordinary' },
                },
                endpoint: {
                    kind: 'assignAndInject' as const,
                    port: { kind: 'fixed' as const, port: 4312 },
                },
            },
        }],
        ['endpoint injection', {
            mode: {
                kind: 'spawn' as const,
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject' as const,
                    port: { kind: 'fixed' as const, port: 4312 },
                    inject: { portEnvironmentKey: 'UPSTREAM_TOKEN' },
                },
            },
        }],
    ])('rejects credential destination collision with %s before materialization or spawn', async (_label, partial) => {
        const harness = createHarness();
        const materialize = vi.fn();
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(materialize),
        });

        await expect(services.supervise({
            id: 'gateway',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'environment', keys: ['TOKEN'] },
                injection: {
                    kind: 'environment',
                    targetEnvironmentKeysByMaterializedKey: {
                        TOKEN: 'UPSTREAM_TOKEN',
                    },
                },
            }],
            ...partial,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(materialize).not.toHaveBeenCalled();
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('rejects attach environment injection, provider headers, and credential-bearing durable logs before effects', async () => {
        const harness = createHarness();
        const materialize = vi.fn();
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(materialize),
        });
        const binding = {
            purpose: 'provider.inference',
            request: { kind: 'environment' as const, keys: ['TOKEN'] },
            injection: {
                kind: 'environment' as const,
                targetEnvironmentKeysByMaterializedKey: { TOKEN: 'TOKEN' },
            },
        };

        await expect(services.supervise({
            id: 'attach',
            credentialBindings: [binding],
            mode: { kind: 'attach', baseUrl: 'http://127.0.0.1:4312' },
        })).rejects.toMatchObject({ code: 'plugin_managed_service_spec_invalid' });
        await expect(services.supervise({
            id: 'provider-headers',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: {
                    kind: 'httpHeaders',
                    origin: 'http://127.0.0.1:4312',
                    headerNames: ['authorization'],
                },
                injection: {
                    kind: 'httpHeaders',
                    target: 'providerRequests',
                },
            }],
            mode: { kind: 'attach', baseUrl: 'http://127.0.0.1:4312' },
        })).rejects.toMatchObject({ code: 'plugin_managed_service_spec_invalid' });
        await expect(services.supervise({
            id: 'durable',
            credentialBindings: [binding],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
            durableLog: { enabled: true },
        })).rejects.toMatchObject({ code: 'plugin_managed_service_spec_invalid' });
        await expect(services.supervise({
            id: 'durable-attach',
            credentialBindings: [{
                purpose: 'provider.health',
                request: {
                    kind: 'httpHeaders',
                    origin: 'http://127.0.0.1:4312',
                    headerNames: ['authorization'],
                },
                injection: {
                    kind: 'httpHeaders',
                    target: 'healthRequests',
                },
            }],
            mode: {
                kind: 'attach',
                baseUrl: 'http://127.0.0.1:4312',
            },
            healthCheck: {
                kind: 'http',
                target: { kind: 'servicePath', path: '/healthz' },
            },
            durableLog: { enabled: true },
        } as never)).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(materialize).not.toHaveBeenCalled();
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('cleans private files when establishment fails and does not disclose materialized secrets', async () => {
        const harness = createHarness();
        const secret = 'must-not-escape';
        harness.supervise.mockRejectedValueOnce(new Error(secret));
        const releaseFiles = vi.fn(async () => undefined);
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(vi.fn(async () => Object.freeze({
                kind: 'files' as const,
                files: Object.freeze({
                    config: new TextEncoder().encode(secret),
                }),
            }))),
            credentialFiles: Object.freeze({
                materialize: vi.fn(async ({ retainCleanup }) => {
                    const lease = Object.freeze({
                        pathsByFileId: Object.freeze({
                            config: '/private/session-one/config',
                        }),
                        dispose: releaseFiles,
                    });
                    retainCleanup(lease);
                    return lease;
                }),
            }),
        });

        const failure = await services.supervise({
            id: 'gateway',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        }).catch((error: unknown) => error);

        expect(failure).toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(String((failure as Error).message)).not.toContain(secret);
        expect(releaseFiles).toHaveBeenCalledTimes(1);
    });

    it('blocks replacement establishment until failed startup file cleanup succeeds', async () => {
        const harness = createHarness();
        harness.supervise.mockRejectedValueOnce(
            new Error('managed child establishment failed'),
        );
        let cleanupAllowed = false;
        const releaseFiles = vi.fn(async () => {
            if (!cleanupAllowed) {
                throw new Error('transient cleanup failure');
            }
        });
        const materializeFiles = vi.fn(async ({ retainCleanup }:
            CredentialFileMaterializeInput) => {
            const lease = Object.freeze({
                pathsByFileId: Object.freeze({
                    config: '/private/session-one/config',
                }),
                dispose: releaseFiles,
            });
            retainCleanup(lease);
            return lease;
        });
        const connectedMaterialize = vi.fn(async () => Object.freeze({
            kind: 'files' as const,
            files: Object.freeze({
                config: new Uint8Array([0x01]),
            }),
        }));
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(connectedMaterialize),
            credentialFiles: Object.freeze({ materialize: materializeFiles }),
        });
        const spec = {
            id: 'failed-startup-cleanup',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files' as const, fileIds: ['config'] },
                injection: {
                    kind: 'files' as const,
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn' as const,
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject' as const,
                    port: { kind: 'fixed' as const, port: 4_312 },
                },
            },
        } satisfies ManagedServiceSpec;

        await expect(services.supervise(spec)).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(releaseFiles).toHaveBeenCalledTimes(1);

        await expect(services.supervise(spec)).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(releaseFiles).toHaveBeenCalledTimes(2);
        expect(connectedMaterialize).toHaveBeenCalledOnce();
        expect(materializeFiles).toHaveBeenCalledOnce();
        expect(harness.supervise).toHaveBeenCalledOnce();

        cleanupAllowed = true;
        await expect(harness.owner.retireGeneration!(
            harness.scope.occurrenceId,
            harness.scope.pluginId,
        )).resolves.toBeUndefined();
        expect(releaseFiles).toHaveBeenCalledTimes(3);
    });

    it('retains cleanup custody when credential materialization fails after a file lease is acquired', async () => {
        const harness = createHarness();
        let cleanupAllowed = false;
        const releaseFiles = vi.fn(async () => {
            if (!cleanupAllowed) {
                throw new Error('transient cleanup failure');
            }
        });
        const connectedMaterialize = vi.fn(async (_purpose, request) => {
            if (request.kind === 'files') {
                return Object.freeze({
                    kind: 'files' as const,
                    files: Object.freeze({
                        config: new Uint8Array([0x01]),
                    }),
                });
            }
            throw new Error('later credential materialization failed');
        });
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(connectedMaterialize),
            credentialFiles: Object.freeze({
                materialize: vi.fn(async ({ retainCleanup }) => {
                    const lease = Object.freeze({
                        pathsByFileId: Object.freeze({
                            config: '/private/session-one/config',
                        }),
                        dispose: releaseFiles,
                    });
                    retainCleanup(lease);
                    return lease;
                }),
            }),
        });

        await expect(services.supervise({
            id: 'partial-credential-materialization',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }, {
                purpose: 'provider.inference',
                request: { kind: 'environment', keys: ['TOKEN'] },
                injection: {
                    kind: 'environment',
                    targetEnvironmentKeysByMaterializedKey: {
                        TOKEN: 'UPSTREAM_TOKEN',
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4_312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(releaseFiles).toHaveBeenCalledOnce();
        expect(harness.supervise).not.toHaveBeenCalled();

        cleanupAllowed = true;
        await expect(harness.owner.retireGeneration!(
            harness.scope.occurrenceId,
            harness.scope.pluginId,
        )).resolves.toBeUndefined();
        expect(releaseFiles).toHaveBeenCalledTimes(2);
    });

    it('blocks replacement until cleanup retained before a failed credential-file write succeeds', async () => {
        const harness = createHarness();
        let cleanupAllowed = false;
        const failedRelease = vi.fn(async () => {
            if (!cleanupAllowed) {
                throw new Error('transient cleanup failure');
            }
        });
        const successfulRelease = vi.fn(async () => undefined);
        const materializeFiles = vi.fn()
            .mockImplementationOnce(async ({ retainCleanup }:
                CredentialFileMaterializeInput) => {
                const cleanup = Object.freeze({ dispose: failedRelease });
                retainCleanup(cleanup);
                try {
                    await cleanup.dispose();
                } catch (cleanupError) {
                    throw new AggregateError(
                        [
                            new Error('later credential write failed'),
                            cleanupError,
                        ],
                        'Credential-file acquisition and rollback failed',
                    );
                }
                throw new Error('expected local rollback to fail');
            })
            .mockImplementationOnce(async ({ retainCleanup }:
                CredentialFileMaterializeInput) => {
                const lease = Object.freeze({
                    pathsByFileId: Object.freeze({
                        config: '/private/session-one/config',
                    }),
                    dispose: successfulRelease,
                });
                retainCleanup(lease);
                return lease;
            });
        const connectedMaterialize = vi.fn(async () => Object.freeze({
            kind: 'files' as const,
            files: Object.freeze({
                config: new Uint8Array([0x01]),
            }),
        }));
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(connectedMaterialize),
            credentialFiles: Object.freeze({ materialize: materializeFiles }),
        });
        const spec = {
            id: 'failed-file-write-cleanup',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files' as const, fileIds: ['config'] },
                injection: {
                    kind: 'files' as const,
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn' as const,
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject' as const,
                    port: { kind: 'fixed' as const, port: 4_312 },
                },
            },
        } satisfies ManagedServiceSpec;

        await expect(services.supervise(spec)).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(failedRelease).toHaveBeenCalledTimes(2);

        await expect(services.supervise(spec)).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(failedRelease).toHaveBeenCalledTimes(3);
        expect(materializeFiles).toHaveBeenCalledOnce();
        expect(harness.supervise).not.toHaveBeenCalled();

        cleanupAllowed = true;
        const handle = await services.supervise(spec);
        expect(failedRelease).toHaveBeenCalledTimes(4);
        expect(materializeFiles).toHaveBeenCalledTimes(2);
        expect(harness.supervise).toHaveBeenCalledOnce();

        await handle.dispose();
        expect(successfulRelease).toHaveBeenCalledOnce();
    });

    it('rejects malformed materialization shapes and missing private-file custody before spawn', async () => {
        const malformed = createHarness();
        const malformedMaterialize = vi.fn(async () => Object.freeze({
            kind: 'environment' as const,
            env: Object.freeze({}),
        }));
        const malformedServices = malformed.owner.bindScope(
            malformed.scope,
            exec,
            {
                connectedAccounts:
                    createConnectedAccounts(malformedMaterialize),
            },
        );
        const environmentBinding = {
            purpose: 'provider.inference',
            request: { kind: 'environment' as const, keys: ['TOKEN'] },
            injection: {
                kind: 'environment' as const,
                targetEnvironmentKeysByMaterializedKey: {
                    TOKEN: 'UPSTREAM_TOKEN',
                },
            },
        };

        await expect(malformedServices.supervise({
            id: 'malformed',
            credentialBindings: [environmentBinding],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(malformed.supervise).not.toHaveBeenCalled();

        const missingFiles = createHarness();
        const missingFilesServices = missingFiles.owner.bindScope(
            missingFiles.scope,
            exec,
            {
                connectedAccounts: createConnectedAccounts(vi.fn(async () => Object.freeze({
                    kind: 'files' as const,
                    files: Object.freeze({
                        config: new Uint8Array([1, 2, 3]),
                    }),
                }))),
            },
        );
        await expect(missingFilesServices.supervise({
            id: 'missing-files',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(missingFiles.supervise).not.toHaveBeenCalled();
    });

    it('releases private files even when the underlying stop fails', async () => {
        const harness = createHarness();
        harness.legacyHandle.stop.mockRejectedValueOnce(
            new Error('underlying stop failed'),
        );
        const releaseFiles = vi.fn(async () => undefined);
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(vi.fn(async () => Object.freeze({
                kind: 'files' as const,
                files: Object.freeze({ config: new Uint8Array([1]) }),
            }))),
            credentialFiles: Object.freeze({
                materialize: vi.fn(async ({ retainCleanup }) => {
                    const lease = Object.freeze({
                        pathsByFileId: Object.freeze({ config: '/private/config' }),
                        dispose: releaseFiles,
                    });
                    retainCleanup(lease);
                    return lease;
                }),
            }),
        });
        const handle = await services.supervise({
            id: 'gateway',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });

        await expect(handle.stop()).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(releaseFiles).toHaveBeenCalledTimes(1);
    });

    it('keeps process custody retryable when private stop reports incomplete termination', async () => {
        const harness = createHarness();
        harness.legacyHandle.stop
            .mockResolvedValueOnce(Object.freeze({
                status: 'termination_incomplete' as const,
            }))
            .mockResolvedValueOnce(Object.freeze({
                status: 'stopped' as const,
            }));
        const releaseFiles = vi.fn(async () => undefined);
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(vi.fn(async () => Object.freeze({
                kind: 'files' as const,
                files: Object.freeze({ config: new Uint8Array([1]) }),
            }))),
            credentialFiles: Object.freeze({
                materialize: vi.fn(async ({ retainCleanup }) => {
                    const lease = Object.freeze({
                        pathsByFileId: Object.freeze({ config: '/private/config' }),
                        dispose: releaseFiles,
                    });
                    retainCleanup(lease);
                    return lease;
                }),
            }),
        });
        const handle = await services.supervise({
            id: 'incomplete-termination',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });

        await expect(handle.stop()).rejects.toMatchObject({
            code: 'plugin_managed_server_termination_incomplete',
        });
        expect(harness.legacyHandle.stop).toHaveBeenCalledTimes(1);
        expect(releaseFiles).toHaveBeenCalledTimes(1);
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(1);

        await expect(handle.stop()).resolves.toEqual({ status: 'stopped' });
        expect(harness.legacyHandle.stop).toHaveBeenCalledTimes(2);
        expect(releaseFiles).toHaveBeenCalledTimes(1);
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(0);
    });

    it('cancels shared establishment only after its last waiter aborts', async () => {
        let establishmentSignal: AbortSignal | undefined;
        const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>(
            async (_spec, options) => await new Promise<ManagedServiceProcessHandle>(
                (_resolve, reject) => {
                    establishmentSignal = options?.signal;
                    options?.signal?.addEventListener('abort', () => {
                        reject(new Error('establishment aborted'));
                    }, { once: true });
                },
            ),
        );
        const owner = createManagedServicesOwner({
            processSupervisorHost: Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: () => Object.freeze({ supervise }),
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const services = owner.bindScope(lifecycleScope({
            occurrenceId: 'occurrenceId-waiters',
            operationId: 'operation-waiters',
        }), exec);
        const firstAbort = new AbortController();
        const secondAbort = new AbortController();
        const spec = lifecycleSpec({ id: 'gateway', port: 4_312 });

        const first = services.supervise(spec, { signal: firstAbort.signal });
        const second = services.supervise(spec, { signal: secondAbort.signal });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());

        firstAbort.abort();
        await expect(first).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });
        expect(establishmentSignal?.aborted).toBe(false);

        secondAbort.abort();
        await expect(second).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });
        expect(establishmentSignal?.aborted).toBe(true);
    });

    it('fences an ignored-abort late handle and restarts after exact cleanup succeeds', async () => {
        const returnedHandle = deferred<ManagedServiceProcessHandle>();
        const stop = vi.fn(async () => {
            throw new Error('/private/late-stop-secret');
        });
        const dispose = vi.fn()
            .mockRejectedValueOnce(new Error('/private/late-dispose-secret'))
            .mockResolvedValueOnce(undefined);
        const handle = Object.freeze({
            snapshot: () => Object.freeze({
                id: 'abandoned-late-handle',
                instanceId: 'abandoned-late-instance',
                state: 'healthy' as const,
                mode: 'managedSpawn' as const,
                baseUrl: 'http://127.0.0.1:4312',
                port: 4_312,
                pid: 12,
                startedAtMs: 1,
                lastHealthyAtMs: 1,
                diagnostics: Object.freeze([]),
                diagnosticsTruncated: false,
            }),
            observe: vi.fn(() => Object.freeze({ dispose() {} })),
            waitUntilHealthy: vi.fn(),
            stop,
            dispose,
        }) satisfies ManagedServiceProcessHandle;
        const replacementDispose = vi.fn(async () => undefined);
        const replacementHandle = Object.freeze({
            snapshot: () => Object.freeze({
                id: 'abandoned-late-handle',
                instanceId: 'replacement-late-instance',
                state: 'healthy' as const,
                mode: 'managedSpawn' as const,
                baseUrl: 'http://127.0.0.1:4313',
                port: 4_313,
                pid: 13,
                startedAtMs: 2,
                lastHealthyAtMs: 2,
                diagnostics: Object.freeze([]),
                diagnosticsTruncated: false,
            }),
            observe: vi.fn(() => Object.freeze({ dispose() {} })),
            waitUntilHealthy: vi.fn(),
            stop: vi.fn(async () => Object.freeze({
                status: 'stopped' as const,
            })),
            dispose: replacementDispose,
        }) satisfies ManagedServiceProcessHandle;
        let replacementStartedAfterCleanup = false;
        const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>()
            .mockImplementationOnce(async () => await returnedHandle.promise)
            .mockImplementationOnce(async () => {
                replacementStartedAfterCleanup = dispose.mock.calls.length === 2;
                return replacementHandle;
            });
        const owner = createManagedServicesOwner({
            processSupervisorHost: Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: () => Object.freeze({ supervise }),
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const services = owner.bindScope(lifecycleScope({
            occurrenceId: 'occurrenceId-abandoned-late-handle',
            operationId: 'operation-abandoned-late-handle',
        }), exec);
        const abort = new AbortController();
        const spec = lifecycleSpec({
            id: 'abandoned-late-handle',
            port: 4_312,
        });

        const abandoned = services.supervise(spec, {
            signal: abort.signal,
        });
        await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());
        abort.abort();
        await expect(abandoned).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });

        returnedHandle.resolve(handle);
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
        expect(stop).toHaveBeenCalledOnce();

        const restarted = await services.supervise(spec);
        expect(restarted.snapshot()).toMatchObject({
            baseUrl: 'http://127.0.0.1:4313',
        });
        expect(supervise).toHaveBeenCalledTimes(2);
        expect(replacementStartedAfterCleanup).toBe(true);
        expect(dispose).toHaveBeenCalledTimes(2);
        await expect(owner.dispose()).resolves.toBeUndefined();
        await expect(owner.dispose()).resolves.toBeUndefined();
        expect(stop).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(replacementDispose).toHaveBeenCalledOnce();
    });

    it('retires every daemon-owned service without affecting borrowed or live runner-owned services and retains incomplete cleanup', async () => {
        const firstProcess = createLifecycleProcess(4_101);
        let terminationIncomplete = true;
        const secondProcess = createLifecycleProcess(4_102, () => {
            if (terminationIncomplete) {
                throw new PluginError({
                    code: 'plugin_exec_termination_incomplete',
                    message: 'Exact process tree remained live',
                });
            }
        });
        const otherDaemonProcess = createLifecycleProcess(4_103);
        const runnerProcess = createLifecycleProcess(4_104);
        const daemon = createLifecycleHarness([firstProcess, secondProcess], 'daemon');
        const otherDaemon = createLifecycleHarness([otherDaemonProcess], 'daemon');
        const runner = createLifecycleHarness([runnerProcess], 'sessionRunner');
        const bindDaemon = (operationId: string) => daemon.owner.bindScope(
            lifecycleScope({ occurrenceId: 'daemon-occurrence', operationId }),
            daemon.exec,
        );
        const first = await bindDaemon('connected-one').supervise(lifecycleSpec({
            id: 'opencode-server', port: 4_311,
        }));
        const second = await bindDaemon('connected-two').supervise(lifecycleSpec({
            id: 'opencode-server', port: 4_312,
        }));
        const other = await otherDaemon.owner.bindScope(
            lifecycleScope({ occurrenceId: 'other-daemon-occurrence', operationId: 'connected-one' }),
            otherDaemon.exec,
        ).supervise(lifecycleSpec({ id: 'opencode-server', port: 4_313 }));
        const active = await runner.owner.bindScope(
            lifecycleScope({ occurrenceId: 'runner-occurrence', sessionId: 'live-session' }),
            runner.exec,
        ).supervise(lifecycleSpec({ id: 'opencode-server', port: 4_314 }));
        const borrowed = await bindDaemon('borrowed-endpoint').supervise({
            id: 'opencode-server',
            mode: { kind: 'attach', baseUrl: other.snapshot().baseUrl! },
            healthCheck: { kind: 'none' },
        });

        try {
            await expect(daemon.owner.dispose()).rejects.toBeInstanceOf(AggregateError);
            expect(first.snapshot().state).toBe('stopped');
            expect(second.snapshot().state).not.toBe('stopped');
            expect(borrowed.snapshot().state).toBe('stopped');
            expect(other.snapshot().state).toBe('healthy');
            expect(active.snapshot().state).toBe('healthy');
            expect(otherDaemonProcess.dispose).not.toHaveBeenCalled();
            expect(runnerProcess.dispose).not.toHaveBeenCalled();

            terminationIncomplete = false;
            await expect(daemon.owner.dispose()).resolves.toBeUndefined();
            expect(second.snapshot().state).toBe('stopped');
            expect(firstProcess.dispose).toHaveBeenCalledOnce();
            expect(secondProcess.dispose).toHaveBeenCalledTimes(2);
            expect(other.snapshot().state).toBe('healthy');
            expect(active.snapshot().state).toBe('healthy');
        } finally {
            terminationIncomplete = false;
            await Promise.all([daemon.owner.dispose(), otherDaemon.owner.dispose(), runner.owner.dispose()]);
        }
    });

    it('retains real supervisor cleanup custody when post-spawn establishment cleanup fails', async () => {
        const exit = deferred<PluginProcessResult>();
        const process = Object.freeze({
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => await exit.promise),
            onOutput: vi.fn(() => Object.freeze({ dispose() {} })),
            dispose: vi.fn()
                .mockRejectedValueOnce(
                    new Error('/private/raw-process-secret'),
                )
                .mockImplementationOnce(async () => {
                    exit.resolve(MANAGED_SERVICE_CLEAN_EXIT);
                }),
        }) satisfies PluginProcessHandle;
        associateSupervisedPluginProcessHandleForHost(process, { pid: 4_242 });
        const processSupervisorHost = createManagedServiceProcessSupervisorHost({
            createInstanceId: () => 'post-spawn-cleanup-custody',
            durability: Object.freeze({
                publishEndpointProjection: vi.fn(),
                releaseEndpointProjection: vi.fn(),
                resolveEndpointProjection: vi.fn(),
                openLog: vi.fn(),
            }) as never,
            captureProcessStartIdentity: async () => {
                throw new Error('/private/process-identity-secret');
            },
        });
        const owner = createManagedServicesOwner({
            processSupervisorHost,
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const services = owner.bindScope(lifecycleScope({
            occurrenceId: 'occurrenceId-post-spawn-cleanup',
            operationId: 'operation-post-spawn-cleanup',
        }), createLifecycleExec([process]));

        const establishmentError = await services.supervise(lifecycleSpec({
            id: 'post-spawn-cleanup',
            port: 4_313,
        })).then(
            () => null,
            (error: unknown) => error,
        );

        expect(establishmentError).toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(String(establishmentError)).not.toMatch(/private|secret/u);
        expect(process.dispose).toHaveBeenCalledOnce();

        await expect(owner.dispose()).resolves.toBeUndefined();
        await expect(owner.dispose()).resolves.toBeUndefined();
        expect(process.dispose).toHaveBeenCalledTimes(2);
    });

    it('retries failed credential cleanup without repeating successful handle cleanup', async () => {
        const harness = createHarness();
        const releaseFiles = vi.fn()
            .mockRejectedValueOnce(new Error('transient cleanup failure'))
            .mockResolvedValueOnce(undefined);
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(vi.fn(async () => Object.freeze({
                kind: 'files' as const,
                files: Object.freeze({ config: new Uint8Array([1]) }),
            }))),
            credentialFiles: Object.freeze({
                materialize: vi.fn(async ({ retainCleanup }) => {
                    const lease = Object.freeze({
                        pathsByFileId: Object.freeze({ config: '/private/config' }),
                        dispose: releaseFiles,
                    });
                    retainCleanup(lease);
                    return lease;
                }),
            }),
        });
        const handle = await services.supervise({
            id: 'retry-cleanup',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4_312 },
                },
            },
        });

        await expect(handle.dispose()).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        await expect(handle.dispose()).resolves.toBeUndefined();
        expect(releaseFiles).toHaveBeenCalledTimes(2);
        expect(harness.legacyHandle.dispose).toHaveBeenCalledOnce();
    });

    it('continues private-file cleanup when credential-watch disposal fails', async () => {
        const harness = createHarness();
        const cleanupOrder: string[] = [];
        const releaseFiles = vi.fn(async () => {
            cleanupOrder.push('files');
        });
        const connectedAccounts = Object.freeze({
            ...createConnectedAccounts(vi.fn(async () => Object.freeze({
                kind: 'files' as const,
                files: Object.freeze({ config: new Uint8Array([1]) }),
            }))),
            watch: vi.fn(() => Object.freeze({
                dispose() {
                    cleanupOrder.push('watch');
                    throw new Error('watch disposal failed');
                },
            })),
        });
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts,
            credentialFiles: Object.freeze({
                materialize: vi.fn(async ({ retainCleanup }) => {
                    const lease = Object.freeze({
                        pathsByFileId: Object.freeze({ config: '/private/config' }),
                        dispose: releaseFiles,
                    });
                    retainCleanup(lease);
                    return lease;
                }),
            }),
        });
        const handle = await services.supervise({
            id: 'gateway',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        });

        await expect(handle.dispose()).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(releaseFiles).toHaveBeenCalledTimes(1);
        expect(cleanupOrder).toEqual(['files', 'watch']);
    });

    it('rechecks current invocation authorization after materialization and before the child effect', async () => {
        const harness = createHarness();
        const materialize = vi.fn(async () => {
            harness.authorization.current = false;
            return Object.freeze({
                kind: 'environment' as const,
                env: Object.freeze({ TOKEN: 'secret' }),
            });
        });
        const services = harness.owner.bindScope(harness.scope, exec, {
            connectedAccounts: createConnectedAccounts(materialize),
        });

        await expect(services.supervise({
            id: 'gateway',
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'environment', keys: ['TOKEN'] },
                injection: {
                    kind: 'environment',
                    targetEnvironmentKeysByMaterializedKey: {
                        TOKEN: 'UPSTREAM_TOKEN',
                    },
                },
            }],
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(materialize).toHaveBeenCalledTimes(1);
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('uses the host correlation as the bounded lifecycle for generic non-Session bindWithExec calls', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const context = Object.freeze({
            connectedAccounts: null,
            credentialFiles: null,
            declaredSecretReadPort: null,
            managedProvider: null,
            requestAuth: null,
        });
        const seed = (correlationId: string) => Object.freeze({
            plugin: Object.freeze({
                id: 'acme.providers',
                version: '1.0.0',
            }),
            contribution: Object.freeze({
                id: 'gateway',
                qualifiedId: 'acme.providers/providers/gateway',
            }),
            occurrenceId: 'provider-p',
            correlationId,
            surface: 'background' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });
        const spec = lifecycleSpec({
            id: 'gateway',
            port: 43_120,
        });

        const first = await harness.owner.bindWithExec!(
            seed('catalog-probe:one'),
            harness.exec,
            context,
        )!.supervise(spec);
        const second = await harness.owner.bindWithExec!(
            seed('catalog-probe:two'),
            harness.exec,
            context,
        )!.supervise(spec);

        await Promise.all([first.dispose(), second.dispose()]);

        expect(second).not.toBe(first);
        expect(harness.exec.spawn).toHaveBeenCalledTimes(2);
    });

    it('bounds a Session-bearing daemon invocation to its operation correlation and retires it with the occurrenceId', async () => {
        const process = createLifecycleProcess(8_200);
        const harness = createLifecycleHarness([process], 'daemon');
        const context = Object.freeze({
            connectedAccounts: null,
            credentialFiles: null,
            declaredSecretReadPort: null,
            managedProvider: null,
            requestAuth: null,
        });
        const services = harness.owner.bindWithExec!(Object.freeze({
            plugin: Object.freeze({
                id: 'acme.providers',
                version: '1.0.0',
            }),
            contribution: Object.freeze({
                id: 'gateway',
                qualifiedId: 'acme.providers/providers/gateway',
            }),
            occurrenceId: 'provider-p',
            correlationId: 'mcp:session-one:ordinary-call',
            surface: 'mcp' as const,
            session: Object.freeze({ id: 'session-one' }),
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }), harness.exec, context)!;
        const handle = await services.supervise(lifecycleSpec({
            id: 'gateway',
            port: 43_119,
        }));

        await harness.owner.retireGeneration!(
            'provider-p',
            'acme.providers',
        );

        expect(process.dispose).toHaveBeenCalledOnce();
        expect(handle.snapshot().state).toBe('stopped');
    });

    it('refuses daemon custody when Session context has no bounded operation identity', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const services = harness.owner.bindScope(lifecycleScope({
            occurrenceId: 'provider-p',
            sessionId: 'session-one',
        }), harness.exec);

        await expect(services.supervise(lifecycleSpec({
            id: 'gateway',
            port: 43_118,
        }))).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(harness.exec.spawn).not.toHaveBeenCalled();
    });

    it('preserves the explicit-start owner claim through invocation-service projection while keeping bounded probes separate', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const createServices = (
            operationClaimId: string,
            correlationId: string,
        ) => {
            const seed = Object.freeze({
                plugin: Object.freeze({
                    id: 'acme.providers',
                    version: '1.0.0',
                }),
                contribution: Object.freeze({
                    id: 'gateway',
                    qualifiedId:
                        'acme.providers/providers/gateway',
                }),
                occurrenceId: 'provider-p',
                correlationId,
                surface: 'cli' as const,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            });
            const binding =
                withPluginInvocationServiceBindingAvailability(
                    createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                        seed.occurrenceId,
                        `binding:${correlationId}`,
                    ),
                    {
                        serviceId: 'managedServices',
                        availability: 'available',
                    },
                );
            const createInvocationServices =
                createPluginInvocationServicesFactory({
                    loggerSink: { write() {} },
                    events: {
                        broker: createStablePluginEventsBroker(),
                        declarationsByPluginId: new Map(),
                        activePluginIds: new Set(),
                    },
                    managedProviderRuntime: Object.freeze({
                        realm: 'managedProviderStart' as const,
                        providerLocalId: 'gateway',
                        operationClaimId,
                        requestAuth: null,
                        isCurrent: () => true,
                    }),
                    managedServices: Object.freeze({
                        ...harness.owner,
                        bindWithExec(invocationSeed, _exec, context) {
                            return harness.owner.bindWithExec!(
                                invocationSeed,
                                harness.exec,
                                context,
                            );
                        },
                    }),
                });
            return createInvocationServices(seed, binding).managedServices;
        };
        const spec = lifecycleSpec({ id: 'gateway' });
        const explicitClaim = JSON.stringify([
            'managed-provider-explicit-start',
            'machine-1',
            'acme.providers',
            'gateway',
        ]);

        const [explicitFirst, explicitRetry] = await Promise.all([
            createServices(
                explicitClaim,
                'explicit-start:request-one',
            ).supervise(spec),
            createServices(
                explicitClaim,
                'explicit-start:request-two',
            ).supervise(spec),
        ]);

        expect(explicitRetry).toBe(explicitFirst);
        expect(harness.exec.spawn).toHaveBeenCalledTimes(1);

        const [probeOne, probeTwo] = await Promise.all([
            createServices(
                'managed-provider-bounded:probe-one',
                'catalog-probe:one',
            ).supervise(spec),
            createServices(
                'managed-provider-bounded:probe-two',
                'catalog-probe:two',
            ).supervise(spec),
        ]);

        expect(probeOne).not.toBe(explicitFirst);
        expect(probeTwo).not.toBe(explicitFirst);
        expect(probeTwo).not.toBe(probeOne);
        expect(harness.exec.spawn).toHaveBeenCalledTimes(3);

        await Promise.all([
            explicitFirst.dispose(),
            probeOne.dispose(),
            probeTwo.dispose(),
        ]);
    });

    it('returns one public handle for the same exact lifecycle scope and canonical spec while rejecting a changed spec', async () => {
        const process = createLifecycleProcess(8_201);
        const harness = createLifecycleHarness([process]);
        const scope = lifecycleScope({
            occurrenceId: 'provider-p',
            sessionId: 'session-exact-scope',
            operationId: 'session-demand:session-exact-scope:provider-p',
        });
        const firstServices = harness.owner.bindScope(
            scope,
            harness.exec,
        );
        const replacementDaemonServices = harness.owner.bindScope(
            lifecycleScope({
                occurrenceId: scope.occurrenceId,
                sessionId: scope.sessionId,
                operationId: scope.operationId,
            }),
            harness.exec,
        );
        const [first, joined] = await Promise.all([
            firstServices.supervise(lifecycleSpec({
                id: 'gateway',
                port: 43_121,
                args: Object.freeze(['serve']),
                environment: Object.freeze({ B: '2', A: '1' }),
            })),
            replacementDaemonServices.supervise(lifecycleSpec({
                id: 'gateway',
                port: 43_121,
                args: Object.freeze(['serve']),
                environment: Object.freeze({ A: '1', B: '2' }),
            })),
        ]);
        const changedSpecError = await replacementDaemonServices.supervise(
            lifecycleSpec({
                id: 'gateway',
                port: 43_121,
                args: Object.freeze(['serve', '--changed']),
                environment: Object.freeze({ A: '1', B: '2' }),
            }),
        ).then(
            () => null,
            (error: unknown) => error,
        );

        await first.dispose();

        expect(joined).toBe(first);
        expect(harness.exec.spawn).toHaveBeenCalledOnce();
        expect(changedSpecError).toMatchObject({
            code: 'plugin_managed_service_spec_conflict',
        });
        expect(process.dispose).toHaveBeenCalledOnce();
    });

    it('restarts an exact lifecycle entry after its terminal process cleanup completes', async () => {
        const cleanupStarted = deferred<void>();
        const releaseCleanup = deferred<void>();
        const firstProcess = Object.freeze({
            write: vi.fn(async () => undefined),
            closeStdin: vi.fn(async () => undefined),
            wait: vi.fn(async () => MANAGED_SERVICE_CLEAN_EXIT),
            onOutput: vi.fn(() => Object.freeze({ dispose() {} })),
            dispose: vi.fn(async () => {
                cleanupStarted.resolve(undefined);
                await releaseCleanup.promise;
            }),
        }) satisfies PluginProcessHandle;
        associateSupervisedPluginProcessHandleForHost(firstProcess, { pid: 8_205 });
        const secondProcess = createLifecycleProcess(8_206);
        const harness = createLifecycleHarness([firstProcess, secondProcess]);
        const services = harness.owner.bindScope(lifecycleScope({
            occurrenceId: 'provider-p',
            sessionId: 'session-terminal-process',
            operationId:
                'session-demand:session-terminal-process:provider-p',
        }), harness.exec);
        const spec = lifecycleSpec({
            id: 'gateway',
            port: 43_120,
        });

        const first = await services.supervise(spec);
        await cleanupStarted.promise;
        const restart = services.supervise(spec);
        await vi.waitFor(() => {
            expect(harness.exec.spawn).toHaveBeenCalledOnce();
        });
        releaseCleanup.resolve(undefined);
        const second = await restart;

        expect(second).not.toBe(first);
        expect(harness.exec.spawn).toHaveBeenCalledTimes(2);
        expect(firstProcess.dispose).toHaveBeenCalledOnce();
        expect(secondProcess.dispose).not.toHaveBeenCalled();
    });

    it('surfaces failed terminal cleanup and retains the entry for permanent disposal', async () => {
        const healthySnapshot = Object.freeze({
            id: 'terminal-cleanup',
            instanceId: 'terminal-cleanup-instance',
            state: 'healthy' as const,
            mode: 'managedSpawn' as const,
            baseUrl: 'http://127.0.0.1:43120',
            port: 43_120,
            pid: 8_206,
            startedAtMs: 1,
            lastHealthyAtMs: 1,
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        });
        let currentSnapshot = healthySnapshot as
            ReturnType<ManagedServiceProcessHandle['snapshot']>;
        const observationListeners = new Set<(snapshot: ReturnType<ManagedServiceProcessHandle['snapshot']>) => void>();
        const disposeProcess = vi.fn(async () => undefined);
        const processHandle = Object.freeze({
            snapshot: () => currentSnapshot,
            observe: vi.fn((listener) => {
                observationListeners.add(listener);
                listener(currentSnapshot);
                return Object.freeze({ dispose: () => observationListeners.delete(listener) });
            }),
            waitUntilHealthy: vi.fn(async () => currentSnapshot),
            stop: vi.fn(async () => Object.freeze({
                status: 'stopped' as const,
            })),
            dispose: disposeProcess,
        }) satisfies ManagedServiceProcessHandle;
        const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>(
            async () => processHandle,
        );
        const disposeWatch = vi.fn()
            .mockImplementationOnce(() => {
                throw new Error('/private/terminal-cleanup-secret');
            })
            .mockImplementationOnce(() => {
                throw new Error('/private/permanent-cleanup-secret');
            })
            .mockImplementation(() => undefined);
        const connectedAccounts = Object.freeze({
            ...createConnectedAccounts(vi.fn(async () => Object.freeze({
                kind: 'environment' as const,
                env: Object.freeze({ TOKEN: 'credential-secret' }),
            }))),
            watch: vi.fn(() => Object.freeze({ dispose: disposeWatch })),
        }) satisfies ConnectedAccountsService;
        const owner = createManagedServicesOwner({
            processSupervisorHost: Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: () => Object.freeze({ supervise }),
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const services = owner.bindScope(lifecycleScope({
            occurrenceId: 'provider-terminal-cleanup',
            sessionId: 'session-terminal-cleanup',
            operationId:
                'session-demand:session-terminal-cleanup:provider-p',
        }), exec, { connectedAccounts });
        const spec = Object.freeze({
            ...lifecycleSpec({ id: 'terminal-cleanup', port: 43_120 }),
            credentialBindings: Object.freeze([Object.freeze({
                purpose: 'provider.inference',
                request: Object.freeze({
                    kind: 'environment' as const,
                    keys: Object.freeze(['TOKEN']),
                }),
                injection: Object.freeze({
                    kind: 'environment' as const,
                    targetEnvironmentKeysByMaterializedKey: Object.freeze({
                        TOKEN: 'UPSTREAM_TOKEN',
                    }),
                }),
            })]),
        }) satisfies ManagedServiceSpec;

        await services.supervise(spec);
        currentSnapshot = Object.freeze({
            ...healthySnapshot,
            state: 'unhealthy',
            diagnostics: Object.freeze([Object.freeze({
                code: 'plugin_managed_server_process_exited',
                severity: 'error' as const,
            })]),
        });
        for (const listener of [...observationListeners]) listener(currentSnapshot);
        await vi.waitFor(() => {
            expect(disposeWatch).toHaveBeenCalledOnce();
        });

        expect(disposeProcess).toHaveBeenCalledOnce();
        // Failed credential cleanup retains the semantic entry and its
        // activity observation until permanent cleanup settles it.
        expect(owner.readRetainedSemanticCustodyCount()).toBe(1);
        await expect(services.supervise(spec)).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(disposeWatch).toHaveBeenCalledTimes(2);

        await expect(owner.dispose()).resolves.toBeUndefined();
        expect(disposeProcess).toHaveBeenCalledOnce();
        expect(observationListeners.size).toBe(0);
        expect(disposeWatch).toHaveBeenCalledTimes(3);

        await expect(owner.dispose()).resolves.toBeUndefined();
        await expect(owner.dispose()).resolves.toBeUndefined();
        expect(disposeProcess).toHaveBeenCalledOnce();
        expect(observationListeners.size).toBe(0);
        expect(disposeWatch).toHaveBeenCalledTimes(3);
    });

    it('returns a stable stopped result when stop joins terminal disposal and after cleanup', async () => {
        const healthySnapshot = Object.freeze({
            id: 'terminal-stop-result',
            instanceId: 'terminal-stop-result-instance',
            state: 'healthy' as const,
            mode: 'managedSpawn' as const,
            baseUrl: 'http://127.0.0.1:43122',
            port: 43_122,
            pid: 8_207,
            startedAtMs: 1,
            lastHealthyAtMs: 1,
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        });
        let currentSnapshot = healthySnapshot as
            ReturnType<ManagedServiceProcessHandle['snapshot']>;
        const observationListeners = new Set<(snapshot: ReturnType<ManagedServiceProcessHandle['snapshot']>) => void>();
        const disposeStarted = deferred<void>();
        const releaseDispose = deferred<void>();
        const disposeProcess = vi.fn(async () => {
            disposeStarted.resolve(undefined);
            await releaseDispose.promise;
        });
        const stopProcess = vi.fn(async () => Object.freeze({
            status: 'stopped' as const,
        }));
        const processHandle = Object.freeze({
            snapshot: () => currentSnapshot,
            observe: vi.fn((listener) => {
                observationListeners.add(listener);
                listener(currentSnapshot);
                return Object.freeze({ dispose: () => observationListeners.delete(listener) });
            }),
            waitUntilHealthy: vi.fn(async () => currentSnapshot),
            stop: stopProcess,
            dispose: disposeProcess,
        }) satisfies ManagedServiceProcessHandle;
        const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>(
            async () => processHandle,
        );
        const disposeWatch = vi.fn();
        const connectedAccounts = Object.freeze({
            ...createConnectedAccounts(vi.fn(async () => Object.freeze({
                kind: 'environment' as const,
                env: Object.freeze({ TOKEN: 'credential-secret' }),
            }))),
            watch: vi.fn(() => Object.freeze({ dispose: disposeWatch })),
        }) satisfies ConnectedAccountsService;
        const owner = createManagedServicesOwner({
            processSupervisorHost: Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: () => Object.freeze({ supervise }),
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const services = owner.bindScope(lifecycleScope({
            occurrenceId: 'provider-terminal-stop-result',
            sessionId: 'session-terminal-stop-result',
            operationId:
                'session-demand:session-terminal-stop-result:provider-p',
        }), exec, { connectedAccounts });
        const spec = Object.freeze({
            ...lifecycleSpec({
                id: 'terminal-stop-result',
                port: 43_122,
            }),
            credentialBindings: Object.freeze([Object.freeze({
                purpose: 'provider.inference',
                request: Object.freeze({
                    kind: 'environment' as const,
                    keys: Object.freeze(['TOKEN']),
                }),
                injection: Object.freeze({
                    kind: 'environment' as const,
                    targetEnvironmentKeysByMaterializedKey: Object.freeze({
                        TOKEN: 'UPSTREAM_TOKEN',
                    }),
                }),
            })]),
        }) satisfies ManagedServiceSpec;

        const handle = await services.supervise(spec);
        currentSnapshot = Object.freeze({
            ...healthySnapshot,
            state: 'unhealthy',
            diagnostics: Object.freeze([Object.freeze({
                code: 'plugin_managed_server_process_exited',
                severity: 'error' as const,
            })]),
        });
        for (const listener of [...observationListeners]) listener(currentSnapshot);
        await disposeStarted.promise;

        const concurrentStop = handle.stop();
        releaseDispose.resolve(undefined);

        await expect(concurrentStop).resolves.toEqual({ status: 'stopped' });
        await expect(handle.stop()).resolves.toEqual({ status: 'stopped' });
        expect(disposeProcess).toHaveBeenCalledOnce();
        expect(stopProcess).not.toHaveBeenCalled();
        expect(observationListeners.size).toBe(0);
        expect(disposeWatch).toHaveBeenCalledOnce();

        await expect(owner.dispose()).resolves.toBeUndefined();
        expect(disposeProcess).toHaveBeenCalledOnce();
        expect(stopProcess).not.toHaveBeenCalled();
        expect(observationListeners.size).toBe(0);
        expect(disposeWatch).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'Session',
            {
                sessionId: 'session-one',
                operationId: 'session-demand:session-one:provider-p',
            },
            {
                sessionId: 'session-two',
                operationId: 'session-demand:session-two:provider-p',
            },
        ],
        [
            'bounded operation',
            { operationId: 'catalog-probe:operation-one' },
            { operationId: 'catalog-probe:operation-two' },
        ],
    ] as const)('never shares an equal service across unrelated exact %s scopes', async (
        _scopeKind,
        firstScope,
        secondScope,
    ) => {
        const firstProcess = createLifecycleProcess(8_211);
        const secondProcess = createLifecycleProcess(8_212);
        const harness = createLifecycleHarness(
            [firstProcess, secondProcess],
            _scopeKind === 'Session' ? 'sessionRunner' : 'daemon',
        );
        const bindScope = (scope: typeof firstScope | typeof secondScope) =>
            harness.owner.bindScope(lifecycleScope({
                occurrenceId: 'provider-p',
                ...scope,
            }), harness.exec);
        const spec = lifecycleSpec({
            id: 'gateway',
            port: 43_122,
        });

        const first = await bindScope(firstScope).supervise(spec);
        const second = await bindScope(secondScope).supervise(spec);
        await first.stop();
        const secondStateAfterFirstStop = second.snapshot().state;
        await second.dispose();

        expect(second).not.toBe(first);
        expect(harness.exec.spawn).toHaveBeenCalledTimes(2);
        expect(secondStateAfterFirstStop).toBe('healthy');
        expect(firstProcess.dispose).toHaveBeenCalledOnce();
        expect(secondProcess.dispose).toHaveBeenCalledOnce();
    });

    it('retires unadopted explicit-start P before starting Q for the same effective Provider owner', async () => {
        const releaseP = deferred<void>();
        const pDisposalStarted = deferred<void>();
        const processes: PluginProcessHandle[] = [];
        const harness = createLifecycleHarness(processes, 'daemon');
        let spawnCountWhenPDisposalStarted: number | null = null;
        const pProcess = createLifecycleProcess(8_221, async () => {
            spawnCountWhenPDisposalStarted = harness.exec.spawn.mock.calls.length;
            pDisposalStarted.resolve();
            await releaseP.promise;
        });
        const qProcess = createLifecycleProcess(8_222);
        processes.push(pProcess, qProcess);
        let pCurrent = true;
        const effectiveStartOwner =
            'provider-explicit-start:machine-a:acme.providers/gateway';
        const pServices = harness.owner.bindScope(lifecycleScope({
            occurrenceId: 'provider-p',
            operationId: effectiveStartOwner,
            isOccurrenceCurrent: () => pCurrent,
        }), harness.exec);
        const pHandle = await pServices.supervise(lifecycleSpec({
            id: 'gateway',
            args: Object.freeze(['serve', '--occurrenceId=P']),
        }));

        pCurrent = false;
        const qServices = harness.owner.bindScope(lifecycleScope({
            occurrenceId: 'provider-q',
            operationId: effectiveStartOwner,
        }), harness.exec);
        const qEstablishment = qServices.supervise(lifecycleSpec({
            id: 'gateway',
            args: Object.freeze(['serve', '--occurrenceId=Q']),
        }));
        const firstLifecycleEvent = await Promise.race([
            pDisposalStarted.promise.then(() => 'p-retirement-started' as const),
            qEstablishment.then(() => 'q-established' as const),
        ]);

        releaseP.resolve();
        const qHandle = await qEstablishment;
        await Promise.allSettled([
            pHandle.dispose(),
            qHandle.dispose(),
        ]);

        expect(firstLifecycleEvent).toBe('p-retirement-started');
        expect(spawnCountWhenPDisposalStarted).toBe(1);
        expect(harness.exec.spawn).toHaveBeenCalledTimes(2);
        expect(pProcess.dispose).toHaveBeenCalledOnce();
        expect(qProcess.dispose).toHaveBeenCalledOnce();
    });

    it('keeps adopted Session P and generic retained G independent across ordinary P-to-Q and G-to-H publication plus daemon replacement', async () => {
        const pProcess = createLifecycleProcess(8_231);
        const gProcess = createLifecycleProcess(8_232);
        const qProcess = createLifecycleProcess(8_233);
        const harness = createLifecycleHarness([
            pProcess,
            gProcess,
            qProcess,
        ]);
        const pScope = lifecycleScope({
            occurrenceId: 'provider-p',
            sessionId: 'session-retained-p',
            operationId: 'session-demand:session-retained-p:provider-p',
        });
        const gScope = lifecycleScope({
            occurrenceId: 'agent-g',
            contributionQualifiedId:
                'acme.providers/agents/coding-agent',
            sessionId: 'session-retained-p',
        });
        const pSpec = lifecycleSpec({
            id: 'provider-gateway',
            port: 43_125,
            args: Object.freeze(['serve', '--occurrenceId=P']),
        });
        const gSpec = lifecycleSpec({
            id: 'generic-agent-service',
            port: 43_126,
        });
        const pHandle = await harness.owner.bindScope(
            pScope,
            harness.exec,
        ).supervise(pSpec);
        const gHandle = await harness.owner.bindScope(
            gScope,
            harness.exec,
        ).supervise(gSpec);

        await harness.owner.retireGeneration!(
            'provider-p',
            'acme.providers',
        );
        await harness.owner.retireGeneration!(
            'agent-g',
            'acme.providers',
        );

        const replacementDaemonP = await harness.owner.bindScope(
            lifecycleScope({
                occurrenceId: pScope.occurrenceId,
                sessionId: pScope.sessionId,
                operationId: pScope.operationId,
            }),
            harness.exec,
        ).supervise(pSpec).then(
            (handle) => Object.freeze({ status: 'available' as const, handle }),
            (error: unknown) => Object.freeze({ status: 'failed' as const, error }),
        );
        const retainedGenericG = await harness.owner.bindScope(
            gScope,
            harness.exec,
        ).supervise(gSpec).then(
            (handle) => Object.freeze({ status: 'available' as const, handle }),
            (error: unknown) => Object.freeze({ status: 'failed' as const, error }),
        );
        const qHandle = await harness.owner.bindScope(lifecycleScope({
            occurrenceId: 'provider-q',
            sessionId: 'session-current-q',
            operationId: 'session-demand:session-current-q:provider-q',
        }), harness.exec).supervise(lifecycleSpec({
            id: 'provider-gateway',
            port: 43_127,
            args: Object.freeze(['serve', '--occurrenceId=Q']),
        }));
        const pStateAfterOrdinaryPublication = pHandle.snapshot().state;
        const gStateAfterOrdinaryPublication = gHandle.snapshot().state;
        const pStopsBeforeExactLifecycleEnd = pProcess.dispose.mock.calls.length;
        const gStopsBeforeExactLifecycleEnd = gProcess.dispose.mock.calls.length;

        await Promise.allSettled([
            pHandle.dispose(),
            gHandle.dispose(),
            qHandle.dispose(),
        ]);

        expect(replacementDaemonP.status).toBe('available');
        if (replacementDaemonP.status === 'available') {
            expect(replacementDaemonP.handle).toBe(pHandle);
        }
        expect(retainedGenericG.status).toBe('available');
        if (retainedGenericG.status === 'available') {
            expect(retainedGenericG.handle).toBe(gHandle);
        }
        expect(pStateAfterOrdinaryPublication).toBe('healthy');
        expect(gStateAfterOrdinaryPublication).toBe('healthy');
        expect(pStopsBeforeExactLifecycleEnd).toBe(0);
        expect(gStopsBeforeExactLifecycleEnd).toBe(0);
        expect(harness.exec.spawn).toHaveBeenCalledTimes(3);
    });

    it.each([
        ['hard revocation', true, false],
        ['Session end', false, false],
        ['explicit restart', false, true],
    ] as const)('stops an exact retained scope once on %s', async (
        _reason,
        revokeCurrentness,
        startReplacement,
    ) => {
        const controller = new AbortController();
        const process = createLifecycleProcess(8_241);
        const replacementProcess = createLifecycleProcess(8_242);
        const harness = createLifecycleHarness([
            process,
            replacementProcess,
        ]);
        let current = true;
        const scope = lifecycleScope({
            occurrenceId: 'provider-p',
            sessionId: 'session-lifecycle-end',
            operationId: 'session-demand:session-lifecycle-end:provider-p',
            signal: controller.signal,
            isOccurrenceCurrent: () => current,
        });
        const services = harness.owner.bindScope(scope, harness.exec);
        const spec = lifecycleSpec({
            id: 'gateway',
            port: 43_128,
        });
        const first = await services.supervise(spec);
        const joined = await services.supervise(spec);

        if (revokeCurrentness) current = false;
        controller.abort(_reason);
        await Promise.allSettled([
            first.dispose(),
            joined.dispose(),
        ]);
        const lateError = await services.supervise(spec).then(
            () => null,
            (error: unknown) => error,
        );
        let replacement: ManagedServiceHandle | null = null;
        if (startReplacement) {
            replacement = await harness.owner.bindScope(lifecycleScope({
                occurrenceId: 'provider-q',
                sessionId: scope.sessionId,
                operationId:
                    'session-demand:session-lifecycle-end:provider-q',
            }), harness.exec).supervise(lifecycleSpec({
                id: 'gateway',
                port: 43_129,
            }));
        }
        await replacement?.dispose();

        expect(process.dispose).toHaveBeenCalledOnce();
        expect(lateError).toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        if (startReplacement) {
            expect(replacement?.snapshot().state).toBe('stopped');
            expect(replacementProcess.dispose).toHaveBeenCalledOnce();
        } else {
            expect(harness.exec.spawn).toHaveBeenCalledOnce();
        }
    });

    it('joins pending and settled exact explicit Provider starts before launch authority', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const launchGate = deferred<void>();
        let release: (() => Promise<void>) | null = null;
        const establish = vi.fn(async (input: Readonly<{
            signal: AbortSignal;
            release(): Promise<void>;
        }>) => {
            release = input.release;
            await launchGate.promise;
            return explicitStartOutcome();
        });
        const operation = (input: Readonly<{
            purposeBindingsEqualityKey?: string;
            isCurrent?: () => boolean;
        }> = {}) => Object.freeze({
            operationId: JSON.stringify([
                'managed-provider-explicit-start',
                'machine-one',
                'acme.providers',
                'gateway',
            ]),
            pluginId: 'acme.providers',
            contributionQualifiedId: 'acme.providers/providers/gateway',
            occurrenceId: 'provider-p',
            purposeBindingsEqualityKey:
                input.purposeBindingsEqualityKey ?? 'binding-key-one',
            isCurrent: input.isCurrent ?? (() => true),
            establish,
        });

        let firstCallerCurrent = true;
        const first = harness.owner.runManagedProviderExplicitStart(
            operation({ isCurrent: () => firstCallerCurrent }),
        );
        await vi.waitFor(() => expect(establish).toHaveBeenCalledOnce());
        const concurrentRetry = harness.owner.runManagedProviderExplicitStart(
            operation(),
        );

        expect(establish).toHaveBeenCalledOnce();
        launchGate.resolve(undefined);
        await expect(Promise.all([first, concurrentRetry])).resolves.toMatchObject([
            { status: 'established', value: { status: 'running' } },
            { status: 'established', value: { status: 'running' } },
        ]);
        await expect(harness.owner.runManagedProviderExplicitStart(
            operation(),
        )).resolves.toMatchObject({
            status: 'established',
            value: { status: 'running' },
        });
        firstCallerCurrent = false;
        await expect(harness.owner.runManagedProviderExplicitStart(
            operation(),
        )).resolves.toEqual({ status: 'not_current' });
        await expect(harness.owner.runManagedProviderExplicitStart(operation({
            purposeBindingsEqualityKey: 'binding-key-two',
        }))).resolves.toEqual({ status: 'not_current' });
        await expect(harness.owner.runManagedProviderExplicitStart(operation({
            isCurrent: () => false,
        }))).resolves.toEqual({ status: 'not_current' });
        expect(establish).toHaveBeenCalledOnce();

        await release!();
        await expect(harness.owner.dispose()).resolves.toBeUndefined();
    });

    it('retains host-private Provider endpoint access per explicit-start operation while join cleanup stays caller-scoped', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const request = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body: null,
        }));
        let operationCurrent = true;
        let projectionCurrent = true;
        const projectionCleanup = vi.fn(() => {
            projectionCurrent = false;
        });
        const establish = vi.fn(async () => Object.freeze({
            status: 'running' as const,
            projection: Object.freeze({
                access: Object.freeze({
                    endpointUrl: () => 'http://127.0.0.1:43120/v1',
                    request,
                }),
                isCurrent: () => projectionCurrent,
                cleanup: projectionCleanup,
            }),
        }));
        const operation = (signal?: AbortSignal) => Object.freeze({
            operationId: JSON.stringify([
                'managed-provider-broker',
                'session',
                'session-one',
                'acme.providers',
                'gateway',
            ]),
            pluginId: 'acme.providers',
            contributionQualifiedId: 'acme.providers/providers/gateway',
            occurrenceId: 'provider-p',
            purposeBindingsEqualityKey: 'binding-key-one',
            isCurrent: () => operationCurrent,
            ...(signal ? { signal } : {}),
            establish,
        });

        const firstAbort = new AbortController();
        const first = await harness.owner.runManagedProviderExplicitStart(
            operation(firstAbort.signal),
        );
        const second = await harness.owner.runManagedProviderExplicitStart(
            operation(),
        );
        expect(first.status).toBe('established');
        expect(second.status).toBe('established');
        if (first.status !== 'established' || second.status !== 'established') {
            throw new Error('Expected exact explicit-start joins');
        }
        expect(first.value.projection).not.toBe(second.value.projection);
        expect(first.value.projection.isCurrent()).toBe(true);
        expect(second.value.projection.isCurrent()).toBe(true);

        firstAbort.abort('caller stopped waiting');
        expect(first.value.projection.isCurrent()).toBe(false);
        expect(second.value.projection.isCurrent()).toBe(true);
        expect(projectionCleanup).not.toHaveBeenCalled();
        await expect(second.value.projection.access.request({
            pathAndQuery: '/v1/responses',
            method: 'POST',
            timeoutMs: 1_000,
        })).resolves.toMatchObject({ ok: true, status: 200 });
        expect(request).toHaveBeenCalledOnce();

        await expect(harness.owner.retireManagedProviderExplicitStart({
            operationId: operation().operationId,
            pluginId: operation().pluginId,
            contributionQualifiedId: operation().contributionQualifiedId,
        })).resolves.toBe(true);
        expect(second.value.projection.isCurrent()).toBe(false);
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(0);

        operationCurrent = false;
        await expect(harness.owner.dispose()).resolves.toBeUndefined();
    });

    it('revalidates retained broker claims exactly and tears down the broker family without touching public explicit starts', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const cleanupByOperation = new Map<string, ReturnType<typeof vi.fn>>();
        const currentByOperation = new Map<string, boolean>([
            ['external-key-a', true],
            ['external-key-b', true],
            ['session-one', true],
            ['execution-run-one', true],
            ['public-start', true],
        ]);
        const operation = (
            operationIdentity: string,
            lifecycleKind: 'providerBroker' | 'publicExplicitStart',
        ) => {
            const cleanup = vi.fn(async () => undefined);
            cleanupByOperation.set(operationIdentity, cleanup);
            return Object.freeze({
                operationId: operationIdentity,
                pluginId: 'acme.providers',
                contributionQualifiedId: 'acme.providers/providers/gateway',
                occurrenceId: 'provider-p',
                purposeBindingsEqualityKey: `binding-${operationIdentity}`,
                lifecycleKind,
                isCurrent: () => true,
                revalidateRetainedCurrentness: async () =>
                    currentByOperation.get(operationIdentity) === true,
                establish: async () => explicitStartOutcome(cleanup),
            });
        };

        await expect(Promise.all([
            harness.owner.runManagedProviderExplicitStart(operation('external-key-a', 'providerBroker')),
            harness.owner.runManagedProviderExplicitStart(operation('external-key-b', 'providerBroker')),
            harness.owner.runManagedProviderExplicitStart(operation('session-one', 'providerBroker')),
            harness.owner.runManagedProviderExplicitStart(operation('execution-run-one', 'providerBroker')),
            harness.owner.runManagedProviderExplicitStart(operation('public-start', 'publicExplicitStart')),
        ])).resolves.toMatchObject([
            { status: 'established' },
            { status: 'established' },
            { status: 'established' },
            { status: 'established' },
            { status: 'established' },
        ]);

        const cancelledSweep = new AbortController();
        cancelledSweep.abort();
        await expect(harness.owner.revalidateManagedProviderExplicitStarts(
            cancelledSweep.signal,
        )).rejects.toMatchObject({ name: 'AbortError' });
        for (const cleanup of cleanupByOperation.values()) {
            expect(cleanup).not.toHaveBeenCalled();
        }
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(5);

        currentByOperation.set('external-key-a', false);
        await expect(harness.owner.revalidateManagedProviderExplicitStarts())
            .resolves.toBe(1);
        expect(cleanupByOperation.get('external-key-a')).toHaveBeenCalledOnce();
        expect(cleanupByOperation.get('external-key-b')).not.toHaveBeenCalled();
        expect(cleanupByOperation.get('session-one')).not.toHaveBeenCalled();
        expect(cleanupByOperation.get('execution-run-one')).not.toHaveBeenCalled();
        expect(cleanupByOperation.get('public-start')).not.toHaveBeenCalled();
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(4);

        await expect(harness.owner.revalidateManagedProviderExplicitStarts())
            .resolves.toBe(0);
        await expect(harness.owner.retireManagedProviderExplicitStarts('providerBroker'))
            .resolves.toBe(3);
        expect(cleanupByOperation.get('external-key-b')).toHaveBeenCalledOnce();
        expect(cleanupByOperation.get('session-one')).toHaveBeenCalledOnce();
        expect(cleanupByOperation.get('execution-run-one')).toHaveBeenCalledOnce();
        expect(cleanupByOperation.get('public-start')).not.toHaveBeenCalled();
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(1);

        await expect(harness.owner.dispose()).resolves.toBeUndefined();
        expect(cleanupByOperation.get('public-start')).toHaveBeenCalledOnce();
    });

    it('reports external operation retirement only after all application custody is actually released', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const notify = vi.fn(async () => undefined);
        let cleanupBlocked = true;
        const operation = (localId: string) => ({
            operationId: `external-operation/${localId}`,
            pluginId: 'acme.providers',
            contributionQualifiedId: `acme.providers/providers/${localId}`,
            occurrenceId: 'provider-p',
            purposeBindingsEqualityKey: 'binding',
            lifecycleKind: 'providerBroker' as const,
            retirementGroup: { identity: 'key-one/operation-one', onRetired: notify },
            isCurrent: () => true,
            establish: async () => explicitStartOutcome(async () => {
                if (localId === 'second' && cleanupBlocked) throw new Error('child still held');
            }),
        });
        await harness.owner.runManagedProviderExplicitStart(operation('first'));
        await harness.owner.runManagedProviderExplicitStart(operation('second'));
        await harness.owner.retireManagedProviderExplicitStart(operation('first'));
        expect(notify).not.toHaveBeenCalled();
        await expect(harness.owner.retireManagedProviderExplicitStart(operation('second'))).rejects.toThrow();
        expect(notify).not.toHaveBeenCalled();
        cleanupBlocked = false;
        await harness.owner.retireManagedProviderExplicitStart(operation('second'));
        expect(notify).toHaveBeenCalledOnce();
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(0);
        await harness.owner.dispose();
    });

    it('reports external operation retirement after failed first establishment releases its custody', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const notify = vi.fn(async () => undefined);
        await expect(harness.owner.runManagedProviderExplicitStart({
            operationId: 'external-key-failed-start',
            pluginId: 'acme.providers',
            contributionQualifiedId: 'acme.providers/providers/gateway',
            occurrenceId: 'provider-p',
            purposeBindingsEqualityKey: 'binding',
            lifecycleKind: 'providerBroker',
            retirementGroup: { identity: 'key-one/operation-one', onRetired: notify },
            isCurrent: () => true,
            establish: async () => { throw new Error('establishment failed'); },
        })).rejects.toThrow('establishment failed');
        expect(notify).toHaveBeenCalledOnce();
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(0);
        await harness.owner.dispose();
    });

    it('retains broker custody when current authority cannot be observed', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const cleanup = vi.fn(async () => undefined);
        await harness.owner.runManagedProviderExplicitStart({
            operationId: 'external-key-unknown',
            pluginId: 'acme.providers',
            contributionQualifiedId: 'acme.providers/providers/gateway',
            occurrenceId: 'provider-p',
            purposeBindingsEqualityKey: 'binding',
            lifecycleKind: 'providerBroker',
            isCurrent: () => true,
            revalidateRetainedCurrentness: async () => { throw new Error('Home unreachable'); },
            establish: async () => explicitStartOutcome(cleanup),
        });
        await expect(harness.owner.revalidateManagedProviderExplicitStarts()).resolves.toBe(0);
        expect(cleanup).not.toHaveBeenCalled();
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(1);
        await harness.owner.dispose();
    });

    it('retains a cleaned external claim until its exact retirement is acknowledged', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        let acknowledged = false;
        const cleanup = vi.fn(async () => undefined);
        const notify = vi.fn(async () => {
            if (!acknowledged) throw new Error('Home unreachable');
        });
        const operation = {
            operationId: 'external-key-ack',
            pluginId: 'acme.providers',
            contributionQualifiedId: 'acme.providers/providers/gateway',
            occurrenceId: 'provider-p',
            purposeBindingsEqualityKey: 'binding',
            lifecycleKind: 'providerBroker' as const,
            retirementGroup: { identity: 'key-one/operation-one', onRetired: notify },
            isCurrent: () => true,
            establish: async () => explicitStartOutcome(cleanup),
        };
        await harness.owner.runManagedProviderExplicitStart(operation);
        await expect(harness.owner.retireManagedProviderExplicitStart(operation)).rejects.toThrow('Home unreachable');
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(1);
        acknowledged = true;
        await harness.owner.retireManagedProviderExplicitStart(operation);
        expect(harness.owner.readRetainedSemanticCustodyCount()).toBe(0);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledTimes(2);
        await harness.owner.dispose();
    });

    it('cannot join an external operation while its final retirement acknowledgement is pending', async () => {
        const harness = createLifecycleHarness([], 'daemon');
        const notificationStarted = deferred<void>();
        const acknowledgement = deferred<void>();
        const operation = (localId: string) => ({
            operationId: `external-operation/${localId}`,
            pluginId: 'acme.providers',
            contributionQualifiedId: `acme.providers/providers/${localId}`,
            occurrenceId: 'provider-p',
            purposeBindingsEqualityKey: 'binding',
            lifecycleKind: 'providerBroker' as const,
            retirementGroup: {
                identity: 'key-one/operation-one',
                async onRetired() {
                    notificationStarted.resolve();
                    await acknowledgement.promise;
                },
            },
            isCurrent: () => true,
            establish: async () => explicitStartOutcome(),
        });
        await harness.owner.runManagedProviderExplicitStart(operation('first'));
        const retirement = harness.owner.retireManagedProviderExplicitStart(operation('first'));
        // Race the notification against completed retirement so missing callback
        // behavior fails directly rather than hanging the fixture.
        await Promise.race([notificationStarted.promise, retirement]);
        const joined = await harness.owner.runManagedProviderExplicitStart(operation('second'));
        acknowledgement.resolve();
        await retirement;
        expect(joined.status).toBe('unavailable');
        await harness.owner.dispose();
    });

    it('retires a terminal explicit-start claim before concurrent retries establish one replacement', async () => {
        const operationId = JSON.stringify([
            'managed-provider-explicit-start',
            'machine-terminal',
            'acme.providers',
            'gateway',
        ]);
        const healthySnapshot = Object.freeze({
            id: 'gateway',
            instanceId: 'terminal-explicit-first',
            state: 'healthy' as const,
            mode: 'managedSpawn' as const,
            baseUrl: 'http://127.0.0.1:43130',
            port: 43_130,
            pid: 8_301,
            startedAtMs: 1,
            lastHealthyAtMs: 1,
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        });
        let currentSnapshot = healthySnapshot as
            ReturnType<ManagedServiceProcessHandle['snapshot']>;
        let terminalListener:
            | ((snapshot: ReturnType<ManagedServiceProcessHandle['snapshot']>) => void)
            | null = null;
        const cleanupStarted = deferred<void>();
        const releaseCleanup = deferred<void>();
        const firstDispose = vi.fn(async () => {
            cleanupStarted.resolve(undefined);
            await releaseCleanup.promise;
        });
        const firstHandle = Object.freeze({
            snapshot: () => currentSnapshot,
            observe: vi.fn((listener) => {
                terminalListener = listener;
                listener(currentSnapshot);
                return Object.freeze({ dispose() {} });
            }),
            waitUntilHealthy: vi.fn(async () => currentSnapshot),
            stop: vi.fn(async () => Object.freeze({
                status: 'stopped' as const,
            })),
            dispose: firstDispose,
        }) satisfies ManagedServiceProcessHandle;
        const secondStop = vi.fn(async () => Object.freeze({
            status: 'stopped' as const,
        }));
        const secondDispose = vi.fn(async () => undefined);
        const secondHandle = Object.freeze({
            snapshot: () => healthySnapshot,
            observe: vi.fn(() => Object.freeze({ dispose() {} })),
            waitUntilHealthy: vi.fn(async () => healthySnapshot),
            stop: secondStop,
            dispose: secondDispose,
        }) satisfies ManagedServiceProcessHandle;
        const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>()
            .mockResolvedValueOnce(firstHandle)
            .mockResolvedValueOnce(secondHandle);
        const owner = createManagedServicesOwner({
            processSupervisorHost: Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: () => Object.freeze({ supervise }),
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const establish = vi.fn(async (input: Readonly<{
            signal: AbortSignal;
            release(): Promise<void>;
        }>) => {
            const services = owner.bindScope(lifecycleScope({
                occurrenceId: 'provider-terminal',
                operationId,
                signal: input.signal,
            }), exec);
            await services.supervise(lifecycleSpec({
                id: 'gateway',
                port: 43_130,
            }));
            return explicitStartOutcome();
        });
        const operation = () => Object.freeze({
            operationId,
            pluginId: 'acme.providers',
            contributionQualifiedId: 'acme.providers/providers/gateway',
            occurrenceId: 'provider-terminal',
            purposeBindingsEqualityKey: 'binding-key-one',
            isCurrent: () => true,
            establish,
        });

        await expect(owner.runManagedProviderExplicitStart(
            operation(),
        )).resolves.toMatchObject({
            status: 'established',
            value: { status: 'running' },
        });
        currentSnapshot = Object.freeze({
            ...healthySnapshot,
            state: 'unhealthy',
            diagnostics: Object.freeze([Object.freeze({
                code: 'plugin_managed_server_process_exited',
                severity: 'error' as const,
            })]),
        });
        terminalListener!(currentSnapshot);
        await cleanupStarted.promise;

        const retries = Promise.all([
            owner.runManagedProviderExplicitStart(operation()),
            owner.runManagedProviderExplicitStart(operation()),
        ]);
        releaseCleanup.resolve(undefined);

        await expect(retries).resolves.toMatchObject([
            {
                status: 'established',
                value: { status: 'running' },
            },
            {
                status: 'established',
                value: { status: 'running' },
            },
        ]);
        expect(establish).toHaveBeenCalledTimes(2);
        expect(supervise).toHaveBeenCalledTimes(2);
        expect(firstDispose).toHaveBeenCalledOnce();

        await expect(owner.dispose()).resolves.toBeUndefined();
        expect(secondDispose).toHaveBeenCalledOnce();
        expect(secondStop).not.toHaveBeenCalled();
    });

    it('keeps a terminal explicit-start claim when its physical cleanup fails', async () => {
        const operationId = JSON.stringify([
            'managed-provider-explicit-start',
            'machine-terminal-failure',
            'acme.providers',
            'gateway',
        ]);
        const healthySnapshot = Object.freeze({
            id: 'gateway',
            instanceId: 'terminal-explicit-failure',
            state: 'healthy' as const,
            mode: 'managedSpawn' as const,
            baseUrl: 'http://127.0.0.1:43131',
            port: 43_131,
            pid: 8_302,
            startedAtMs: 1,
            lastHealthyAtMs: 1,
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        });
        let currentSnapshot = healthySnapshot as
            ReturnType<ManagedServiceProcessHandle['snapshot']>;
        let terminalListener:
            | ((snapshot: ReturnType<ManagedServiceProcessHandle['snapshot']>) => void)
            | null = null;
        const dispose = vi.fn(async () => {
            throw new Error('terminal cleanup failed');
        });
        const handle = Object.freeze({
            snapshot: () => currentSnapshot,
            observe: vi.fn((listener) => {
                terminalListener = listener;
                listener(currentSnapshot);
                return Object.freeze({ dispose() {} });
            }),
            waitUntilHealthy: vi.fn(async () => currentSnapshot),
            stop: vi.fn(async () => Object.freeze({
                status: 'stopped' as const,
            })),
            dispose,
        }) satisfies ManagedServiceProcessHandle;
        const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>(
            async () => handle,
        );
        const owner = createManagedServicesOwner({
            processSupervisorHost: Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: () => Object.freeze({ supervise }),
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const establish = vi.fn(async (input: Readonly<{
            signal: AbortSignal;
            release(): Promise<void>;
        }>) => {
            const services = owner.bindScope(lifecycleScope({
                occurrenceId: 'provider-terminal-failure',
                operationId,
                signal: input.signal,
            }), exec);
            await services.supervise(lifecycleSpec({
                id: 'gateway',
                port: 43_131,
            }));
            return explicitStartOutcome();
        });
        const operation = () => Object.freeze({
            operationId,
            pluginId: 'acme.providers',
            contributionQualifiedId: 'acme.providers/providers/gateway',
            occurrenceId: 'provider-terminal-failure',
            purposeBindingsEqualityKey: 'binding-key-one',
            isCurrent: () => true,
            establish,
        });

        await owner.runManagedProviderExplicitStart(operation());
        currentSnapshot = Object.freeze({
            ...healthySnapshot,
            state: 'unhealthy',
            diagnostics: Object.freeze([Object.freeze({
                code: 'plugin_managed_server_process_exited',
                severity: 'error' as const,
            })]),
        });
        terminalListener!(currentSnapshot);
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
        expect(owner.readRetainedSemanticCustodyCount()).toBe(2);

        await expect(owner.runManagedProviderExplicitStart(
            operation(),
        )).rejects.toMatchObject({
            code: 'plugin_managed_service_establishment_failed',
        });
        expect(supervise).toHaveBeenCalledOnce();
        expect(owner.readRetainedSemanticCustodyCount()).toBe(2);
        expect(dispose).toHaveBeenCalledTimes(2);

        await expect(owner.dispose()).rejects.toMatchObject({
            errors: expect.any(Array),
        });
    });

    it('retires a stale explicit-start claim when its binding changes', async () => {
        const operationId = JSON.stringify([
            'managed-provider-explicit-start',
            'machine-binding-change',
            'acme.providers',
            'gateway',
        ]);
        const snapshot = Object.freeze({
            id: 'gateway',
            instanceId: 'binding-change',
            state: 'healthy' as const,
            mode: 'managedSpawn' as const,
            baseUrl: 'http://127.0.0.1:43132',
            port: 43_132,
            pid: 8_303,
            startedAtMs: 1,
            lastHealthyAtMs: 1,
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        });
        const stop = vi.fn(async () => Object.freeze({
            status: 'stopped' as const,
        }));
        const handle = Object.freeze({
            snapshot: () => snapshot,
            observe: vi.fn((listener) => {
                listener(snapshot);
                return Object.freeze({ dispose() {} });
            }),
            waitUntilHealthy: vi.fn(async () => snapshot),
            stop,
            dispose: vi.fn(async () => undefined),
        }) satisfies ManagedServiceProcessHandle;
        const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>(
            async () => handle,
        );
        const owner = createManagedServicesOwner({
            processSupervisorHost: Object.freeze({
                custodyOwner: 'daemon' as const,
                bind: () => Object.freeze({ supervise }),
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
        });
        const establish = vi.fn(async (input: Readonly<{
            signal: AbortSignal;
            release(): Promise<void>;
        }>) => {
            const services = owner.bindScope(lifecycleScope({
                occurrenceId: 'provider-binding-change',
                operationId,
                signal: input.signal,
            }), exec);
            await services.supervise(lifecycleSpec({
                id: 'gateway',
                port: 43_132,
            }));
            return explicitStartOutcome();
        });
        const operation = (purposeBindingsEqualityKey: string) =>
            Object.freeze({
                operationId,
                pluginId: 'acme.providers',
                contributionQualifiedId:
                    'acme.providers/providers/gateway',
                occurrenceId: 'provider-binding-change',
                purposeBindingsEqualityKey,
                isCurrent: () => true,
                establish,
            });

        await owner.runManagedProviderExplicitStart(operation(
            'binding-key-one',
        ));
        await expect(owner.runManagedProviderExplicitStart(operation(
            'binding-key-two',
        ))).resolves.toEqual({ status: 'not_current' });

        expect(stop).toHaveBeenCalledOnce();
        expect(establish).toHaveBeenCalledOnce();
        await expect(owner.dispose()).resolves.toBeUndefined();
    });
});

describe('Project Local Services control composition', () => {
    it.each(['machineRpc', 'machineTransport', 'action', 'actionIngress'] as const)('delivers %s cancellation to the canonical native control without reporting stopped', async entry => {
        const { owner } = createLifecycleHarness([], 'daemon');
        const input = createProjectLifecycleInput();
        let nativeStopped = false;
        try {
            const handle = await owner.superviseProject({
                ...input,
                processSpec: { ...input.processSpec, mode: { kind: 'native',
                    instance: { adapter: { pluginId: 'acme.native', localId: 'compose' }, nativeResourceId: 'cancellable-control-resource' },
                    // Resource inspection and termination are the actual external IO boundary.
                    lifecycle: {
                        inspect: async () => ({ phase: nativeStopped ? 'stopped' : 'running', readiness: 'not_reported', endpoint: null }),
                        stop: async () => { nativeStopped = true; return { status: 'stopped' }; },
                    },
                } },
            });
            const target = { kind: 'managed_service' as const, managedServiceId: handle.instanceId,
                machineId: input.workspace.machineId, workspaceId: input.workspace.id, cwd: input.cwd, declaration: input.declaration };
            const request = { requestId: 'cancel-native-control', target, action: 'stop_managed' as const, force: false };
            const confirmed = { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) };
            const routes = createLocalServiceActionRoutes({ machineId: input.workspace.machineId,
                inventoryRegistry: createLocalServiceInventoryRegistry(), projectManagedServices: owner,
                verifyConfirmationNonce: value => value.confirmationNonce === createLocalServiceActionConfirmationNonceV1(value) });
            const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
                status: 'ready', features: FeaturesResponseSchema.parse({ features: { localServices: {
                    enabled: true, inventory: { enabled: true }, actions: { enabled: true }, managed: { enabled: true },
                } }, capabilities: {} }),
            }) });
            await gate.refresh();
            expect(gate.isEnabled('localServices.actions')).toBe(true);
            expect(gate.isEnabled('localServices.managed')).toBe(true);
            const controller = new AbortController();
            controller.abort();
            let result: unknown;
            if (entry === 'machineRpc' || entry === 'machineTransport') {
                const machineAdmission = {
                    actorAccountId: input.requester.accountId,
                    custodianAccountId: input.requester.accountId,
                    machineId: input.workspace.machineId,
                    installationId: input.requester.installationId,
                    role: 'use' as const,
                    encryptionMode: 'plain' as const,
                };
                const machineBoundary = {
                    machineId: input.workspace.machineId,
                    resolveCustodianAccountId: async () => input.requester.accountId,
                    resolveInstallationId: () => input.requester.installationId,
                    // The signed Home verification HTTP boundary, not RPC admission logic.
                    verifyMachineAdmission: async ({ signal }: { signal?: AbortSignal }) => !signal?.aborted,
                };
                const receivingFactoryReady = deferred<void>();
                const accountSettingsRead = deferred<null>();
                const rpc = new RpcHandlerManager({ scopePrefix: input.workspace.machineId, localMachineId: input.workspace.machineId,
                    encryptionMode: 'plain', logger() {},
                    authorizeRequest: request => authorizeMachineRpcRequest(request, machineBoundary),
                });
                registerDaemonLocalServicesMachineRpcHandlers(rpc, { localServicesActions: routes, machineId: input.workspace.machineId,
                    resolveLauncherActionExecutor: async ({ ingress }) => {
                        let rawSettings: null = null;
                        if (entry === 'machineTransport') {
                            expect(ingress?.machineAdmission).toEqual(machineAdmission);
                            expect(await ingress?.verifyMachineAdmissionCurrent?.()).toBe(true);
                            receivingFactoryReady.resolve();
                            // Receiving Account-settings IO may outlive the caller's cancellation.
                            rawSettings = await accountSettingsRead.promise;
                        }
                        const settings = normalizeActionsSettingsV1(rawSettings);
                        const executor = createActionExecutor({
                            isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(
                                actionId, settings, { surface: context.surface ?? null, authority: context.authority },
                            ),
                            runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({
                                featureGate: gate, ingress, routes: { actionRoutes: routes },
                            }),
                        });
                        return {
                            execute: (actionId, actionInput, context) => {
                                if (entry === 'machineTransport') {
                                    expect(context?.runtimeAccountId).toBe(input.requester.accountId);
                                    expect(context?.signal?.aborted).toBe(true);
                                }
                                return executor.execute(actionId, actionInput, { ...context, serverId: input.workspace.serverId });
                            },
                        };
                    },
                });
                if (entry === 'machineTransport') {
                    const socketEvents = new EventEmitter();
                    const socketBoundary = {
                        auth: { clientType: 'machine-scoped' },
                        on: socketEvents.on.bind(socketEvents),
                        emit() {},
                    };
                    // Socket.IO is the transport IO boundary; only its event surface is exercised.
                    rpc.onSocketConnect(socketBoundary as unknown as Socket);
                    const transportRequestId = 'relay-native-stop-cancellation';
                    const pending = rpc.handleRequest({
                        method: `${input.workspace.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE}`,
                        params: confirmed,
                        requestId: transportRequestId,
                        callerAuthority: 'present_user',
                        machineAdmission,
                    });
                    try {
                        await receivingFactoryReady.promise;
                        socketEvents.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: transportRequestId });
                    } finally {
                        accountSettingsRead.resolve(null);
                    }
                    result = await pending;
                } else {
                    result = await rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE, confirmed, { signal: controller.signal });
                }
                expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
            } else {
                const executor = createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate, routes: { actionRoutes: routes },
                    ...(entry === 'actionIngress' ? { ingress: { signal: controller.signal } } : {}) });
                result = await executor({ actionId: 'localServices.actions.stopManaged', input: confirmed,
                    context: { signal: entry === 'action' ? controller.signal : new AbortController().signal } });
                expect(result).toMatchObject({ status: 'failed' });
            }
            expect(nativeStopped).toBe(false);
            expect(handle.snapshot().state).toBe('running');
            expect(owner.resolveProjectService(target)).toMatchObject({ status: 'found' });
            expect(owner.readRetainedSemanticCustodyCount()).toBe(1);
        } finally { await owner.dispose(); }
    });
    it('admits a shared Machine viewer only through the actual service witness and retires disclosure with the starter', async () => {
        const { owner } = createLifecycleHarness([], 'daemon');
        const workspace = { id: 'preview-workspace', serverId: 'home-a', machineId: 'machine-a',
            rootPath: process.cwd(), createdAtMs: 1 };
        const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'web' } };
        const requester = { serverId: workspace.serverId, accountId: 'starter-a', machineId: workspace.machineId, installationId: 'installation-a' };
        let current = true;
        const boundary = { machineId: workspace.machineId, resolveCustodianAccountId: async () => 'custodian-a',
            resolveInstallationId: () => requester.installationId,
            // The current Home verification HTTP boundary only; owner and RPC admission remain real.
            verifyMachineAdmission: async () => current };
        const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, localMachineId: workspace.machineId,
            encryptionMode: 'plain', logger() {}, authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
        try {
            const handle = await owner.superviseProject({
                workspace, declaration, cwd: workspace.rootPath, serviceId: 'project-preview-web', requester,
                specIdentity: 'preview-web-effect', isCurrent: () => true,
                processSpec: { mode: { kind: 'managedSpawn' }, startupTimeoutMs: 1_000 },
                authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
                    signal, assertCurrent() {}, projectLaunch: { status: 'ready', reviewedEffectDigest: 'preview-web-effect',
                        environment: { selection: { kind: 'host' }, root: workspace.rootPath, platform: process.platform,
                            io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }) } },
                    launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: workspace.rootPath, env: {} },
                }),
            });
            registerDaemonLocalServicePreviewSnapshotHandler(rpc, {
                localServicesPreview: createLocalServicePreviewRoutes({ machineId: workspace.machineId, registry: createLocalServicePreviewRegistry() }),
                projectManagedServices: owner, machineId: workspace.machineId, serverId: workspace.serverId,
            });
            const target = { kind: 'managed_service' as const, machineId: workspace.machineId,
                managedServiceId: handle.instanceId, workspaceId: workspace.id, declaration, cwd: workspace.rootPath };
            const machineAdmission = { actorAccountId: 'viewer-a', custodianAccountId: 'custodian-a',
                machineId: workspace.machineId, installationId: requester.installationId, role: 'use' as const, encryptionMode: 'plain' as const };
            const request = { method: `${workspace.machineId}:daemon.localServices.preview.admission`,
                params: { v: 1, kind: 'read', target }, machineAdmission,
                authorization: { kind: 'localServices.preview.admission.serverOrigin' } as const };
            // This future wire fixture is intentional; the new strict transport stamp owns its admission.
            const call = (params: unknown) => rpc.handleRequest({ ...request, params } as Parameters<typeof rpc.handleRequest>[0]);
            expect(await call(request.params)).toMatchObject({ v: 1, kind: 'admitted', instanceId: handle.instanceId,
                serviceTarget: target, starterAccountId: requester.accountId,
                endpoint: { scheme: 'http', host: '127.0.0.1', port: expect.any(Number) } });
            expect(await call({ ...request.params, target: { ...target, declaration: { ...declaration,
                selection: { kind: 'manifest', name: 'wrong-service' } } } })).toMatchObject({ kind: 'refused' });
            const previewRegistry = createLocalServicePreviewRegistry();
            const endpoint = new URL(handle.snapshot().baseUrl!);
            const registration = registerLocalServicePreview(previewRegistry, {
                previewId: handle.serviceId, machineId: workspace.machineId, owner: { kind: 'user', id: requester.accountId },
                serviceTarget: target, target: { scheme: 'http', host: endpoint.hostname, port: Number(endpoint.port) },
                initialPath: { pathname: '/', search: '' }, display: { title: 'Web', addressLabel: endpoint.host }, originMode: 'host',
            });
            if (!registration.ok) throw new Error(registration.reasonCode);
            const previewRoutes = createLocalServicePreviewRoutes({ machineId: workspace.machineId, registry: previewRegistry,
                server: { token: 'custodian-token', serverBaseUrl: 'https://home.example.test', http: {
                    async post(_url, resource) { return { data: { resource, accessUrl: 'https://web.preview.example.test/?previewToken=current', expiresAt: 61_000 } }; },
                    async delete() { return { data: { ok: true } }; },
                } } });
            const leaves = createLocalServiceLauncherLeafRoutes({ machineId: workspace.machineId,
                feed: createLocalServiceLauncherFeed({ machineId: workspace.machineId, inventoryRegistry: createLocalServiceInventoryRegistry(),
                    previewRegistry, projectManagedServices: owner }), previewRoutes, history: createLocalServiceLauncherHistoryStore() });
            expect(await leaves.registerPreview({ machineId: workspace.machineId, targetId: handle.serviceId }))
                .toMatchObject({ status: 'existing', previewId: handle.serviceId, browserTarget: { kind: 'localServicePreview', targetId: handle.serviceId } });
            expect(await leaves.openPreview({ machineId: workspace.machineId, targetId: handle.serviceId }))
                .toMatchObject({ status: 'opened', browserTarget: { kind: 'localServicePreview', targetId: handle.serviceId } });
            const waiting = call({ v: 1, kind: 'wait_retirement', target, instanceId: handle.instanceId });
            await new Promise<void>(resolve => setImmediate(resolve));
            await owner.stopForAccessLoss(requester);
            expect(await waiting).toEqual({ v: 1, kind: 'retired', instanceId: handle.instanceId });
            expect(await call(request.params)).toMatchObject({ kind: 'refused' });
            current = false;
            expect(await call(request.params)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
        } finally { await owner.dispose(); }
    });
    it.each(['clear', 'forget', 'retired-stop'] as const)('hides through %s without stopping, then stops only the source-qualified occurrence', async hide => {
        const { owner } = createLifecycleHarness([], 'daemon');
        const workspace = { id: 'control-workspace', serverId: 'home-a', machineId: 'machine-a',
            rootPath: process.cwd(), createdAtMs: 1 };
        const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'worker' } };
        const reviewedEffectDigest = 'control-worker-effect';
        let servingCurrent = true;
        try {
            const handle = await owner.superviseProject({
                workspace, declaration, cwd: workspace.rootPath, serviceId: 'project-control-worker',
                requester: { serverId: workspace.serverId, accountId: 'starter-a', machineId: workspace.machineId, installationId: 'installation-a' },
                specIdentity: reviewedEffectDigest, isCurrent: () => servingCurrent,
                processSpec: { mode: { kind: 'managedSpawn', endpointNone: true }, startupTimeoutMs: 1_000 },
                authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
                    signal, assertCurrent() {}, projectLaunch: { status: 'ready', reviewedEffectDigest,
                        environment: { selection: { kind: 'host' }, root: workspace.rootPath, platform: process.platform,
                            io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }) } },
                    launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: workspace.rootPath, env: {} },
                }),
            });
            const history = createLocalServiceLauncherHistoryStore();
            const routes = createLocalServiceActionRoutes({ machineId: workspace.machineId,
                inventoryRegistry: createLocalServiceInventoryRegistry(), projectManagedServices: owner,
                launcherHistory: history,
                verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request),
            });
            const target = { kind: 'managed_service' as const, machineId: workspace.machineId,
                managedServiceId: handle.instanceId, workspaceId: workspace.id, declaration, cwd: workspace.rootPath };
            const inventoryRegistry = createLocalServiceInventoryRegistry();
            const previewRegistry = createLocalServicePreviewRegistry();
            const feed = createLocalServiceLauncherFeed({ machineId: workspace.machineId, inventoryRegistry, previewRegistry,
                projectManagedServices: owner, history });
            const feedTarget = (await feed.getSnapshot({ workspaceRoot: workspace.rootPath })).targets[0];
            expect(feedTarget).toMatchObject({ source: 'managed_service', declaration, cwd: workspace.rootPath,
                serviceState: 'running', sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId }, actions: ['manage'] });
            expect(feedTarget?.endpointUrl).toBeUndefined();
            expect((await feed.getSnapshot({ workspaceRoot: '/unrelated-workspace' })).targets).toEqual([]);
            history.record(feedTarget!.id);
            const leaves = createLocalServiceLauncherLeafRoutes({ machineId: workspace.machineId, feed,
                history, previewRoutes: createLocalServicePreviewRoutes({ machineId: workspace.machineId, registry: previewRegistry }) });
            if (hide === 'clear') expect(await leaves.clearHistory({ machineId: workspace.machineId })).toMatchObject({ cleared: 1 });
            else expect(await routes.execute({ requestId: 'control-hide', target, action: 'forget', force: false }))
                    .toMatchObject({ status: 'succeeded' });
            expect((await feed.getSnapshot()).targets).toEqual([]);
            expect(handle.snapshot().state).toBe('running');
            if (hide === 'retired-stop') {
                // Serving authority may retire while the exact OS occurrence still needs cleanup.
                servingCurrent = false;
                expect(handle.isCurrent()).toBe(false);
            }
            const request = { requestId: 'control-stop', target, action: 'stop_managed' as const, force: false };
            const mismatched = { ...request, target: { ...target, declaration: { ...declaration,
                selection: { kind: 'manifest' as const, name: 'other-worker' } } } };
            expect(await routes.execute({ ...mismatched, confirmationNonce: createLocalServiceActionConfirmationNonceV1(mismatched) }))
                .toMatchObject({ status: 'denied', reasonCode: 'managed_service_target_mismatch' });
            expect(handle.snapshot().state).toBe('running');
            expect(await routes.execute(request)).toMatchObject({ status: 'denied', reasonCode: 'confirmation_required' });
            expect(handle.snapshot().state).toBe('running');
            expect(await routes.execute({ ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) }))
                .toMatchObject({ status: 'succeeded' });
            expect(handle.snapshot().state).toBe('stopped');
            expect(owner.readRetainedSemanticCustodyCount()).toBe(0);
            expect(await routes.execute({ ...request, requestId: 'stale-stop', confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) }))
                .toMatchObject({ status: 'denied', reasonCode: 'unknown_managed_service' });
        } finally { await owner.dispose(); }
    });
});
