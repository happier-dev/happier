import type { PluginAgentContributionV2 } from '@happier-dev/protocol';

export type PrimaryAgentContributionDefinition = Extract<
    PluginAgentContributionV2,
    Readonly<{ primary: 'sessions' | 'executionRuns' }>
>;

type SessionPrimaryAgentContributionDefinition = Extract<
    PrimaryAgentContributionDefinition,
    Readonly<{ primary: 'sessions' }>
>;

type ExecutionPrimaryAgentContributionDefinition = Extract<
    PrimaryAgentContributionDefinition,
    Readonly<{ primary: 'executionRuns' }>
>;

export type AgentSessionCapabilities = NonNullable<
    SessionPrimaryAgentContributionDefinition['capabilities']['sessions']
>;

export type AgentExecutionRunCapabilities = NonNullable<
    ExecutionPrimaryAgentContributionDefinition['capabilities']['executionRuns']
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
    return definition && isPrimaryAgentContributionDefinition(definition) && definition.primary === 'sessions'
        ? definition.capabilities.sessions
        : null;
}

/**
 * The one effective Execution Run capability reader.
 *
 * Execution-primary Agents declare their finite Run capabilities explicitly
 * (`open` is a closed finite list; nothing is inferred beyond it).
 *
 * Session-primary Agents do not declare an `executionRuns` block — Protocol
 * rejects one. For them the host derives the finite Run projection from their
 * declared Session facts and provider-session identity:
 *
 * - `open: ['create']` derives from the Session `open` intent `create`, and
 *   `resume` derives from the Session `open` intent `resume`. `fork` is never
 *   derived: Run-level fork is not a Session-derived capability.
 * - `stop` derives from the Session `cancel` fact.
 * - `checkpoint` derives from the provider-session identity fact represented
 *   by Session resume. `continuationVerification` governs verification of a
 *   continuation request; it does not create provider Session identity.
 *
 * An Agent whose derived `open` set is empty has no effective Run capability
 * and this returns `null`, matching the declared shape's non-empty bound.
 */
export function readAgentExecutionRunCapabilities(
    definition: PluginAgentContributionV2 | null | undefined,
): AgentExecutionRunCapabilities | null {
    if (!definition || !isPrimaryAgentContributionDefinition(definition)) return null;
    if (definition.primary === 'executionRuns') {
        return definition.capabilities.executionRuns;
    }
    const sessions = definition.capabilities.sessions;
    if (!sessions) return null;
    const open = [
        ...(sessions.open.includes('create') ? ['create'] as const : []),
        ...(sessions.open.includes('resume') ? ['resume'] as const : []),
    ];
    if (open.length === 0) return null;
    return {
        open,
        checkpoint: sessions.open.includes('resume'),
        stop: sessions.cancel === true,
    };
}
