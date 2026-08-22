import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import {
    normalizeSessionListAttentionPlacementMode,
    type SessionListAttentionPlacementMode,
} from '@/sync/domains/session/listing/sessionListAttentionPlacementTypes';
import {
    resolveSessionAttentionStandingPolicy,
    type SessionAttentionStandingPolicy,
} from '@/sync/domains/session/organization/attentionStanding';

export type SessionAttentionStandingInputs = Readonly<{
    /** Where the attention band puts a placed session, or `off` when there is no band at all. */
    placementMode: SessionListAttentionPlacementMode;
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
    const placementMode = normalizeSessionListAttentionPlacementMode(useSetting('sessionListAttentionPromotionModeV1'));
    const defaultStanding = useSetting('sessionListAttentionStandingDefaultV1') === true;
    // Resolved by content, not rebuilt per render: the overrides record arrives fresh from every
    // organization projection build, and consumers compare the policy by identity.
    const policy = React.useMemo<SessionAttentionStandingPolicy>(
        () => resolveSessionAttentionStandingPolicy({ defaultStanding, overridesBySessionKey }),
        [defaultStanding, overridesBySessionKey],
    );

    return React.useMemo<SessionAttentionStandingInputs>(() => ({
        placementMode,
        actionEnabled: placementMode !== 'off',
        policy,
    }), [placementMode, policy]);
}
