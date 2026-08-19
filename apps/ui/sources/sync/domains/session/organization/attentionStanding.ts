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
export type SessionAttentionStandingPolicy = Readonly<{
    defaultStanding: boolean;
    overridesBySessionKey: Readonly<Record<string, boolean>>;
}>;

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
