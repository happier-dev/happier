import {
    CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
    ConnectedPresentationRowMutationV1Schema,
} from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { CONNECTED_SUBSCRIPTION_PRICE_SET_ACTION_ID_V1 } from '@happier-dev/protocol/connect/configurationActionIdsV1';

/** The admitted finite price writer signs its merged presentation CAS, never Settings maintenance. */
export function isExternalActionConnectedSubscriptionPriceHttpPurpose(
    binding: Readonly<{ actionId: string }>, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
): boolean {
    if (binding.actionId !== CONNECTED_SUBSCRIPTION_PRICE_SET_ACTION_ID_V1 || effectActionId !== binding.actionId) return false;
    if (proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && sameStrictJsonValue(proof.routeInput ?? {}, {})) {
        return proof.path === '/v1/account/profile' || proof.path === '/v1/account/encryption/currentness'
            || proof.path === '/v2/account/settings' || proof.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1
            || proof.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1;
    }
    return proof.method.toUpperCase() === 'POST' && proof.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1
        && ConnectedPresentationRowMutationV1Schema.safeParse(proof.body).success
        && sameStrictJsonValue(proof.routeInput, proof.body);
}
