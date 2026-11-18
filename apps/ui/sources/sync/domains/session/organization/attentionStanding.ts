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
import { resolveAttentionReminderV1, type AttentionReminderV1 } from '@happier-dev/protocol/activity/attentionReminderV1';

export type SessionAttentionStandingPolicy = Readonly<{
    defaultStanding: boolean;
    overridesBySessionKey: Readonly<Record<string, boolean | SessionAttentionIntentRecord>>;
}>;
export type SessionAttentionIntentRecord = Readonly<{ standing: boolean; remindAt?: number; updatedAt: number }>;
export type SessionAttentionIntent = 'suppress' | 'keep' | 'scheduled' | 'due';
export type SessionReminderPresentation = AttentionReminderV1;
export function resolveSessionAttentionIntent(record: SessionAttentionIntentRecord, nowMs: number): SessionAttentionIntent {
    return resolveAttentionReminderV1(record.remindAt, nowMs)?.state ?? (record.standing ? 'keep' : 'suppress');
}

export function resolveSessionReminderPresentation(
    record: boolean | SessionAttentionIntentRecord | undefined,
    nowMs: number,
): SessionReminderPresentation | null {
    if (typeof record !== 'object' || typeof record.remindAt !== 'number') return null;
    return resolveAttentionReminderV1(record.remindAt, nowMs);
}

export function resolveNextSessionAttentionReminderWakeAtMs(
    policy: SessionAttentionStandingPolicy,
    nowMs: number,
): number | null {
    let nextAt: number | null = null;
    for (const record of Object.values(policy.overridesBySessionKey)) {
        if (typeof record !== 'object' || typeof record.remindAt !== 'number' || record.remindAt <= nowMs) continue;
        nextAt = nextAt === null ? record.remindAt : Math.min(nextAt, record.remindAt);
    }
    return nextAt;
}

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
    overridesBySessionKey: Readonly<Record<string, boolean | SessionAttentionIntentRecord>>;
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
    nowMs: number = Date.now(),
): SessionAttentionStandingSource {
    const override = policy.overridesBySessionKey[sessionKey];
    if (override !== undefined) {
        if (typeof override === 'boolean') return override ? 'override' : 'none';
        const intent = resolveSessionAttentionIntent(override, nowMs);
        return intent === 'keep' || intent === 'due' ? 'override' : 'none';
    }
    return policy.defaultStanding ? 'default' : 'none';
}

export function resolveSessionAttentionStanding(
    policy: SessionAttentionStandingPolicy,
    sessionKey: string,
    nowMs: number = Date.now(),
): boolean {
    return resolveSessionAttentionStandingSource(policy, sessionKey, nowMs) !== 'none';
}
