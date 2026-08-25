import type { PeerDirectRoutePolicyDenyReason } from '../../policy/effectiveDirectRoutePolicy.js';

export type MachineLiveStreamDisabledReasonCode =
    | 'server_features_unavailable'
    | 'stream_unsupported'
    | 'local_capture_unavailable'
    | 'remote_display_unavailable'
    | 'account_preference_disabled'
    | 'daemon_policy_disabled'
    | 'server_direct_disabled'
    | 'server_relay_disabled'
    | 'relay_cap_missing'
    | 'relay_cap_exceeded'
    | 'grant_rejected'
    | 'endpoint_unavailable'
    | 'topology_unavailable'
    | 'cap_exceeded';

export function mapPeerDirectPolicyDenyReasonToLiveStreamDisabledReason(
    reason: PeerDirectRoutePolicyDenyReason,
): MachineLiveStreamDisabledReasonCode {
    switch (reason) {
        case 'blocked_by_server_policy':
            return 'server_direct_disabled';
        case 'blocked_by_daemon_policy':
            return 'daemon_policy_disabled';
        case 'disabled_by_account_preference':
        case 'disabled_by_product_default':
            return 'account_preference_disabled';
        // No `topology_unavailable` case: the policy no longer models topology. That code is still
        // produced for callers, by `route.ts#routeUnavailableReason`, which is the sole owner of the
        // topology denial and runs before the policy is consulted.
        case 'grant_missing':
        case 'grant_expired':
        case 'grant_scope_mismatch':
            return 'grant_rejected';
    }
}
