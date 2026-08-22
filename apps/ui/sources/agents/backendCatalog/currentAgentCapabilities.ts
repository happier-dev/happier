import type {
    PluginAgentCapabilitiesV2,
    PluginContributionIdentityV1,
    PluginProjectionV2,
} from '@happier-dev/protocol';
import {
    readAgentSessionCapabilityFromSurface,
    resolveAgentRuntimeControlSurfaceForSession,
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
    accountSettings?: Record<string, unknown> | null;
    /** Session activity, which V2 declares separate recovery operations for. */
    sessionActive?: boolean;
    /** Exact declaration from a ready daemon V2 projection. */
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}>;

/**
 * One Agent's lifecycle facts, normalized away from the shape they were
 * declared in.
 *
 * Two evidence channels reach this shape and nothing else decides anything: a
 * bundled Agent's build-time contribution, refined by the runtime kind this
 * exact Session runs on, and an installed Agent's daemon V2 declaration. The
 * normalized shape keeps conversation fork and from-message fork apart because
 * a bundled contribution distinguishes them and V2's single `open: ['fork']`
 * entry does not; folding them together here would re-advertise a route Codex
 * refuses.
 */
type AgentLifecycleCapabilityDeclaration = Readonly<{
    sessionForkConversation: boolean;
    sessionForkFromMessage: boolean;
    sessionRollbackConversation: boolean;
    usageLimitRecoveryCheckNowActive: boolean;
    usageLimitRecoveryCheckNowInactive: boolean;
    surfaceTerminal: boolean;
}>;

/**
 * Normalizes an installed Agent's exact V2 declaration. V2 cannot say "forks
 * the conversation but not from a message", so both fork questions read its one
 * `fork` open-route entry.
 */
function projectDeclaredLifecycleCapabilities(
    currentAgent: CurrentProjectedAgentCapabilities,
): AgentLifecycleCapabilityDeclaration {
    const fork = supportsCurrentProjectedAgentSessionOpen(currentAgent, 'fork');
    return {
        sessionForkConversation: fork,
        sessionForkFromMessage: fork,
        sessionRollbackConversation: supportsCurrentProjectedAgentConversationRollback(currentAgent),
        usageLimitRecoveryCheckNowActive: supportsCurrentProjectedAgentUsageLimitRecovery(currentAgent, 'active', 'checkNow'),
        usageLimitRecoveryCheckNowInactive: supportsCurrentProjectedAgentUsageLimitRecovery(currentAgent, 'inactive', 'checkNow'),
        surfaceTerminal: supportsCurrentProjectedAgentSurface(currentAgent, 'terminal'),
    };
}

/**
 * Normalizes a bundled Agent's contribution for this exact Session.
 *
 * `null` means "no bundled contribution under this id" — never "unsupported"
 * and never "fall back to a default Agent". The nullable bundled read is also
 * the discriminator: an installed Agent has no bundled control surface, so no
 * caller has to test an id against the bundled list to pick its evidence.
 *
 * The bundled facts are read through the one Session-refined control surface,
 * so the terminal surface and the session capabilities can no longer disagree
 * about which runtime kind this Session runs on.
 */
function projectBundledLifecycleCapabilities(
    query: AgentLifecycleCapabilityQuery,
    agentId: string,
): AgentLifecycleCapabilityDeclaration | null {
    const surface = resolveAgentRuntimeControlSurfaceForSession({
        agentId,
        metadata: query.metadata ?? null,
        accountSettings: query.accountSettings ?? null,
    });
    if (!surface) return null;

    const supports = (capability: AgentSessionCapabilityKey): boolean => (
        readAgentSessionCapabilityFromSurface(surface.sessionCapabilities, capability) === 'supported'
    );
    const checkNow = supports('usageLimitRecovery.checkNow');
    return {
        sessionForkConversation: supports('sessionFork.conversation'),
        sessionForkFromMessage: supports('sessionFork.fromMessage'),
        sessionRollbackConversation: supports('sessionRollback.conversation'),
        // A bundled contribution declares one recovery fact rather than V2's
        // per-activity operation lists, so both activities read it.
        usageLimitRecoveryCheckNowActive: checkNow,
        usageLimitRecoveryCheckNowInactive: checkNow,
        surfaceTerminal: surface.localControl?.supported === true,
    };
}

/**
 * Picks the evidence for one Agent. This is transport/format selection, not a
 * second capability policy: whichever channel answers, the verdict is read by
 * the one switch in {@link supportsAgentLifecycleCapability}.
 *
 * A bundled contribution wins when there is one, because it is the strictly
 * richer evidence for that Agent — refined by this Session's runtime kind (a
 * Codex session on the ACP runtime genuinely cannot fork) and readable while
 * the machine's daemon projection is loading, stale or unreachable. An
 * installed Agent is read from its exact V2 declaration and fails closed:
 * absent, stale or mismatched projection data answers `null` rather than
 * borrowing a bundled Agent's facts.
 */
function resolveAgentLifecycleCapabilityDeclaration(
    query: AgentLifecycleCapabilityQuery,
    agentId: string,
): AgentLifecycleCapabilityDeclaration | null {
    const bundled = projectBundledLifecycleCapabilities(query, agentId);
    if (bundled) return bundled;

    const currentAgent = query.currentAgentCapabilities ?? null;
    return currentAgent?.agentId === agentId
        ? projectDeclaredLifecycleCapabilities(currentAgent)
        : null;
}

/**
 * The single UI answer to "can this Session's Agent do X".
 *
 * Every Agent — bundled or externally installed — is answered by this one
 * switch over one normalized declaration. Nothing downstream re-decides a
 * capability from an Agent id, a runtime kind, or a raw declaration.
 */
export function supportsAgentLifecycleCapability(query: AgentLifecycleCapabilityQuery): boolean {
    const agentId = normalizeAgentId(query.agentId);
    if (!agentId) return false;

    const declaration = resolveAgentLifecycleCapabilityDeclaration(query, agentId);
    if (!declaration) return false;

    switch (query.capability) {
        case 'sessionFork.conversation':
            return declaration.sessionForkConversation;
        case 'sessionFork.fromMessage':
            return declaration.sessionForkFromMessage;
        case 'sessionRollback.conversation':
            return declaration.sessionRollbackConversation;
        case 'usageLimitRecovery.checkNow':
            return query.sessionActive === true
                ? declaration.usageLimitRecoveryCheckNowActive
                : declaration.usageLimitRecoveryCheckNowInactive;
        case 'surface.terminal':
            return declaration.surfaceTerminal;
    }
}
