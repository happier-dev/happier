import type { PluginContextV1 } from './context.js';
import type { RuntimeCoreV1 } from './runtime/session.js';
import type {
    AttachSurfaceV1,
    CheckpointSurfaceV1,
    ExternalSessionSurfaceV1,
    ForkSurfaceV1,
    HandoffSurfaceV1,
    RuntimeFacets,
    TerminalRuntimeSurfaceV1,
} from '@happier-dev/agents';
import type { AgentProviderBindingAdapterV1 } from './agentRuntime/providerBinding.js';

export type {
    AgentProviderBindingAdapterV1,
    AgentProviderBindingCredentialV1,
    AgentProviderBindingMaterializeInputV1,
    AgentProviderBindingPrepareInputV1,
    AgentProviderBindingPreparedV1,
    AgentProviderBindingResolvedFactsV1,
} from './agentRuntime/providerBinding.js';

// NOTE: This is intentionally minimal in V1. The runtime lane owns the concrete
// executable surface shapes (terminal runtime, direct sessions, handoff, etc.).
//
// The purpose of this contract is to:
// - make executable agent runtime wiring explicit (no `apps/cli` imports from plugins)
// - provide a single runtime object that can carry optional runtime-family surfaces
export type AgentMessageMetaEnricherV1 = Readonly<{
    buildOutgoingMessageMetaExtras?: (params: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
}>;

export type AgentRuntimeV1 = Readonly<{
    runtimeCore?: RuntimeCoreV1;
    facets?: RuntimeFacets;
    messageMeta?: AgentMessageMetaEnricherV1;

    // Executable agent surface bindings. Manifest `surfaceHandlers[]` remains the
    // static support/projection source of truth; the host publishes these bindings
    // only for declared operations.
    terminalRuntimeSurface?: TerminalRuntimeSurfaceV1;
    externalSessionSurface?: ExternalSessionSurfaceV1;
    attachSurface?: AttachSurfaceV1;
    handoffSurface?: HandoffSurfaceV1;
    forkSurface?: ForkSurfaceV1;
    checkpointSurface?: CheckpointSurfaceV1;
}>;

export type RegisterAgentRuntimeV1 = Readonly<{
    agentId: string;
    providerBinding?: AgentProviderBindingAdapterV1;
    create: (ctx: PluginContextV1) => AgentRuntimeV1 | Promise<AgentRuntimeV1>;
}>;
