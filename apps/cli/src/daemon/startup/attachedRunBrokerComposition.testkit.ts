/**
 * Composition for the attached-Run Team credential journeys
 * (`teams-lane-10/PLAN.md` §2.3). Real owners end to end:
 * `createExecutionRunBridgeRuntime` → Run provider launch → the Session
 * client's Run host adapter → the parent Session's native runtime → the Runner
 * Agent source → the runner's daemon-service client → the daemon's
 * `startDaemonSessionControlRuntime` dispatcher guard.
 *
 * The calling test file owns the boundary module mocks (daemon loopback control
 * server, OS process identity, Home network reads) and hands their hoisted
 * state in. Each composition commits the parent Agent through the process-wide
 * plugin reload controller and shuts it down on cleanup, so one test file
 * composes exactly once.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, vi } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';

import { reloadConfiguration } from '@/configuration';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { resolveHostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import { createExecutionRunBridgeRuntime } from '@/agent/runtime/bridges/executionRun/createExecutionRunBridgeRuntime';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createNativeAgentRuntimeSessionPlan } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { projectEngineRuntimeContributionFromAgent } from '@/agent/runtime/registry/engineRegistry/contributions';
import type { NativeAgentSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import type {
    NativeAgentSessionInteractionHostBinding,
    ResolvedCliEngineRegistry,
} from '@/agent/runtime/registry/engineRegistryTypes';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import {
    AGENT_RUNTIME_DAEMON_SERVICES_PATH,
    AgentRuntimeDaemonServiceRequestV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { registerSessionClientRuntimeHandlers } from '@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers';
import type { Metadata } from '@/api/types';
import { createAgentRuntimeDaemonServiceAuthorityPath } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import {
    createPublicHandoffArchiveChangeService,
    packAndCommitPublicHandoffFixture,
    PUBLIC_HANDOFF_AGENT_ID,
    PUBLIC_HANDOFF_AGENT_PLUGIN_ID,
    PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY,
    writePublicHandoffAgentPluginFixture,
} from '@/daemon/agentRuntime/runnerManagedProviderPublicHandoff.fixture';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import {
    hashProcessCommand,
    updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath,
    writeSessionMarker,
} from '@/daemon/sessionRegistry';
import type { TrackedSession } from '@/daemon/types';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { createEnvKeyScope } from '@/testkit/env/envScope';

import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';

export const PARENT_AGENT_ID = `${PUBLIC_HANDOFF_AGENT_PLUGIN_ID}/${PUBLIC_HANDOFF_AGENT_ID}`;
export const RUN_AGENT_ID = 'acme.run-agent/run-agent';
export const PARENT_AGENT_TARGET_KEY = buildBackendTargetKeyV2({ kind: 'backend', backendId: PARENT_AGENT_ID });
export const RUN_AGENT_TARGET_KEY = buildBackendTargetKeyV2({ kind: 'backend', backendId: RUN_AGENT_ID });

export type AttachedRunCompositionTestState = {
    controlInputs: Map<number, unknown>;
    readProcessIdentityByPid: ReturnType<typeof vi.fn>;
    sessionInteractionHosts: unknown[];
};

function createSessionHostServiceOwners(): NativeAgentSessionHostServiceOwners {
    return Object.freeze({
        features: Object.freeze({ isEnabled: () => false }),
        sessionHooks: Object.freeze({
            startServer: async () => Object.freeze({ port: 4312, stop: () => undefined, dispose: async () => undefined }),
            resolveForwarderAssets: async () => Object.freeze({
                nodeExecutable: '/runtime/node',
                sessionForwarderScript: '/runtime/session-forwarder.cjs',
                permissionForwarderScript: '/runtime/permission-forwarder.cjs',
            }),
            createPluginDir: async () => '/tmp/plugin-dir',
            disposePluginDir: async () => undefined,
            publishProviderTranscript: async () => undefined,
        }),
        transcripts: Object.freeze({
            fileFollow: Object.freeze({
                follow: async () => Object.freeze({ id: 'follow-1', drainNow: async () => undefined, close: async () => undefined }),
            }),
        }),
        accountUsage: Object.freeze({
            resolveSourceContext: async () => null,
            recordSnapshot: async () => ({ status: 'unavailable' as const, reason: 'daemon_unavailable' as const }),
            adoptProvisionalRecord: async () => ({ status: 'unavailable' as const, reason: 'daemon_unavailable' as const }),
        }),
        auth: Object.freeze({
            services: Object.freeze({
                refreshRuntimeAuth: async () => ({ status: 'unavailable' as const, reason: 'test' }),
            }),
        }),
        mcp: Object.freeze({ resolveForSession: async () => Object.freeze([]) }),
        toolExecution: Object.freeze({
            before: async (request: { input: unknown }) => ({ status: 'continue' as const, input: request.input }),
            observeAfter: async () => undefined,
        }) as NativeAgentSessionHostServiceOwners['toolExecution'],
        dispose: async () => undefined,
    });
}

/**
 * The Run's Agent: the plugin runtime whose `createExecutionRunBackend` launch
 * is the Agent process. It records exactly what that process would receive.
 */
function createRunAgent() {
    const launches: Array<Readonly<{
        runId: string | undefined;
        providerBinding: unknown;
        env: Readonly<Record<string, string>>;
    }>> = [];
    const createExecutionRunBackend = (options: Record<string, unknown>): ExecutionRunHostRuntime => {
        const isolation = options.isolation as { env?: Record<string, string> } | undefined;
        launches.push(Object.freeze({
            runId: options.runId as string | undefined,
            providerBinding: options.providerBinding,
            env: Object.freeze({ ...(isolation?.env ?? {}) }),
        }));
        const lifetime = new AbortController();
        return {
            readResumeSupport: async () => false,
            provisionRuntime: async () => ({ runtimeId: `agent-${String(options.runId)}` }),
            deliverInput: async () => ({ status: 'admitted' as const }),
            getRuntimeLifetimeSignal: () => lifetime.signal,
            cancel: async () => undefined,
            subscribeMessages: () => () => undefined,
            waitForTurnCompletion: async () => undefined,
            dispose: async () => {
                lifetime.abort();
            },
        } as unknown as ExecutionRunHostRuntime;
    };
    // Only the Run Agent's engine resolution is supplied; every host step above
    // and below it is the production owner. A Run may use another Agent or,
    // when it inherits, its parent Session's own Agent.
    const engineRegistry = {
        resolveForBackendId: async (backendId: string) => backendId === RUN_AGENT_ID || backendId === PARENT_AGENT_ID
            ? {
                backendId,
                agentId: backendId,
                provenance: 'external',
                runtimeOwner: { selected: { kind: 'host_configured' } },
                backend: { id: backendId, agentId: backendId, provenance: 'external' },
                agent: { id: backendId, provenance: 'external' },
                engineAdapter: { runtimeCore: { createExecutionRunBackend } },
                executionSurfaces: {},
                diagnostics: [],
            }
            : null,
    } as unknown as ResolvedCliEngineRegistry;
    return { launches, engineRegistry };
}

/**
 * Composes the parent Session, the real daemon dispatcher and the Session
 * client's Run host exactly as production does, with the parent Session on
 * resource A over `parentDeliveryMode`.
 */
export async function composeAttachedRunJourney(params: Readonly<{
    cleanups: Array<() => void | Promise<void>>;
    parentDeliveryMode: 'brokered' | 'direct';
    /** The calling test file's hoisted boundary state, which its module mocks read. */
    testState: AttachedRunCompositionTestState;
    envScope: ReturnType<typeof createEnvKeyScope>;
}>) {
    const { cleanups, parentDeliveryMode, testState, envScope } = params;
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-attached-run-broker-'));
    const agentPluginRoot = await mkdtemp(join(tmpdir(), 'happier-attached-run-agent-plugin-'));
    cleanups.push(async () => {
        const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 25 } as const;
        await rm(happyHomeDir, options);
        await rm(agentPluginRoot, options);
    });
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();

    // --- The parent Session's Agent: a real managed plugin generation. ---
    const changeService = createPublicHandoffArchiveChangeService(
        happyHomeDir,
        createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: pluginReloadController }),
    );
    cleanups.push(async () => {
        await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    });
    await writePublicHandoffAgentPluginFixture({ pluginRoot: agentPluginRoot, version: '1.0.0', generation: 'G' });
    await packAndCommitPublicHandoffFixture({
        archivePath: join(happyHomeDir, 'agent-g.tgz'),
        changeService,
        pluginId: PUBLIC_HANDOFF_AGENT_PLUGIN_ID,
        pluginRoot: agentPluginRoot,
    });
    const registryLease = await pluginReloadController.acquireRuntimeRegistry();
    cleanups.push(async () => await registryLease.release());
    const registry = registryLease.registry;
    const retainedAgent = registry.agentRuntimesByAgentId.get(PARENT_AGENT_ID)?.sessionRunnerFactoryBinding;
    const parentAgent = registry.contributes.agentDefinitionsById.get(PARENT_AGENT_ID);
    if (!retainedAgent || !parentAgent) throw new Error('Expected the committed parent Agent runner binding');

    // --- The parent Session on resource A, tracked by the daemon. ---
    const sessionId = 'session-attached-run-broker';
    const machineId = 'machine-attached-run-broker';
    const runnerProcessStartTimeMs = 1_717_171_717_000;
    const runnerProcessCommand = [
        process.execPath,
        '/opt/happier/versions/attached-run-broker/package-dist/index.mjs',
        PARENT_AGENT_ID,
    ].map((value) => JSON.stringify(value)).join(' ');
    testState.readProcessIdentityByPid.mockImplementation(async (pid: number) => pid === process.pid
        ? { pid, processStartTimeMs: runnerProcessStartTimeMs, command: runnerProcessCommand }
        : null);
    const runner = Object.freeze({
        pid: process.pid,
        processStartTimeMs: runnerProcessStartTimeMs,
        processCommandHash: hashProcessCommand(runnerProcessCommand),
    });
    const parentModelSelection = Object.freeze({
        v: 1 as const,
        updatedAt: 2,
        ref: Object.freeze({ agentTargetKey: PARENT_AGENT_TARGET_KEY, providerConnectionId: null, modelId: 'model-a' }),
    });
    const parentTeamCredentialBinding = Object.freeze({
        v: 1 as const,
        slot: Object.freeze({ kind: 'provider_model' as const }),
        resourceId: 'resource-a',
        expectedResourceRevision: 3,
        deliveryMode: parentDeliveryMode,
        teamId: 'team-a',
    });
    const tracked: TrackedSession = {
        pid: process.pid,
        sessionRunnerPid: process.pid,
        startedBy: 'daemon',
        happySessionId: sessionId,
        processStartTimeMs: runner.processStartTimeMs,
        processCommandHash: runner.processCommandHash,
        spawnOptions: {
            directory: happyHomeDir,
            backendTarget: { kind: 'backend', backendId: PARENT_AGENT_ID },
            modelSelection: parentModelSelection,
            teamCredentialBindings: [parentTeamCredentialBinding],
        },
        runnerAgentInvocationContext: { cwd: happyHomeDir, environment: {}, providerBindingActive: false },
        runnerAgentBootstrapIdentity: { agentId: PARENT_AGENT_ID, backendId: PARENT_AGENT_ID },
    };
    await writeSessionMarker({
        pid: runner.pid,
        happySessionId: sessionId,
        startedBy: 'daemon',
        processStartTimeMs: runner.processStartTimeMs,
        processCommandHash: runner.processCommandHash,
    });

    // --- Home broker open: the network boundary behind the daemon guard. ---
    const homeCleanups: Array<ReturnType<typeof vi.fn>> = [];
    const openTeamCredentialProviderBinding = vi.fn(async (input: Readonly<{
        resourceId: string;
        modelId: string;
        deliveryMode: string;
    }>) => {
        const cleanup = vi.fn(async () => undefined);
        homeCleanups.push(cleanup);
        return {
            providerBinding: {
                source: { kind: 'team_resource' as const, resourceId: input.resourceId, resourceRevision: 5 },
                model: { id: input.modelId, name: input.modelId },
                upstream: {
                    protocol: 'openai-responses' as const,
                    normalizedUrl: 'http://127.0.0.1:43123/v1',
                    credential: 'apiKey' as const,
                },
                materialization: { v: 1 as const, kind: 'spawnEnv' as const },
            },
            environmentOverlay: [{
                name: PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY,
                value: `scoped-${input.deliveryMode}-${input.resourceId}`,
                source: 'provider' as const,
            }],
            additionalRedactionValues: [`scoped-${input.deliveryMode}-${input.resourceId}`],
            cleanup,
        };
    });

    // --- The real daemon dispatcher. ---
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const daemon = await startDaemonSessionControlRuntime({
        machineId,
        serverId: 'server-attached-run-broker',
        serverBaseUrl: 'https://account.example.test',
        credentials: {
            token: 'token-attached-run-broker',
            encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        },
        daemonSessionMutationCustody: {
            stageTranscriptMessage: async () => { throw new Error('Unexpected recording attachment in this fixture'); },
            stageTranscriptEvent: async () => ({ persisted: true, delivered: true }),
        },
        api: {} as never,
        openTeamCredentialProviderBinding,
        connectedServicesMaterializationBaseDir: join(happyHomeDir, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null,
        getConnectedServiceQuotasCoordinator: () => null,
        pidToTrackedSession,
        pidToAwaiter: new Map(),
        pidToSpawnResultResolver: new Map(),
        pidToSpawnWebhookTimeout: new Map(),
        getApiMachineForSessions: () => null,
        spawnResourceCleanupByPid: new Map(),
        sessionAttachCleanupByPid: new Map(),
        connectedServicesRestartRequestedPids: new Set(),
        beforeShutdown: vi.fn(),
        onHappySessionWebhook: vi.fn(),
        requestShutdown: vi.fn(),
        processEnv: {},
    });
    cleanups.push(async () => await daemon.stopControlServer());
    const controlInput = testState.controlInputs.get(daemon.controlPort) as
        Parameters<typeof startDaemonControlServer>[0] | undefined;
    const daemonServices = controlInput?.agentRuntimeDaemonServices;
    if (!daemonServices) throw new Error('Expected the daemon Agent-runtime service dispatcher');

    const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir,
        publicReleaseRing: 'stable',
    });
    tracked.agentRuntimeDaemonServiceAuthorityFilePath = authorityFilePath;
    await expect(updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath({
        pid: runner.pid,
        sessionId,
        processCommandHash: runner.processCommandHash,
        processStartTimeMs: runner.processStartTimeMs,
        authorityFilePath,
    })).resolves.toBe(true);
    const authority = await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir,
        publicReleaseRing: 'stable',
        httpPort: daemon.controlPort,
        sessionId,
        tracked,
        resolveCurrentRetainedAgent: () => retainedAgent,
        readProcessIdentityByPidFn: testState.readProcessIdentityByPid,
    });

    // --- Loopback HTTP boundary: runner requests reach the real dispatcher. ---
    const daemonRequests: Array<ReturnType<typeof AgentRuntimeDaemonServiceRequestV1Schema.parse>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) {
            return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
        }
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(
            JSON.parse(String(init?.body ?? 'null')) as unknown,
        );
        const suppliedCapability = new Headers(init?.headers).get('x-happier-daemon-token');
        if (
            Number(url.port) !== authority.document.httpPort
            || suppliedCapability !== authority.document.capability
            || request.context.token !== authority.document.capability
        ) {
            return new Response(JSON.stringify({
                ok: false,
                error: { code: 'agent_runtime_daemon_service_forbidden', message: 'forbidden' },
            }), { status: 403, headers: { 'content-type': 'application/json' } });
        }
        daemonRequests.push(request);
        const response = await daemonServices.dispatch(request, {
            sessionId,
            runner: authority.document.runner,
            retainedAgent: authority.document.retainedAgent,
            invocationContext: tracked.runnerAgentInvocationContext!,
            trackedSession: tracked,
            isCurrent: async () => pidToTrackedSession.get(tracked.pid) === tracked,
            signal: init?.signal ?? undefined,
        });
        return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }));

    // --- The runner: its Agent source and the parent Session's native runtime. ---
    const source = await createRunnerAgentSessionRuntimeSource({
        happyHomeDir,
        publicReleaseRing: 'stable',
        authorityFilePath,
        expectedSessionId: sessionId,
    });
    if (!source) throw new Error('Expected the current Runner Agent runtime source');
    cleanups.push(async () => await source.retire?.());

    const parentMetadata = {
        ...createTestMetadata({ path: happyHomeDir, machineId }),
        modelSelectionIntentV2: {
            v: 2,
            updatedAt: 2,
            ref: {
                source: 'team_resource',
                resourceId: 'resource-a',
                teamId: 'team-a',
                expectedResourceRevision: 3,
                deliveryMode: parentDeliveryMode,
                agentTargetKey: PARENT_AGENT_TARGET_KEY,
                modelId: 'model-a',
            },
        },
    } as Metadata;
    const session = createMutableApiSessionClientFixture<Metadata>({ sessionId, metadata: parentMetadata });
    const plan = await createNativeAgentRuntimeSessionPlan({
        createRuntime: source.createRuntime,
        identity: source.identity,
        backend: projectEngineRuntimeContributionFromAgent(parentAgent, PARENT_AGENT_ID),
        agent: parentAgent,
        createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
        prepareTeamCredentialProviderBinding: source.prepareTeamCredentialProviderBinding,
        createInvocationServices: (input) => source.createInvocationServices({
            pluginId: source.identity.pluginId,
            pluginVersion: source.identity.pluginVersion,
            agentId: source.identity.agentId,
            occurrenceId: source.identity.occurrenceId,
            ...input,
            isOccurrenceCurrent: source.identity.isCurrent,
        }),
        authorizeNewTurn: source.authorizeNewTurn,
        attestSessionOpen: source.attestSessionOpen,
        retireRuntimeSource: source.retire,
        sessionInput: buildPluginSessionBindingInput({
            credentials: {
                token: 'token-attached-run-broker',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            directory: happyHomeDir,
            backendTarget: { kind: 'backend', backendId: PARENT_AGENT_ID },
            modelSelection: parentModelSelection,
            teamCredentialBindings: [parentTeamCredentialBinding],
        }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('Expected the native Session runtime factory');
    const parentRuntime = await plan.config.createSessionRuntime({
        directory: happyHomeDir,
        metadata: parentMetadata,
        machineId,
        session,
        transcriptSession: session,
        messageBuffer: {},
        messageQueue: new MessageQueue2<{ permissionMode: string }, { text: string }>((mode) => mode.permissionMode),
        mcpServers: {},
        permissionHandler: { cancelByPlugin: vi.fn(async () => undefined) },
        getPermissionMode: () => 'default',
        memoryRecallGuidanceEnabled: false,
    } as never);
    // The host Session loop's own projection of the created runtime.
    const { nativeRuntime } = resolveHostSessionRuntimeFactoryResult(parentRuntime);
    cleanups.push(async () => await (parentRuntime.operations as unknown as Readonly<{
        resetOrDisposeRuntime(): Promise<void>;
    }>).resetOrDisposeRuntime());

    // The parent Session itself opened A for its retained Agent.
    expect(openTeamCredentialProviderBinding).toHaveBeenCalledTimes(1);
    expect(openTeamCredentialProviderBinding).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId,
        teamId: 'team-a',
        resourceId: 'resource-a',
        deliveryMode: parentDeliveryMode,
        agentId: retainedAgent.agentId,
        modelId: 'model-a',
    }));
    expect(openTeamCredentialProviderBinding.mock.calls[0]?.[0]).not.toHaveProperty('consumer');

    // --- The Session client's Run host, exactly as production composes it. ---
    // `runHostSessionRuntime` installs the Run preparer from this exact
    // `nativeRuntime` projection; without it every attached Run's own Team
    // selection has no opener.
    const nativeParent = nativeRuntime as Readonly<{
        prepareRunTeamCredentialProviderBinding?: (...args: never[]) => Promise<unknown>;
    }> | null;
    const prepareRunBinding = nativeParent?.prepareRunTeamCredentialProviderBinding;
    expect(typeof prepareRunBinding, 'the host Session nativeRuntime exposes the Run Team credential preparer')
        .toBe('function');
    if (!prepareRunBinding) throw new Error('Expected the Run Team credential preparer');
    registerSessionClientRuntimeHandlers({
        serverId: 'server-attached-run-broker',
        serverUrl: 'https://account.example.test',
        readOwnerAccountCredentials: async () => null,
        rpcHandlerManager: session.rpcHandlerManager,
        token: 'token-attached-run-broker',
        metadataPath: happyHomeDir,
        metadata: parentMetadata,
        sessionId,
        session: session as never,
        getSessionMetadata: () => session.getMetadataSnapshot(),
        // `runHostSessionRuntime` binds the native runtime's preparer exactly so.
        sessionRuntimeControls: {
            prepareRunTeamCredentialProviderBinding: prepareRunBinding.bind(nativeParent) as never,
        },
        enqueueSessionUserMessage: vi.fn(),
        enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
        enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
        enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
        sendAgentMessageEphemeral: vi.fn(),
        getTranscriptQueryContext: () => ({ encryptionMode: 'plain' as const }),
        persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
        socketEmitExecutionRunUpdated: vi.fn(),
    });
    const sessionInteractionHost = testState.sessionInteractionHosts.at(-1) as
        NativeAgentSessionInteractionHostBinding | undefined;
    if (!sessionInteractionHost?.prepareRunTeamCredentialProviderBinding) {
        throw new Error('Expected the Session client Run host binding');
    }

    const runAgent = createRunAgent();
    const startRun = async (
        runId: string,
        // Omitted: the Run selected nothing and inherits its parent Session's.
        selection?: TeamCredentialProviderModelSelectionV1,
        backendId: string = RUN_AGENT_ID,
    ) => {
        const runtime = createExecutionRunBridgeRuntime({
            cwd: happyHomeDir,
            scope: 'session_owned',
            runId,
            backendId,
            backendTarget: { kind: 'backend', backendId },
            permissionMode: 'default',
            ...(selection ? { teamCredentialModel: selection } : {}),
            sessionInteractionHost,
            engineRegistry: runAgent.engineRegistry,
            happyHomeDir,
            machineId,
            happierSessionId: sessionId,
        });
        await runtime.provisionRuntime({ initialPrompt: 'delegate' });
        return runtime;
    };
    const runOpenOperations = () => daemonRequests
        .map((request) => request.operation)
        .filter((operation) => operation.kind === 'provider_broker.binding.open' && operation.consumer);
    return {
        sessionId,
        session,
        tracked,
        homeCleanups,
        openTeamCredentialProviderBinding,
        runAgent,
        startRun,
        runOpenOperations,
    };
}
