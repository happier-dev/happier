import {
    buildBackendTargetKeyV2,
} from '@happier-dev/protocol/plugins/agents';

export type {
    AgentModelConfig,
    AgentModelNonAcpApplyScope,
} from '@happier-dev/agents';
export type { AgentSessionRuntimeCapabilities } from './agentRuntime/session.js';

export {
    BackendSurfaceOperationCatalogV1 as AgentSurfaceOperationCatalogV1,
    PluginBackendCapabilitiesV1Schema as PluginAgentCapabilitiesV1Schema,
} from '@happier-dev/protocol/plugins/agents';
export type {
    AIBackendProfile as AgentProfile,
    AgentModelDescriptor,
    AgentModelOption,
    AgentModelOptionOverrideRule,
    AgentModelOptionValueId,
    EnvironmentVariable,
    PluginAgentCapabilitiesV2,
    PluginAgentCapabilitySurfaceV2,
    PluginAgentContributionV2 as AgentContribution,
    PluginAgentExecutionRunCapabilitiesV2,
    PluginAgentSessionCapabilitiesV2,
    PluginAgentToolsCapabilityV2,
    PluginAgentToolsDeliveryV2,
} from '@happier-dev/protocol';
export type { PluginAgentDefinition } from './definePlugin.js';

export {
    CodexPassiveRealtimeSetupResultV1Schema as AgentPassiveRealtimeSetupResultV1Schema,
    CodexPassiveRealtimeSetupStatusV1Schema as AgentPassiveRealtimeSetupStatusV1Schema,
} from '@happier-dev/protocol/capabilities';
export type {
    CodexPassiveRealtimeSetupResultV1 as AgentPassiveRealtimeSetupResultV1,
    CodexPassiveRealtimeSetupStatusV1 as AgentPassiveRealtimeSetupStatusV1,
} from '@happier-dev/protocol/capabilities';

/**
 * The Agent capability projection an Agent plugin manifest authors against.
 *
 * The derivation rules it applies — hosting a terminal from
 * `localControl.attachStrategy`, appending the `fork` open route, and setting
 * `conversationRollback` — are host rules, not plugin data. Publishing the
 * projector is what lets an external Agent plugin author the same manifest a
 * bundled one does instead of hand-copying rules the host is free to change.
 */
export {
    projectAgentCapabilitiesV2FromDefinition,
} from '@happier-dev/agents/definitions/agent-capabilities';
export type {
    AgentDefinitionCapabilityFacts,
    AgentLocalControlDeclaration,
    AuthoredAgentCapabilitiesV2,
    AuthoredAgentCapabilitySurfaceV2,
    AuthoredAgentSessionCapabilitiesV2,
    AuthoredAgentSessionOpenRouteV2,
} from '@happier-dev/agents/definitions/agent-capabilities';

export const buildAgentTargetKeyV2: (target: Readonly<{
    kind: 'backend';
    backendId: string;
    configuredBackendId?: string;
    sourceKind?: 'built_in' | 'configured';
}>) => string = buildBackendTargetKeyV2;
