import { isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';

/**
 * The Agent identity every declaration-driven New Session reader is keyed by.
 *
 * `staticAgentId` is the closed bundled set and answers `null` for every
 * installed Agent. A reader gated on it renders an installed Agent's declared
 * controls and then drops their values before the spawn envelope is built, so
 * the composer and `session.spawn_new` disagree about which declaration they
 * are honoring. The operational carrier — the Agent that will actually run the
 * Session — is what the descriptor owner is keyed by, so option normalization,
 * chip rendering and spawn all read one declaration through this one answer.
 */
export function resolveNewSessionBehaviorAgentId(params: Readonly<{
    runtimeCarrierAgentId?: string | null;
    staticAgentId?: AgentId | null;
    agentType?: string | null;
}>): string | null {
    const runtimeCarrierAgentId = typeof params.runtimeCarrierAgentId === 'string'
        ? params.runtimeCarrierAgentId.trim()
        : '';
    if (runtimeCarrierAgentId.length > 0) return runtimeCarrierAgentId;
    if (isBundledAgentId(params.staticAgentId)) return params.staticAgentId;
    return isBundledAgentId(params.agentType) ? params.agentType : null;
}
