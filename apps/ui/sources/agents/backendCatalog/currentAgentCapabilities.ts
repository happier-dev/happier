import type {
    PluginAgentCapabilitiesV2} from '@happier-dev/protocol/plugins/contributions/v2';
import type {
    PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type {
    PluginProjectedAgentV2,
    PluginProjectionV2,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { parseExternalSessionsSourceForDeclaration } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import type { ExternalSessionsSource } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { AgentSessionCompactionAvailabilityV1 } from '@happier-dev/protocol/plugins/agents';
import {
    evaluateAgentSessionCapabilitySupport,
    evaluateAgentSessionCompactionAvailability,
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

export function resolveProjectedExternalSessionsAgent(params: Readonly<{
    providerId: string;
    projection: PluginProjectionV2 | null | undefined;
}>): Readonly<{
    agent: PluginProjectedAgentV2;
    externalSessions: NonNullable<PluginProjectedAgentV2['externalSessions']>;
}> | null {
    const projection = params.projection;
    const agent = projection?.agentsById[params.providerId];
    const externalSessions = agent?.externalSessions;
    if (!projection || !agent || agent.id !== params.providerId
        || !externalSessions || externalSessions.generation !== projection.generation) return null;

    const installedPackage = projection.installedPackagesById[externalSessions.agent.pluginId];
    if (installedPackage?.id !== externalSessions.agent.pluginId || installedPackage.enabled !== true) return null;
    return { agent, externalSessions };
}

/** Import and background observation both need to page the exact source and read its append frontier. */
export function supportsProjectedExternalSessionTranscript(
    externalSessions: PluginProjectedAgentV2['externalSessions'] | undefined,
    source: ExternalSessionsSource,
): boolean {
    if (externalSessions?.operations.pageTranscript !== true
        || externalSessions.operations.readAfterTranscript !== true) return false;
    const declaration = externalSessions.sources.find(candidate => candidate.sourceKind === source.kind);
    return declaration !== undefined && declaration.resumeOnly !== true
        && parseExternalSessionsSourceForDeclaration(declaration, source) !== null;
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

export function supportsCurrentProjectedAgentSurface(
    currentAgent: CurrentProjectedAgentCapabilities | null | undefined,
    surface: CurrentProjectedAgentCapabilitySurface,
): boolean {
    return currentAgent?.capabilities.surfaces?.includes(surface) === true;
}

/**
 * The lifecycle questions UI surfaces ask about the Agent behind a Session.
 *
 * Fork, rollback and the terminal surface used to be
 * decided inline at each call site, and each site picked its evidence by
 * testing the Agent id against the bundled list. That made every surface a
 * capability decision-maker in its own right. The vocabulary below is the one
 * question shape; {@link supportsAgentLifecycleCapability} is the one answer.
 */
export type AgentLifecycleCapability =
    | 'session.compact'
    | 'sessionFork.conversation'
    | 'sessionFork.fromMessage'
    | 'sessionRollback.conversation'
    | 'usageReporting'
    | 'surface.terminal';

export type AgentLifecycleCapabilityQuery = Readonly<{
    agentId: string | null | undefined;
    capability: AgentLifecycleCapability;
    /** Owner metadata for the exact Session being asked about, when there is one. */
    metadata?: unknown;
    /** Exact declaration from a ready daemon V2 projection. */
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}>;

function readLifecycleAgentId(query: Pick<AgentLifecycleCapabilityQuery, 'agentId' | 'metadata'>): string | null {
    const agentId = normalizeAgentId(query.agentId);
    const descriptor = readRuntimeDescriptorV1FromMetadata(query.metadata);
    return descriptor && descriptor.agentId !== agentId ? null : agentId;
}

const NO_USAGE_LIMIT_RECOVERY_OPERATIONS: readonly CurrentProjectedAgentUsageLimitRecoveryOperation[] = Object.freeze([]);

/** The exact declaration is authoritative for executable recovery operations. */
export function readAgentSessionUsageLimitRecoveryOperations(
    query: Omit<AgentLifecycleCapabilityQuery, 'capability'> & Readonly<{ sessionActive: boolean }>,
): readonly CurrentProjectedAgentUsageLimitRecoveryOperation[] {
    const agentId = readLifecycleAgentId(query);
    const current = query.currentAgentCapabilities;
    if (!agentId || current?.agentId !== agentId) return NO_USAGE_LIMIT_RECOVERY_OPERATIONS;
    const activity = query.sessionActive ? 'active' : 'inactive';
    return current.capabilities.sessions?.usageLimitRecovery?.[activity] ?? NO_USAGE_LIMIT_RECOVERY_OPERATIONS;
}

/** The shared compaction owner resolves both declaration and opened-runtime evidence. */
export function readAgentSessionCompactionAvailability(
    query: Omit<AgentLifecycleCapabilityQuery, 'capability'>,
): AgentSessionCompactionAvailabilityV1 {
    const agentId = readLifecycleAgentId(query);
    const current = query.currentAgentCapabilities?.agentId === agentId
        ? query.currentAgentCapabilities : null;
    return evaluateAgentSessionCompactionAvailability({
        agentId: agentId ?? '',
        metadata: agentId ? query.metadata : null,
        ...(current ? { declaredCapability: current.capabilities.sessions?.compaction ?? null } : {}),
    });
}

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
    const agentId = readLifecycleAgentId(query);
    if (!agentId) return false;

    const currentAgent = query.currentAgentCapabilities?.agentId === agentId
        ? query.currentAgentCapabilities
        : null;

    switch (query.capability) {
        case 'session.compact':
            return readAgentSessionCompactionAvailability(query).status === 'supported';
        case 'usageReporting':
            return currentAgent?.capabilities.sessions?.usageReporting === true
                && supportsSessionCapability(query, agentId, 'usageReporting', true);
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
        case 'surface.terminal': {
            const published = readPublishedLocalControlSupport(query.metadata);
            return published ?? supportsCurrentProjectedAgentSurface(currentAgent, 'terminal');
        }
    }
}
