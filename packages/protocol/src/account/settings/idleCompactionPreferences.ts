import type { AgentSessionCompactionIdleCapability } from '../../plugins/contributions/agentSessionCapabilities.js';

/** Node's setTimeout maximum; larger values overflow to an immediate timeout. */
export const MAX_IDLE_COMPACTION_CACHE_WINDOW_MS = 2_147_483_647;

export type IdleCompactionPreference = Readonly<{
    enabled: boolean;
    minContextTokens?: number;
    cacheWindowOverrideMs?: number;
}>;

/** The Account preference owner decides defaults for every host and UI consumer. */
export function resolveIdleCompactionPreference(input: Readonly<{
    enabled?: boolean;
    minContextTokens?: number;
    cacheWindowOverrideMs?: number;
    idle: AgentSessionCompactionIdleCapability;
}>): IdleCompactionPreference {
    const minContextTokens = input.minContextTokens ?? input.idle.defaultMinContextTokens;
    return {
        enabled: input.enabled ?? input.idle.defaultEnabled,
        ...(minContextTokens === undefined ? {} : { minContextTokens }),
        ...(input.cacheWindowOverrideMs === undefined ? {} : { cacheWindowOverrideMs: input.cacheWindowOverrideMs }),
    };
}
