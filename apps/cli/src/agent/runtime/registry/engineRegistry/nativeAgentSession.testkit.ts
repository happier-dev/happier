import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import type { ResolvedAgentContribution, ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';
import { createNativeAgentRuntimeSessionPlan, type NativeAgentSessionHostServiceOwners } from './nativeAgentSession';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import axios from 'axios';
import { onTestFinished, vi } from 'vitest';
import { createInstalledProjectAgentLaunchFixture } from '@/daemon/testkit/installedProjectAgentLaunchFixture';
import { createRunnerAgentProjectLaunchInvocation } from '@/daemon/agentRuntime/runnerAgentProjectLaunch';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

/** Real captured requester and Project preparation, with only Home/OS boundaries supplied by the installed fixture. */
export async function createNativeAgentLaunchPreparationFixture() {
    const previousGet = axios.get;
    const previousPost = axios.post;
    const previousGetImplementation = vi.isMockFunction(previousGet) ? previousGet.getMockImplementation() : undefined;
    const previousPostImplementation = vi.isMockFunction(previousPost) ? previousPost.getMockImplementation() : undefined;
    const previousFetch = globalThis.fetch;
    const custodianAccountId = 'requester';
    const fixture = await createInstalledProjectAgentLaunchFixture({ homeServerIdentityId: 'srv_native_launch_fixture',
        machineAccess: { custodianAccountId, role: 'manage' } });
    const homeGet = vi.mocked(axios.get).getMockImplementation();
    const homePost = vi.mocked(axios.post).getMockImplementation();
    if (!homeGet || !homePost) throw new Error('Installed Home transport fixture is unavailable');
    const homeFetch = globalThis.fetch;
    // Preserve unrelated transport boundaries (notably real local hook HTTP).
    globalThis.fetch = (input, init) => new URL(String(input)).hostname === 'session-home.test'
        ? homeFetch(input, init) : previousFetch(input, init);
    onTestFinished(() => {
        axios.get = previousGet;
        axios.post = previousPost;
        if (previousGetImplementation && vi.isMockFunction(previousGet)) previousGet.mockImplementation(previousGetImplementation);
        if (previousPostImplementation && vi.isMockFunction(previousPost)) previousPost.mockImplementation(previousPostImplementation);
        globalThis.fetch = previousFetch;
    });
    const projectLaunchContext = {
        requester: { bootstrap: fixture.f.bootstrap, isCurrent: fixture.f.bootstrap.isCurrent },
        isCurrent: fixture.f.isHomeCurrent,
        resolveRuntime: (ingress: Parameters<typeof fixture.machine.resolveProjectFiniteRuntime>[0]) => fixture.machine.resolveProjectFiniteRuntime(ingress),
    };
    return {
        homeGet, homePost, projectLaunchContext,
        happyHomeDir: fixture.f.directory,
        requesterIdentity: selectHostRequesterExecutionIdentity({
            sessionRequester: fixture.f.bootstrap.attribution,
            sessionRequesterHomeServerIdentityId: fixture.f.bootstrap.homeServerIdentityId,
            hostHomeServerIdentityId: fixture.f.bootstrap.homeServerIdentityId,
            sessionCustodianAccountId: custodianAccountId,
        }),
        prepare(cwd: string, signal: AbortSignal) {
            const invocation = createRunnerAgentProjectLaunchInvocation({ ...projectLaunchContext, cwd, signal });
            onTestFinished(() => invocation.disposeProjectAgentLaunch());
            return invocation.prepareAgentNativeLaunch;
        },
    };
}

/** Bind the same caller-owned preparation used by runner composition to real invocation services. */
export function bindNativeAgentLaunchPreparationFixture(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    preparation: Awaited<ReturnType<typeof createNativeAgentLaunchPreparationFixture>>,
): ResolvedExecutablePluginRuntimeRegistry {
    const createServices = registry.createAgentInvocationServices;
    if (!createServices) throw new Error('Admitted Agent invocation services are unavailable');
    return Object.freeze({
        ...registry,
        createAgentInvocationServices: input => createServices({
            ...input,
            prepareAgentNativeLaunch: preparation.prepare(input.cwd, input.signal),
        }),
    });
}

export type NativeAgentRuntimeSessionFixtureParams = Omit<HostSessionRuntimeFactoryParams, 'currentSessionPresentation'>;

/** Supplies the real logical-Session owner normally composed by runHostSessionRuntime. */
export async function createNativeAgentRuntimeSessionPlanFixture(
    params: Parameters<typeof createNativeAgentRuntimeSessionPlan>[0],
) {
    const plan = await createNativeAgentRuntimeSessionPlan(params);
    const createSessionRuntime = plan.config.createSessionRuntime;
    if (!createSessionRuntime) throw new Error('Native Session factory unavailable');
    return {
        ...plan,
        config: {
            ...plan.config,
            createSessionRuntime: async (hostRuntimeParams: NativeAgentRuntimeSessionFixtureParams) => {
                const presentationHost = createCurrentSessionPresentationHost({
                    session: hostRuntimeParams.session,
                    signal: params.generationSignal ?? params.lease?.retirementSignal ?? new AbortController().signal,
                    ...(hostRuntimeParams.recordRuntimeLimitMeasurement
                        ? { recordRuntimeLimitMeasurement: hostRuntimeParams.recordRuntimeLimitMeasurement }
                        : {}),
                });
                return await createSessionRuntime({
                    ...hostRuntimeParams,
                    currentSessionPresentation: presentationHost.bindCurrentSession,
                });
            },
        },
    };
}

export function createNativeSessionClientTestPort(sessionId: string, overrides: Readonly<Record<string, unknown>> = {}) {
    let agentState: Record<string, unknown> = {};
    let metadata: Record<string, unknown> = {
        path: '/tmp/test', host: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib', happyToolsDir: '/tmp/.happier/tools',
    };
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    const rpcHandlerManager = Object.assign(rpc, {
        registerHandler: rpc.registerHandler.bind(rpc),
        invokeLocal: rpc.invokeLocal.bind(rpc),
    });
    const metadataListeners = new Set<() => void>();
    const updateMetadata = async (updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
        metadata = updater(metadata);
        for (const listener of metadataListeners) listener();
    };
    return {
        sessionId,
        rpcHandlerManager,
        updateAgentState: async (updater: (state: Record<string, unknown>) => Record<string, unknown>) => { agentState = updater(agentState); },
        updateAgentStateRequestSettlement: async (updater: (state: Record<string, unknown>) => Record<string, unknown>) => { agentState = updater(agentState); },
        updateMetadata, updateMetadataAsCurrentPublisher: updateMetadata,
        getMetadataSnapshot: () => metadata, getAgentStateSnapshot: () => agentState,
        readSessionTurnsProjection: async () => null,
        on: (event: string, listener: () => void) => { if (event === 'metadata-updated') metadataListeners.add(listener); },
        off: (event: string, listener: () => void) => { if (event === 'metadata-updated') metadataListeners.delete(listener); },
        ...overrides,
    };
}

export function createExternalContributionFixtures(agentId: string, sessionOpenKinds: readonly ('create' | 'resume' | 'fork')[] = ['create', 'resume']) {
    return {
        backend: {
            id: agentId, agentId, provenance: 'external', source: { kind: 'path' },
            definition: { kindVersion: 1, id: agentId, agentId }, pluginId: 'acme.agent-plugin',
        },
        agent: {
            id: agentId, provenance: 'external', source: { kind: 'path' },
            definition: { kindVersion: 1, id: agentId, ownedBackendIds: [agentId] },
            richDefinition: {
                provenance: 'external', definition: {
                    id: agentId, title: { key: 'agents.acme.title', fallback: 'Acme Agent' },
                    description: { key: 'agents.acme.description', fallback: 'Acme Agent' },
                    runtime: { kind: 'custom' }, primary: 'sessions',
                    capabilities: { sessions: { open: [...sessionOpenKinds], delivery: new Array<'newTurn' | 'steer' | 'followUp'>('newTurn'), cancel: false } },
                },
            },
            pluginId: 'acme.agent-plugin',
        },
    } satisfies Readonly<{ backend: ResolvedAgentRuntimeContribution; agent: ResolvedAgentContribution }>;
}

export function createLease(agentId: string): AgentRuntimeRegistrationLease {
    return {
        pluginId: 'acme.agent-plugin', pluginVersion: '1.0.0', agentId, localAgentId: agentId,
        occurrenceId: 'native-agent-session-fixture',
        sourceCustody: { kind: 'development', registeredRootId: 'native-agent-session-fixture' },
        immutableGenerationId: null, hasPrimaryRuntime: true, isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        async createAgentRuntimeSurfaceInvocationContext() { throw new Error('Session adapter fixture should not create an Agent runtime surface invocation context'); },
        createRuntime: async () => { throw new Error('not used by the session adapter'); },
    };
}

export function createSessionHostServiceOwners(): NativeAgentSessionHostServiceOwners {
    return Object.freeze({
        features: Object.freeze({ isEnabled: () => false }),
        happierTools: Object.freeze({ readPluginToolCatalog: async () => Object.freeze([]) }),
        sessionHooks: Object.freeze({
            startServer: async () => Object.freeze({ port: 4312, stop: () => undefined, dispose: async () => undefined }),
            resolveForwarderAssets: async () => Object.freeze({ nodeExecutable: '/runtime/node', sessionForwarderScript: '/runtime/session-forwarder.cjs', permissionForwarderScript: '/runtime/permission-forwarder.cjs' }),
            createPluginDir: async () => '/tmp/plugin-dir', disposePluginDir: async () => undefined,
            publishProviderTranscript: async () => undefined,
        }),
        transcripts: Object.freeze({ fileFollow: Object.freeze({ follow: async () => Object.freeze({ id: 'follow-1', drainNow: async () => undefined, close: async () => undefined }) }) }),
        accountUsage: Object.freeze({
            resolveSourceContext: async () => null,
            recordSnapshot: async () => ({ status: 'unavailable' as const, reason: 'daemon_unavailable' as const }),
            adoptProvisionalRecord: async () => ({ status: 'unavailable' as const, reason: 'daemon_unavailable' as const }),
        }),
        mcp: Object.freeze({ resolveForSession: async () => Object.freeze([]) }),
        toolExecution: Object.freeze({
            before: async (request: Parameters<NativeAgentSessionHostServiceOwners['toolExecution']['before']>[0]) => ({ status: 'continue' as const, input: request.input }),
            observeAfter: async () => undefined,
        }),
        dispose: async () => undefined,
    });
}
