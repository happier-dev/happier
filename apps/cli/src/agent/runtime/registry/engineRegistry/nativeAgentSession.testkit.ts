import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import type { ResolvedAgentContribution, ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';
import type { NativeAgentSessionHostServiceOwners } from './nativeAgentSession';

export function createNativeSessionClientTestPort(sessionId: string, overrides: Readonly<Record<string, unknown>> = {}) {
    let agentState: Record<string, unknown> = {};
    let metadata: Record<string, unknown> = {
        path: '/tmp/test', host: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib', happyToolsDir: '/tmp/.happier/tools',
    };
    const handlers = new Map<string, (input: unknown) => unknown>();
    const metadataListeners = new Set<() => void>();
    const updateMetadata = async (updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
        metadata = updater(metadata);
        for (const listener of metadataListeners) listener();
    };
    return {
        sessionId,
        rpcHandlerManager: {
            registerHandler: (method: string, handler: (input: unknown) => unknown) => handlers.set(method, handler),
            invokeLocal: async (method: string, input: unknown) => await handlers.get(method)?.(input),
        },
        updateAgentState: async (updater: (state: Record<string, unknown>) => Record<string, unknown>) => { agentState = updater(agentState); },
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
