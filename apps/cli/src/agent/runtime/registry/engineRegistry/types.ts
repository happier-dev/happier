import type { LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import type { PluginDaemonConnectionStateSource } from '../pluginConnectionStateSource';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { AgentRuntime } from '@happier-dev/plugin-sdk/agent-runtime';
import type { AgentRuntimeDaemonSessionDescriptorV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import type { ExternalSessionHostOperationPort } from '@/session/external/hostOperationOwner';
import type {
    AgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/registerAgentSessionRealtimeVoiceRpc';

export type ExternalSessionHostOperationPortFactory = Readonly<{
    bindSession(sessionId: string): ExternalSessionHostOperationPort;
}>;

export type PluginLocalServicesRuntimeBridgeFactory = Pick<LocalServicesDaemonRuntime, 'createPluginLocalServicesBridge'>;

export type ResolveEngineRegistryParams = Readonly<{
    happyHomeDir?: string;
    backendId?: string;
    contributes?: ResolvedContributionRegistry;
    connectionStateSource?: PluginDaemonConnectionStateSource | null;
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry | null;
    localServicesRuntime?: PluginLocalServicesRuntimeBridgeFactory | null;
    /** Private daemon-authority invariant: native plugin runtime must arrive through the daemon-owned carrier. */
    requireDaemonAgentRuntimeCarrier?: boolean;
    /** Private admitted session carrier. It is bounded authority, identity, and a local proxy—never an activation lease. */
    nativeAgentRuntimeCarrier?: Readonly<{
        descriptor: AgentRuntimeDaemonSessionDescriptorV1;
        runtime: AgentRuntime;
        externalSessionHostOperations: ExternalSessionHostOperationPortFactory;
        agentSessionRealtimeVoiceAuthority?: AgentSessionRealtimeVoiceAuthority | null;
        retirementSignal?: AbortSignal;
        isCurrent(): boolean;
    }> | null;
}>;
