import type { PeerFlowKind, PeerRouteKind } from '../route/types.js';

export type PeerDirectPreference = 'inherit' | 'enabled' | 'disabled';

/**
 * Route **admission preference**, not route **viability**. Topology is deliberately absent: see
 * `ResolveEffectivePeerDirectRoutePolicyInput`.
 */
export type PeerDirectRoutePolicyDenyReason =
    | 'blocked_by_server_policy'
    | 'blocked_by_daemon_policy'
    | 'disabled_by_account_preference'
    | 'disabled_by_product_default'
    | 'grant_missing'
    | 'grant_expired'
    | 'grant_scope_mismatch';

export type PeerDirectRoutePolicyDecision =
    | Readonly<{
        allowed: true;
        source: 'daemon_hard_allow' | 'account_machine' | 'account_default' | 'product_default';
        reasonCode: 'direct_route_allowed';
    }>
    | Readonly<{
        allowed: false;
        source: 'server_gate' | 'daemon_hard_deny' | 'account_machine' | 'account_default' | 'product_default' | 'grant';
        reasonCode: PeerDirectRoutePolicyDenyReason;
    }>;

/**
 * Grant revocation is withdrawn — direct route grants are TTL-only (S-4, 2026-08-23). `'revoked'`
 * was removed with its deny reason: no server registry, no wire route, and the only production
 * site that supplies a status (`rpc/directRoutePreflight.ts`) hard-codes `'valid'`, so the value
 * could never arrive. Containment is single-use consumption + TTL + binding + nonce proof.
 */
export type PeerDirectRouteGrantStatus = 'missing' | 'valid' | 'expired' | 'scope_mismatch';

/**
 * Topology is **not** an input. Route viability is owned upstream — by
 * `resolvePeerLoopbackRouteAvailability` behind `createPeerRouteViabilityCache`, consulted at
 * `rpc/productionRoute.ts` and at `flows/stream/route.ts` — and every caller has already acted on
 * that record before reaching this resolver, so a `topologyAvailable: false` producer cannot exist
 * (CONFLICT-F6, 2026-08-23). The removed `topology_unavailable` deny reason was a second door onto
 * a decision already made; it survives as a caller-facing code in
 * `MachineLiveStreamDisabledReasonCode` and in the `PeerMachineRpcDirectFallbackReasonCodeV1` wire
 * enum, both of which keep live producers. Grant status, by contrast, is inspected nowhere else on
 * either path, so this resolver remains its sole admission-side mapper.
 */
export type ResolveEffectivePeerDirectRoutePolicyInput = Readonly<{
    flowKind: PeerFlowKind;
    routeKind: Exclude<PeerRouteKind, 'server_relay'>;
    serverGateEnabled: boolean;
    daemonPolicy: boolean | null;
    accountMachinePreference: PeerDirectPreference;
    accountDefaultPreference: PeerDirectPreference;
    productDefaultPreference: Exclude<PeerDirectPreference, 'inherit'>;
    grant: Readonly<{ status: PeerDirectRouteGrantStatus }>;
}>;

function preferenceDecision(
    source: 'account_machine' | 'account_default' | 'product_default',
    preference: Exclude<PeerDirectPreference, 'inherit'>,
): PeerDirectRoutePolicyDecision {
    if (preference === 'enabled') {
        return { allowed: true, source, reasonCode: 'direct_route_allowed' };
    }
    return {
        allowed: false,
        source,
        reasonCode: source === 'product_default'
            ? 'disabled_by_product_default'
            : 'disabled_by_account_preference',
    };
}

function grantDenyReason(status: PeerDirectRouteGrantStatus): PeerDirectRoutePolicyDenyReason | null {
    switch (status) {
        case 'missing':
            return 'grant_missing';
        case 'expired':
            return 'grant_expired';
        case 'scope_mismatch':
            return 'grant_scope_mismatch';
        case 'valid':
            return null;
    }
}

export function resolveEffectivePeerDirectRoutePolicy(
    input: ResolveEffectivePeerDirectRoutePolicyInput,
): PeerDirectRoutePolicyDecision {
    void input.flowKind;
    void input.routeKind;

    if (!input.serverGateEnabled) {
        return { allowed: false, source: 'server_gate', reasonCode: 'blocked_by_server_policy' };
    }

    if (input.daemonPolicy === false) {
        return { allowed: false, source: 'daemon_hard_deny', reasonCode: 'blocked_by_daemon_policy' };
    }

    const preference = input.daemonPolicy === true
        ? ({ allowed: true, source: 'daemon_hard_allow', reasonCode: 'direct_route_allowed' } as const)
        : input.accountMachinePreference !== 'inherit'
            ? preferenceDecision('account_machine', input.accountMachinePreference)
            : input.accountDefaultPreference !== 'inherit'
                ? preferenceDecision('account_default', input.accountDefaultPreference)
                : preferenceDecision('product_default', input.productDefaultPreference);

    if (!preference?.allowed) return preference;

    const grantReason = grantDenyReason(input.grant.status);
    if (grantReason) {
        return { allowed: false, source: 'grant', reasonCode: grantReason };
    }

    return preference;
}
