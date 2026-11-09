import { describe, expect, it } from 'vitest';

import { ACTION_INVOKE_ACTION_ID_V1, SESSION_SPAWN_CONNECTED_SERVICES_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { CONNECTED_SERVICES_ACCOUNTS_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/connect/configurationActionIdsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import { isExternalActionConnectedAccountInventoryHttpPurpose } from './externalActionConnectedAccountInventoryPurpose';

describe('Connected Account inventory signed HTTP purpose', () => {
    it.each([CONNECTED_SERVICES_ACCOUNTS_LIST_ACTION_ID_V1, ACTION_INVOKE_ACTION_ID_V1])(
        'allows requester profile inventory under %s',
        (actionId) => {
            expect(isExternalActionConnectedAccountInventoryHttpPurpose(
                { actionId }, CONNECTED_SERVICES_ACCOUNTS_LIST_ACTION_ID_V1,
                { method: 'GET', path: '/v1/account/profile', routeInput: {} },
            )).toBe(true);
        },
    );

    it.each([
        { method: 'POST', path: '/v1/account/profile' },
        { method: 'GET', path: '/v2/account/settings' },
        { method: 'GET', path: '/v1/account/profile', body: {} },
        { method: 'GET', path: '/v1/account/profile', routeInput: { accountId: 'another-account' } },
    ])('refuses inventory outside the profile read purpose: %j', (proof) => {
        expect(isExternalActionConnectedAccountInventoryHttpPurpose(
            { actionId: CONNECTED_SERVICES_ACCOUNTS_LIST_ACTION_ID_V1 },
            CONNECTED_SERVICES_ACCOUNTS_LIST_ACTION_ID_V1, proof,
        )).toBe(false);
    });

    it('refuses to borrow an unrelated signed root or effect', () => {
        const proof = { method: 'GET', path: '/v1/account/profile' };
        expect(isExternalActionConnectedAccountInventoryHttpPurpose(
            { actionId: 'account.profile.get' }, CONNECTED_SERVICES_ACCOUNTS_LIST_ACTION_ID_V1, proof,
        )).toBe(false);
        expect(isExternalActionConnectedAccountInventoryHttpPurpose(
            { actionId: CONNECTED_SERVICES_ACCOUNTS_LIST_ACTION_ID_V1 }, ACTION_INVOKE_ACTION_ID_V1, proof,
        )).toBe(false);
    });

    it.each([
        '/v1/account/profile', '/v1/account/encryption/currentness', '/v2/account/settings',
        `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`,
    ])('preserves the admitted spawn inventory read of %s', (path) => {
        expect(isExternalActionConnectedAccountInventoryHttpPurpose(
            { actionId: SESSION_SPAWN_CONNECTED_SERVICES_LIST_ACTION_ID_V1 },
            SESSION_SPAWN_CONNECTED_SERVICES_LIST_ACTION_ID_V1, { method: 'GET', path },
        )).toBe(true);
    });
});
