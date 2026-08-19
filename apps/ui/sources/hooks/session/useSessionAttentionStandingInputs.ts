import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import {
    normalizeSessionListAttentionPromotionMode,
    type SessionListAttentionPromotionMode,
} from '@/sync/domains/session/listing/attentionPromotion/sessionListAttentionPromotion';
import type { SessionAttentionStandingPolicy } from '@/sync/domains/session/organization/attentionStanding';

export type SessionAttentionStandingInputs = Readonly<{
    /** Where the attention band puts a promoted session, or `off` when there is no band at all. */
    promotionMode: SessionListAttentionPromotionMode;
    /**
     * Whether the per-session Keep in Needs attention action means anything yet. With the band off
     * there is nothing for a kept session to be held in, so the action stays hidden.
     */
    actionEnabled: boolean;
    policy: SessionAttentionStandingPolicy;
}>;

/**
 * The single place the account default and the per-session overrides are joined into the policy
 * `resolveSessionAttentionStanding` reads. Surfaces pass the overrides they already hold from the
 * session organization view state so this adds no extra projection subscription.
 */
export function useSessionAttentionStandingInputs(
    overridesBySessionKey: Readonly<Record<string, boolean>>,
): SessionAttentionStandingInputs {
    const promotionMode = normalizeSessionListAttentionPromotionMode(useSetting('sessionListAttentionPromotionModeV1'));
    const defaultStanding = useSetting('sessionListAttentionStandingDefaultV1') === true;
    const policy = React.useMemo<SessionAttentionStandingPolicy>(() => ({
        defaultStanding,
        overridesBySessionKey,
    }), [defaultStanding, overridesBySessionKey]);

    return React.useMemo<SessionAttentionStandingInputs>(() => ({
        promotionMode,
        actionEnabled: promotionMode !== 'off',
        policy,
    }), [policy, promotionMode]);
}
