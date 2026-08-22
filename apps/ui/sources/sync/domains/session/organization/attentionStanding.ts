/**
 * Attention standing is the user's explicit instruction to keep a session in
 * the Needs attention band after it has been read. Standing is resolved from
 * an account default plus per-session overrides, and this module is the single
 * owner of that rule: an explicit override always wins, so a session the user
 * removed from Needs attention stays out even while the default keeps every
 * other session standing (and vice versa). Overrides are stored as a real
 * boolean because "explicitly not standing" is not expressible by row absence
 * once the default is true.
 */
import { LruMap } from '@/utils/cache/lruMap';

export type SessionAttentionStandingPolicy = Readonly<{
    defaultStanding: boolean;
    overridesBySessionKey: Readonly<Record<string, boolean>>;
}>;

/**
 * Bounded because the policy is per active server per surface, and a content
 * key only repeats while the standings themselves repeat.
 */
const SESSION_ATTENTION_STANDING_POLICY_CACHE = new LruMap<string, SessionAttentionStandingPolicy>({
    maxEntries: 32,
});

/**
 * Resolves the policy BY CONTENT, because consumers compare it by identity.
 * The organization view state re-derives `attentionStandingOverridesBySessionKey`
 * on every projection build, so a pin, tag or folder edit would otherwise hand
 * every row-model gate a brand-new policy carrying unchanged standings and
 * rebuild the whole list for traffic that changed no standing at all. Pinning
 * defends the same seam the same way in
 * `resolveSessionListOrderingPersistenceState`.
 */
export function resolveSessionAttentionStandingPolicy(input: Readonly<{
    defaultStanding: boolean;
    overridesBySessionKey: Readonly<Record<string, boolean>>;
}>): SessionAttentionStandingPolicy {
    const overrideKeys = Object.keys(input.overridesBySessionKey).sort();
    const cacheKey = JSON.stringify([
        input.defaultStanding,
        overrideKeys.map((key) => [key, input.overridesBySessionKey[key]]),
    ]);
    const cached = SESSION_ATTENTION_STANDING_POLICY_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const policy: SessionAttentionStandingPolicy = {
        defaultStanding: input.defaultStanding,
        overridesBySessionKey: input.overridesBySessionKey,
    };
    SESSION_ATTENTION_STANDING_POLICY_CACHE.set(cacheKey, policy);
    return policy;
}

/**
 * Where a session's standing comes from. Consumers that must treat the user's
 * explicit per-session instruction differently from a blanket account default
 * — hiding inactive sessions, for instance — read the source instead of
 * re-deriving the precedence rule.
 */
export type SessionAttentionStandingSource = 'override' | 'default' | 'none';

export function resolveSessionAttentionStandingSource(
    policy: SessionAttentionStandingPolicy,
    sessionKey: string,
): SessionAttentionStandingSource {
    const override: boolean | undefined = policy.overridesBySessionKey[sessionKey];
    if (override !== undefined) return override ? 'override' : 'none';
    return policy.defaultStanding ? 'default' : 'none';
}

export function resolveSessionAttentionStanding(
    policy: SessionAttentionStandingPolicy,
    sessionKey: string,
): boolean {
    return resolveSessionAttentionStandingSource(policy, sessionKey) !== 'none';
}
