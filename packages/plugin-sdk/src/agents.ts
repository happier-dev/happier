import {
    buildBackendTargetKeyV2,
} from '@happier-dev/protocol/plugins/agents';

export type {
    AgentModelConfig,
    AgentModelNonAcpApplyScope,
} from '@happier-dev/agents';

// These values remain owned by their Protocol / Agents policy modules. The SDK
// only projects the exact identities needed by Agent plugin authors.
export {
    CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
    CURRENT_FLAGSHIP_CLAUDE_MODEL_ID,
} from '@happier-dev/protocol/agents/claude';
export {
    CLAUDE_EFFORT_LEVELS,
    buildClaudeModelOptions,
    formatClaudeEffortLevelLabel,
    normalizeClaudeEffortLevel,
} from '@happier-dev/agents/providers/claude-model-options';
export type { ClaudeEffortLevel } from '@happier-dev/agents/providers/claude-model-options';

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
    PluginAgentContributionV2 as AgentContribution,
} from '@happier-dev/protocol';
export type { PluginAgentDefinition } from './definePlugin.js';

export const buildAgentTargetKeyV2: (target: Readonly<{
    kind: 'backend';
    backendId: string;
    configuredBackendId?: string;
    sourceKind?: 'built_in' | 'configured';
}>) => string = buildBackendTargetKeyV2;
