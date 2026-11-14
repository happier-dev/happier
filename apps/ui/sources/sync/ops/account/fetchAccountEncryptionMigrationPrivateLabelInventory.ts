import {
    ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
    AccountApiTokensListActionOutputV1Schema,
} from '@happier-dev/protocol/auth/accountApiTokens';
import {
    ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1,
    AccountDirectoryHomesResponseV1Schema,
} from '@happier-dev/protocol/auth/accountDirectory';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { MachinePoolListOutputV1Schema } from '@happier-dev/protocol/machines/pools/v1';

import type { ServerFetch } from '@/sync/http/client';
import {
    assertAccountEncryptionMigrationScopeCurrent,
    type AccountEncryptionMigrationScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import type { AccountEncryptionMigrationPrivateLabelCandidate } from './buildAccountEncryptionPrivateLabelsDirective';

/**
 * Reads every Account-owned private label from its ordinary projection route
 * before a signed Account-mode transition. The server remains the inventory
 * authority and rejects a directive that no longer names its full row set.
 */
export async function fetchAccountEncryptionMigrationPrivateLabelInventory(
    params: Readonly<{
        /** The request captured for this exact Home/Account transition. */
        request: ServerFetch;
        scope: AccountEncryptionMigrationScope;
    }>,
): Promise<readonly AccountEncryptionMigrationPrivateLabelCandidate[]> {
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const [tokensResponse, homesResponse, poolsResponse] = await Promise.all([
        params.request(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ includeChildren: true }),
        }),
        params.request(ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1, { method: 'GET' }),
        params.request(machinePoolActionEndpointPathV1('machines.pools.list'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        }),
    ]);
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    if (!tokensResponse.ok || !homesResponse.ok || !poolsResponse.ok) {
        throw new Error('Account private-label migration inventory is unavailable');
    }
    const [tokensPayload, homesPayload, poolsPayload] = await Promise.all([
        tokensResponse.json(),
        homesResponse.json(),
        poolsResponse.json(),
    ]);
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const tokens = AccountApiTokensListActionOutputV1Schema.parse(tokensPayload);
    const homes = AccountDirectoryHomesResponseV1Schema.parse(homesPayload);
    const pools = MachinePoolListOutputV1Schema.parse(poolsPayload);
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    return [
        ...tokens.tokens.map(token => ({
            entity: 'account_api_token' as const,
            field: 'label' as const,
            id: token.tokenId,
            label: token.label,
        })),
        ...homes.homes.flatMap(home => home.label === null ? [] : [{
            entity: 'account_directory_home' as const,
            field: 'label' as const,
            id: home.homeServerIdentityId,
            label: home.label,
        }]),
        ...pools.pools.flatMap(({ pool }) => {
            if (pool.audience?.kind !== 'private') return [];
            return [
                ...(pool.name.kind === 'available' ? [{
                    entity: 'machine_pool' as const,
                    field: 'name' as const,
                    id: pool.id,
                    label: pool.name.label,
                }] : []),
                ...(pool.description?.kind === 'available' ? [{
                    entity: 'machine_pool' as const,
                    field: 'description' as const,
                    id: pool.id,
                    label: pool.description.label,
                }] : []),
            ];
        }),
    ];
}
