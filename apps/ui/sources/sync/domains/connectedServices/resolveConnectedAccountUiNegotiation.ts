import type {
    ServerFeaturesRuntimeSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';

/**
 * UI-side interpretation of the atomic qualified-accounts capability.
 *
 * An advertised but unknown protocol version, a transient feature request
 * failure, and an in-flight request are all deliberately indeterminate: none
 * may silently select a released legacy operation. Only an absent capability
 * on a successful response (or a peer without the feature endpoint) uses the
 * generated built-in V2/V3 adapter.
 */
export type ConnectedAccountUiNegotiation =
    | 'advertised-v4'
    | 'legacy'
    | 'indeterminate';

export function resolveConnectedAccountUiNegotiation(
    snapshot: ServerFeaturesRuntimeSnapshot,
): ConnectedAccountUiNegotiation {
    if (snapshot.status === 'loading') return 'indeterminate';
    if (snapshot.status === 'ready') {
        const capability = snapshot.features.capabilities.connectedServices
            .qualifiedAccounts;
        if (!capability) return 'legacy';
        return capability.protocolVersion === 4
            ? 'advertised-v4'
            : 'indeterminate';
    }
    return snapshot.status === 'unsupported'
        && snapshot.reason === 'endpoint_missing'
        ? 'legacy'
        : 'indeterminate';
}
