import type { PluginAgentContributionV2 } from '@happier-dev/protocol';

export type PrimaryAgentContributionDefinition = Extract<
    PluginAgentContributionV2,
    Readonly<{ primary: 'sessions' | 'executionRuns' }>
>;

export type AgentSessionCapabilities = NonNullable<
    PrimaryAgentContributionDefinition['capabilities']['sessions']
>;

export type AgentExecutionRunCapabilities = NonNullable<
    PrimaryAgentContributionDefinition['capabilities']['executionRuns']
>;

export function isPrimaryAgentContributionDefinition(
    definition: PluginAgentContributionV2,
): definition is PrimaryAgentContributionDefinition {
    return 'primary' in definition;
}

export function readAgentPrimaryRuntime(
    definition: PluginAgentContributionV2 | null | undefined,
): PrimaryAgentContributionDefinition['runtime'] | null {
    return definition && isPrimaryAgentContributionDefinition(definition)
        ? definition.runtime
        : null;
}

export function readAgentSessionCapabilities(
    definition: PluginAgentContributionV2 | null | undefined,
): AgentSessionCapabilities | null {
    return definition && isPrimaryAgentContributionDefinition(definition)
        ? definition.capabilities.sessions ?? null
        : null;
}

export function readAgentExecutionRunCapabilities(
    definition: PluginAgentContributionV2 | null | undefined,
): AgentExecutionRunCapabilities | null {
    return definition && isPrimaryAgentContributionDefinition(definition)
        ? definition.capabilities.executionRuns ?? null
        : null;
}
