import axios from '@/api/client/credentialAxios';

import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { SavedSecretResourceEnvelopeCensusRequestV1Schema, SavedSecretResourceEnvelopeCensusResponseV1Schema,
    type SavedSecretResourceEnvelopeCensusRecipientV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SavedSecretResourceEnvelopeRepairInputV1Schema, SavedSecretResourceEnvelopeRepairOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { prepareSavedSecretResourceRecipientEnvelopesV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { getRandomBytes } from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { readSavedSecretCatalogForOperation } from './savedSecretCatalogRead';
import type { SavedSecretOperationContextV1 } from './savedSecretOperationContext';

/** Existing resource census/repair transport, using the same owed-ready custody decision as the UI. */
export async function repairSavedSecretResourceEnvelopesForOperation(input: Readonly<{
    credentials: StoredCredentials; expectedScopeKey: string; resourceId: string; expectedRevision: number;
    signal?: AbortSignal; assertCurrent(): Promise<void>;
    operationContext?: SavedSecretOperationContextV1;
}>): Promise<void> {
    await input.assertCurrent();
    const snapshot = await readSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey,
        references: [{ ref: formatSharedSavedSecretRefV1(input.resourceId) }], refreshCatalog: true, signal: input.signal,
        ...(input.operationContext ? { operationContext: input.operationContext } : {}),
    });
    await input.assertCurrent();
    const resource = snapshot.savedSecretResources?.find(row => row.resourceId === input.resourceId);
    if (!resource || resource.revision !== input.expectedRevision || resource.encryptionMode !== 'e2ee' || !resource.resourceDataKey) return;
    const resourceDataKey = new Uint8Array(resource.resourceDataKey);
    try {
        const base = input.operationContext?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}` };
        const recipients: SavedSecretResourceEnvelopeCensusRecipientV1[] = [];
        let cursor: string | undefined;
        do {
            await input.assertCurrent();
            const request = bindHomeDomainHttpRequestV1({
                transport: { method: 'GET', path: '/v1/account/saved-secrets/resources/envelope-census' },
                inputSchema: SavedSecretResourceEnvelopeCensusRequestV1Schema,
                input: { resourceId: input.resourceId, ...(cursor ? { cursor } : {}), limit: 100 },
            });
            const response = await axios.get(`${base}${request.path}`, { headers, signal: input.signal, validateStatus: () => true });
            await input.assertCurrent();
            if (response.status !== 200) return;
            const census = SavedSecretResourceEnvelopeCensusResponseV1Schema.parse(response.data);
            if (census.resourceId !== input.resourceId || census.revision !== input.expectedRevision) return;
            recipients.push(...census.recipients);
            cursor = census.nextCursor ?? undefined;
        } while (cursor);
        const keyEnvelopes = prepareSavedSecretResourceRecipientEnvelopesV1({ recipients, resourceDataKey, randomBytes: getRandomBytes });
        if (keyEnvelopes.length === 0) return;
        await input.assertCurrent();
        const repair = SavedSecretResourceEnvelopeRepairInputV1Schema.parse({ resourceId: input.resourceId,
            expectedRevision: input.expectedRevision, keyEnvelopes });
        const response = await axios.post(`${base}/v1/account/saved-secrets/resources/envelopes/repair`, repair,
            { headers, signal: input.signal, validateStatus: () => true });
        if (response.status === 200) SavedSecretResourceEnvelopeRepairOutputV1Schema.parse(response.data);
    } finally { resourceDataKey.fill(0); }
}
