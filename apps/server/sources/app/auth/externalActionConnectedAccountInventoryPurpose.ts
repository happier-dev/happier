import { SESSION_SPAWN_CONNECTED_SERVICES_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Read-only preparation under the original requester, never the Machine custodian. */
export function isExternalActionConnectedAccountInventoryHttpPurpose(
    binding: Readonly<{ actionId: string }>, effectActionId: string,
    proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>,
): boolean {
    return binding.actionId === SESSION_SPAWN_CONNECTED_SERVICES_LIST_ACTION_ID_V1 && effectActionId === binding.actionId
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && (proof.routeInput === undefined || sameStrictJsonValue(proof.routeInput, {}))
        && (proof.path === '/v1/account/profile' || proof.path === '/v1/account/encryption/currentness'
            || proof.path === '/v2/account/settings' || proof.path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`);
}
