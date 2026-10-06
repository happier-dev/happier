import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/plugins/agents';

export type { AgentExecutionTargetV1 } from '@happier-dev/protocol/plugins/agents';

export type {
    AgentModelConfig,
    AgentModelNonAcpApplyScope,
} from '@happier-dev/agents';
export type { AgentSessionRuntimeCapabilities } from './agentRuntime/session.js';

export { BackendSurfaceOperationCatalogV1 as AgentSurfaceOperationCatalogV1 } from '@happier-dev/protocol/plugins/backend-surface-declaration';
export { PluginBackendCapabilitiesV1Schema as PluginAgentCapabilitiesV1Schema } from '@happier-dev/protocol/plugins/backendDefinitionV1';
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

export { CodexPassiveRealtimeSetupResultV1Schema as AgentPassiveRealtimeSetupResultV1Schema, CodexPassiveRealtimeSetupStatusV1Schema as AgentPassiveRealtimeSetupStatusV1Schema } from '@happier-dev/protocol/capabilities/codexPassiveRealtimeSetup';
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

/**
 * Builds the persisted Agent target key from the one canonical
 * `AgentExecutionTargetV1`. The retired backend-target parameter shape is not
 * part of the public author contract: qualified plugin contribution identities
 * are the only author-visible target, and the host owns the legacy
 * `backend:…` key format internally through the same implementation.
 */
export const buildAgentTargetKeyV2: (target: AgentExecutionTargetV1) => string =
    buildBackendTargetKeyV2;
