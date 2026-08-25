import type { PluginDaemonConnectionStateSource } from '../pluginConnectionStateSource';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExternalSessionHostOperationPort } from '@/session/external/hostOperationOwner';
import type {
    ExternalSessionExecutionSurface,
    ExternalSessionProviderOps,
} from '@/session/external/providerOps';
import type {
    AgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';
import type {
    PluginRuntimeAuthoritySnapshotV1,
} from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import type {
    CreateAgentInvocationServices,
} from '@/plugins/runtime/invocation/services/types';
import type {
    NativeAgentNewTurnAdmissionWitness,
    NativeAgentNewTurnAdmissionOptions,
} from './nativeAgentSession';
import type {
    DaemonAgentRuntimeTurnContributionsBridge,
} from '@/agent/runtime/session/process/agentRuntimeDaemonTurnContributionsBridge';
import type {
    SessionModelTransitionProviderTargetAuthorizer,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import type {
    RunnerManagedServiceEndpointReadPort,
} from '@/agent/runtime/session/process/managedServiceEndpointReadProtocol';
import type {
    RunnerManagedServicesCustodyPortV1,
} from '@/agent/runtime/session/process/runnerManagedServicesCustody';
import type { SessionEnvOverlayV1 } from '@happier-dev/protocol';
import type {
    ProviderBindingLaunchHandoffV1,
} from '@/plugins/runtime/providerBindings/handoff';
import type {
    ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';

export type ExternalSessionHostOperationPortFactory = Readonly<{
    bindSession(sessionId: string): ExternalSessionHostOperationPort;
}>;

export type RunnerAgentExternalSessionProviderOps = Required<Pick<
    ExternalSessionProviderOps,
    | 'validateSource'
    | 'listCandidates'
    | 'resolveLinkIdentity'
    | 'canonicalizeLinkedSession'
    | 'pageTranscript'
    | 'readAfterTranscript'
>>;

export type RunnerAgentSessionRuntimeSource = Readonly<{
    /** Exact generation-pinned Agent contribution used to construct this Session. */
    agentContribution: ResolvedAgentContribution;
    identity: Readonly<{
        pluginId: string;
        pluginVersion: string;
        /** Host routing id; qualified for installed Agents. */
        agentId: string;
        backendId: string;
        generation: string;
        immutableGenerationId?: string | null;
        runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
        isCurrent(): boolean;
    }>;
    /**
     * Completes the runner's exact session-scoped daemon authority claim after
     * the host has created the canonical Happier session and before any Agent
     * factory or invocation service can be reached.
     */
    prepareForSession?(params: Readonly<{
        sessionId: string;
        signal: AbortSignal;
    }>): Promise<void>;
    prepareManagedProviderBinding?(params: Readonly<{
        sessionId: string;
        cwd: string;
        environment: Readonly<Record<string, string>>;
        signal: AbortSignal;
        session: Readonly<{
            id: string;
            current: import('@/agent/runtime/state/currentSessionUiTypes')
                .HostCurrentSessionUiServices;
        }>;
        readActiveTurnAdmissionWitness():
            NativeAgentNewTurnAdmissionWitness | null;
    }>): Promise<Readonly<{
        handoff: ProviderBindingLaunchHandoffV1;
        environmentOverlay: SessionEnvOverlayV1;
        additionalRedactionValues: readonly string[];
        transformAgentChildLaunchEnvironment(
            environment: Readonly<Record<string, string>>,
        ): Readonly<Record<string, string>>;
        cleanup: (() => void) | null;
    }> | null>;
    createRuntime(params: Readonly<{
        signal: AbortSignal;
    }>): Promise<AgentRuntime>;
    createInvocationServices: CreateAgentInvocationServices;
    authorizeNewTurn: (
        witness: NativeAgentNewTurnAdmissionWitness,
        options: NativeAgentNewTurnAdmissionOptions,
    ) => Promise<Readonly<{ status: 'admitted' }>>;
    prepareRuntimeFactory?(): Promise<void>;
    retire?(): Promise<void>;
    attestSessionOpen?(params: Readonly<{
        phase: 'prepare' | 'commit';
        request: AgentSessionOpenRequest;
        providerSessionId: string | null;
        signal: AbortSignal;
    }>): Promise<void>;
    daemonTurnContributionsBridge?:
        DaemonAgentRuntimeTurnContributionsBridge;
    daemonModelTransitionAuthorizer?:
        SessionModelTransitionProviderTargetAuthorizer;
    externalSessionHostOperations?: ExternalSessionHostOperationPortFactory | null;
    /**
     * External Sessions authority of the exact immutable generation that
     * admitted this Session. The retained Session's private composition —
     * source validation, link identity, transcript paging and follow-target
     * resolution — resolves through this generation only. The current-global
     * author service keeps its own separate current-H owner, so a G→H plugin
     * replacement can never hand a G Session an H-derived source or link
     * identity, and never rejects a source G still understands.
     */
    retainedExternalSessionProviderOps?:
        ExternalSessionExecutionSurface | null;
    managedServiceEndpointReadPort?:
        RunnerManagedServiceEndpointReadPort | null;
    managedServicesCustodyPort?:
        RunnerManagedServicesCustodyPortV1 | null;
    agentSessionRealtimeVoiceAuthority?: AgentSessionRealtimeVoiceAuthority | null;
}>;

export type ResolveEngineRegistryParams = Readonly<{
    happyHomeDir?: string;
    backendId?: string;
    contributes?: ResolvedContributionRegistry;
    connectionStateSource?: PluginDaemonConnectionStateSource | null;
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry | null;
    /** Private runner invariant: a daemon-admitted session must use its exact runner-local runtime source. */
    requireRunnerAgentSessionRuntimeSource?: boolean;
    /** Private admitted source. It constructs one real Agent runtime in this runner and is not a daemon proxy. */
    runnerAgentSessionRuntimeSource?: RunnerAgentSessionRuntimeSource | null;
}>;
