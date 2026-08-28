import type {
    PluginAgentCapabilitiesV2,
    PluginContributionIdentityV1,
    PluginProjectionV2,
} from '@happier-dev/protocol';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';
import {
    evaluateAgentSessionCapabilitySupport,
    type AgentSessionCapabilityKey,
} from '@happier-dev/agents';

export type CurrentProjectedAgentSessionOpenOperation = NonNullable<
    PluginAgentCapabilitiesV2['sessions']
>['open'][number];
export type CurrentProjectedAgentUsageLimitRecoveryOperation = NonNullable<
    NonNullable<NonNullable<PluginAgentCapabilitiesV2['sessions']>['usageLimitRecovery']>['active']
>[number];
export type CurrentProjectedAgentCapabilitySurface = NonNullable<
    PluginAgentCapabilitiesV2['surfaces']
>[number];

/**
 * A lifecycle-capability fact from one ready V2 projection. Presentation
 * backing is deliberately excluded: an external Agent needs this exact
 * identity, generation, and normalized declaration before it can unlock UI
 * lifecycle controls.
 */
export type CurrentProjectedAgentCapabilities = Readonly<{
    agentId: string;
    identity: PluginContributionIdentityV1;
    generation: number;
    capabilities: PluginAgentCapabilitiesV2;
}>;

function normalizeAgentId(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

/**
 * Reads an Agent declaration only from a ready, exact V2 projection. Callers
 * own the transport-phase gate; stale/loading snapshots must pass `null`.
 */
export function readCurrentProjectedAgentCapabilities(params: Readonly<{
    projection: PluginProjectionV2 | null | undefined;
    agentId: string | null | undefined;
}>): CurrentProjectedAgentCapabilities | null {
    const agentId = normalizeAgentId(params.agentId);
    const projection = params.projection ?? null;
    if (!agentId || !projection) return null;

    const agent = projection.agentsById[agentId];
    if (!agent || agent.id !== agentId || !agent.identity || !agent.capabilities) {
        return null;
    }

    return {
        agentId,
        identity: agent.identity,
        generation: projection.generation,
        capabilities: agent.capabilities,
    };
}

/**
 * Capability predicates remain beside the exact-projection reader. They use
 * Protocol-owned vocabulary and make every lifecycle consumer fail closed when
 * its current declaration is absent.
 */
export function supportsCurrentProjectedAgentSessionOpen(
    currentAgent: CurrentProjectedAgentCapabilities | null | undefined,
    operation: CurrentProjectedAgentSessionOpenOperation,
): boolean {
    return currentAgent?.capabilities.sessions?.open.includes(operation) === true;
}

export function supportsCurrentProjectedAgentConversationRollback(
    currentAgent: CurrentProjectedAgentCapabilities | null | undefined,
): boolean {
    return currentAgent?.capabilities.sessions?.conversationRollback === true;
}

export function supportsCurrentProjectedAgentUsageLimitRecovery(
    currentAgent: CurrentProjectedAgentCapabilities | null | undefined,
    activity: 'active' | 'inactive',
    operation: CurrentProjectedAgentUsageLimitRecoveryOperation,
): boolean {
    return currentAgent?.capabilities.sessions?.usageLimitRecovery?.[activity]?.includes(operation) === true;
}

export function supportsCurrentProjectedAgentSurface(
    currentAgent: CurrentProjectedAgentCapabilities | null | undefined,
    surface: CurrentProjectedAgentCapabilitySurface,
): boolean {
    return currentAgent?.capabilities.surfaces?.includes(surface) === true;
}

/**
 * The lifecycle questions UI surfaces ask about the Agent behind a Session.
 *
 * Fork, rollback, usage-limit recovery and the terminal surface used to be
 * decided inline at each call site, and each site picked its evidence by
 * testing the Agent id against the bundled list. That made every surface a
 * capability decision-maker in its own right. The vocabulary below is the one
 * question shape; {@link supportsAgentLifecycleCapability} is the one answer.
 */
export type AgentLifecycleCapability =
    | 'sessionFork.conversation'
    | 'sessionFork.fromMessage'
    | 'sessionRollback.conversation'
    | 'usageLimitRecovery.checkNow'
    | 'surface.terminal';

export type AgentLifecycleCapabilityQuery = Readonly<{
    agentId: string | null | undefined;
    capability: AgentLifecycleCapability;
    /** Owner metadata for the exact Session being asked about, when there is one. */
    metadata?: unknown;
    /** Session activity, which V2 declares separate recovery operations for. */
    sessionActive?: boolean;
    /** Exact declaration from a ready daemon V2 projection. */
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}>;

function readPublishedLocalControlSupport(metadata: unknown): boolean | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const publication = (metadata as Readonly<Record<string, unknown>>).agentRuntimeCapabilitiesV1;
    if (!publication || typeof publication !== 'object' || Array.isArray(publication)) return null;
    const localControl = (publication as Readonly<Record<string, unknown>>).localControl;
    if (localControl === null) return false;
    if (!localControl || typeof localControl !== 'object' || Array.isArray(localControl)) return null;
    const supported = (localControl as Readonly<Record<string, unknown>>).supported;
    return typeof supported === 'boolean' ? supported : null;
}

function supportsSessionCapability(
    query: AgentLifecycleCapabilityQuery,
    agentId: string,
    capability: AgentSessionCapabilityKey,
    declaredSupport: boolean,
): boolean {
    return evaluateAgentSessionCapabilitySupport({
        agentId,
        capability,
        metadata: query.metadata ?? null,
        declaredSupport: declaredSupport ? 'supported' : 'unsupported',
    }) === 'supported';
}

/**
 * The single UI answer to "can this Session's Agent do X".
 *
 * Every Agent — bundled or externally installed — is answered from the same
 * exact V2 declaration, refined by the same live Session runtime publication.
 * Provider-owned runtime descriptors remain opaque to generic UI code.
 */
export function supportsAgentLifecycleCapability(query: AgentLifecycleCapabilityQuery): boolean {
    const agentId = normalizeAgentId(query.agentId);
    if (!agentId) return false;
    const descriptor = readRuntimeDescriptorV1FromMetadata(query.metadata);
    if (descriptor && descriptor.agentId !== agentId) return false;

    const currentAgent = query.currentAgentCapabilities?.agentId === agentId
        ? query.currentAgentCapabilities
        : null;

    switch (query.capability) {
        case 'sessionFork.conversation':
            return supportsSessionCapability(
                query,
                agentId,
                'sessionFork.conversation',
                supportsCurrentProjectedAgentSessionOpen(currentAgent, 'fork'),
            );
        case 'sessionFork.fromMessage':
            // V2's static `open: ['fork']` declares conversation-level fork
            // admission, not an exact transcript cutoff. Only the live runtime
            // publication can advertise the finer from-message operation.
            return supportsSessionCapability(
                query,
                agentId,
                'sessionFork.fromMessage',
                false,
            );
        case 'sessionRollback.conversation':
            return supportsSessionCapability(
                query,
                agentId,
                'sessionRollback.conversation',
                supportsCurrentProjectedAgentConversationRollback(currentAgent),
            );
        case 'usageLimitRecovery.checkNow':
            return supportsSessionCapability(
                query,
                agentId,
                'usageLimitRecovery.checkNow',
                supportsCurrentProjectedAgentUsageLimitRecovery(
                    currentAgent,
                    query.sessionActive === true ? 'active' : 'inactive',
                    'checkNow',
                ),
            );
        case 'surface.terminal': {
            const published = readPublishedLocalControlSupport(query.metadata);
            return published ?? supportsCurrentProjectedAgentSurface(currentAgent, 'terminal');
        }
    }
}
