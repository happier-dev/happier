import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    type ConnectedServiceId,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import {
    isBuiltInLegacyConnectedAccountPeerOperationSupported,
} from '@/api/client/qualifiedConnectedAccountApi';

function matchesService(
    left: QualifiedConnectedAccountRef['service'],
    right: QualifiedConnectedAccountRef['service'],
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * Sole closed-enum launch-ingress resolver. Eligibility is generated from the first-party
 * manifests and immutable peer evidence; SCM-only identities are deliberately excluded.
 */
export function resolveFirstPartyLegacyAgentConnectedAccountServiceId(
    service: QualifiedConnectedAccountRef['service'],
): ConnectedServiceId | null {
    for (const [legacyServiceId, compatibility] of Object.entries(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    )) {
        if (
            isBuiltInLegacyConnectedAccountPeerOperationSupported({
                serviceId: legacyServiceId,
                peerClass: 'exact_v0_2_1',
                operation: 'one_shot_materialization',
            })
            && matchesService(compatibility.service, service)
        ) {
            return legacyServiceId as ConnectedServiceId;
        }
    }
    return null;
}

export function resolveFirstPartyLegacyRequestAuthServiceId(
    service: QualifiedConnectedAccountRef['service'],
): ConnectedServiceId | null {
    for (const [legacyServiceId, compatibility] of Object.entries(
        BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    )) {
        if (
            isBuiltInLegacyConnectedAccountPeerOperationSupported({
                serviceId: legacyServiceId,
                peerClass: 'revisioned_v2_v3',
                operation: 'request_auth',
            })
            && matchesService(compatibility.service, service)
        ) {
            return legacyServiceId as ConnectedServiceId;
        }
    }
    return null;
}
