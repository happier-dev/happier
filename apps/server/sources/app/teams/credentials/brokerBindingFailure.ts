import type { SessionTeamCredentialBindingRejectionV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import type { ProviderBrokerAdmissionFailureCodeV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

/**
 * The one translation of the Session-binding owner's rejection into this
 * route's denial code, so the broker never re-derives a decision in order to
 * name it. Anything the caller could repair by re-opening is `resource_changed`
 * or a broker/update code; everything else is a refusal of this operation.
 */
export function brokerFailureForBindingRejection(
    reason: SessionTeamCredentialBindingRejectionV1 | 'binding_missing',
): ProviderBrokerAdmissionFailureCodeV1 {
    switch (reason) {
        case 'connected_service_credential_reconnect_required':
            return reason;
        case 'resource_changed':
            return 'resource_changed';
        case 'broker_unavailable':
            return 'broker_unavailable';
        case 'update_required':
            return 'update_required';
        case 'resource_missing':
        case 'resource_corrupt':
        case 'source_owner_required':
        case 'source_replaced_or_missing':
            return 'resource_unavailable';
        default:
            return 'resource_forbidden';
    }
}
