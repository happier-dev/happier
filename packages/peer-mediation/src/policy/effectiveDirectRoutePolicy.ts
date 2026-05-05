import type { PeerFlowKind, PeerRouteKind } from '../route/types.js';

export type PeerDirectPreference = 'inherit' | 'enabled' | 'disabled';

export type PeerDirectRoutePolicyDenyReason =
    | 'blocked_by_server_policy'
    | 'blocked_by_daemon_policy'
    | 'disabled_by_account_preference'
    | 'disabled_by_product_default'
    | 'topology_unavailable'
    | 'grant_missing'
    | 'grant_expired'
    | 'grant_revoked'
    | 'grant_scope_mismatch';

export type PeerDirectRoutePolicyDecision =
    | Readonly<{
        allowed: true;
        source: 'daemon_hard_allow' | 'account_machine' | 'account_default' | 'product_default';
        reasonCode: 'direct_route_allowed';
    }>
    | Readonly<{
        allowed: false;
        source: 'server_gate' | 'daemon_hard_deny' | 'account_machine' | 'account_default' | 'product_default' | 'topology' | 'grant';
        reasonCode: PeerDirectRoutePolicyDenyReason;
    }>;

export type PeerDirectRouteGrantStatus = 'missing' | 'valid' | 'expired' | 'revoked' | 'scope_mismatch';

export type ResolveEffectivePeerDirectRoutePolicyInput = Readonly<{
    flowKind: PeerFlowKind;
    routeKind: Exclude<PeerRouteKind, 'server_relay'>;
    serverGateEnabled: boolean;
    daemonPolicy: boolean | null;
    accountMachinePreference: PeerDirectPreference;
    accountDefaultPreference: PeerDirectPreference;
    productDefaultPreference: Exclude<PeerDirectPreference, 'inherit'>;
    topologyAvailable: boolean;
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
        case 'revoked':
            return 'grant_revoked';
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

    if (!input.topologyAvailable) {
        return { allowed: false, source: 'topology', reasonCode: 'topology_unavailable' };
    }

    const grantReason = grantDenyReason(input.grant.status);
    if (grantReason) {
        return { allowed: false, source: 'grant', reasonCode: grantReason };
    }

    return preference;
}
