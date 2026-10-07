import {
    SavedSecretResourceMaterialsResponseV1Schema,
    type SavedSecretResourceMaterialV1,
} from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { requestHomeDomain, type HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';

export type SavedSecretCatalogReadResult =
    | Readonly<{ ok: true; resources: readonly SavedSecretResourceMaterialV1[] }>
    | Readonly<{ ok: false; failure: HomeDomainFailure }>;

export async function readSavedSecretCatalog(
    scope: ServerAccountScope,
    signal?: AbortSignal,
): Promise<SavedSecretCatalogReadResult> {
    const result = await requestHomeDomain({
        scope,
        path: '/v1/account/saved-secrets/resources/materials',
        effect: 'read',
        method: 'GET',
        input: undefined,
        schema: SavedSecretResourceMaterialsResponseV1Schema,
        signal,
    });
    return result.ok
        ? { ok: true, resources: result.value.resources }
        : { ok: false, failure: result.failure };
}
