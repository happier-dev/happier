import {
    SavedSecretResourceMaterialsResponseV1Schema,
    type SavedSecretResourceMaterialV1,
} from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { requestHomeDomain, type HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

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

/** Profile and resource transactions borrow their exact admitted Account lifetime. */
export async function readSavedSecretCatalogInContext(
    context: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'request' | 'assertCurrent'>,
    signal?: AbortSignal,
): Promise<SavedSecretCatalogReadResult> {
    const result = await requestHomeDomain({
        scope: { serverId: context.serverId, accountId: context.accountId },
        path: '/v1/account/saved-secrets/resources/materials', effect: 'read', method: 'GET',
        input: undefined, schema: SavedSecretResourceMaterialsResponseV1Schema, signal,
        requestAuthority: context,
    });
    return result.ok ? { ok: true, resources: result.value.resources } : { ok: false, failure: result.failure };
}

export type SavedSecretReferenceReadResult =
    | Readonly<{ ok: true; value: string; revision: number }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'changed' }>;

type SavedSecretReferenceAccountContext = Pick<LazyActionAccountContext,
    'serverId' | 'accountId' | 'request' | 'assertCurrent' | 'credentials' | 'resolveAccountMode' | 'resolveAccountEncryption'>;

export type SavedSecretReferenceRevisionProof = Readonly<{ resourceId: string; expectedRevision: number }>;

/** Domain row writers share the captured resource-use owner; pending transaction proofs never require a pre-existing row. */
export async function captureSavedSecretReferenceRevisionsInContext(
    context: SavedSecretReferenceAccountContext,
    input: Readonly<{
        references: readonly string[];
        savedSecretRevisions?: readonly SavedSecretReferenceRevisionProof[];
        pendingResourceIds?: readonly string[];
        signal?: AbortSignal;
    }>,
): Promise<Readonly<{
    referencedSavedSecretIds: string[];
    savedSecretRevisions: SavedSecretReferenceRevisionProof[];
}>> {
    input.signal?.throwIfAborted();
    context.assertCurrent();
    const references = [...new Set(input.references)];
    const resourceIds = references.map(reference => {
        const parsed = parseSavedSecretRefV1(reference);
        if (parsed.kind !== 'shared_resource') throw new Error('saved-secret-unavailable');
        return parsed.resourceId;
    });
    const pendingIds = new Set(input.pendingResourceIds ?? []);
    if (input.savedSecretRevisions !== undefined) {
        const proofs = new Map(input.savedSecretRevisions.map(proof => [proof.resourceId, proof]));
        if (proofs.size !== input.savedSecretRevisions.length
            || resourceIds.some(id => !proofs.has(id))
            || input.savedSecretRevisions.some(proof => !Number.isSafeInteger(proof.expectedRevision)
                || proof.expectedRevision < 0 || (pendingIds.has(proof.resourceId) && proof.expectedRevision !== 1))) {
            throw new Error('saved-secret-unavailable');
        }
        context.assertCurrent();
        return { referencedSavedSecretIds: references, savedSecretRevisions: resourceIds.map(id => proofs.get(id)!) };
    }
    const existingRefs = references.filter((_, index) => !pendingIds.has(resourceIds[index]!));
    const read = existingRefs.length ? await readSavedSecretReferencesInContext(context, existingRefs, input.signal)
        : { ok: true as const, values: new Map<string, Readonly<{ value: string; revision: number }>>() };
    if (!read.ok) throw new Error(read.reason === 'changed' ? 'account-changed' : 'saved-secret-unavailable');
    const savedSecretRevisions = resourceIds.map((resourceId, index) => ({ resourceId,
        expectedRevision: pendingIds.has(resourceId) ? 1 : read.values.get(references[index]!)!.revision }));
    context.assertCurrent();
    return { referencedSavedSecretIds: references, savedSecretRevisions };
}

/** Opens only the requested resource under the admitted Account, never a picker snapshot. */
export async function readSavedSecretReferenceInContext(
    context: SavedSecretReferenceAccountContext,
    reference: string,
    signal?: AbortSignal,
): Promise<SavedSecretReferenceReadResult> {
    const read = await readSavedSecretReferencesInContext(context, [reference], signal);
    return read.ok ? { ok: true, ...read.values.get(reference)! } : read;
}

async function readSavedSecretReferencesInContext(
    context: SavedSecretReferenceAccountContext,
    references: readonly string[],
    signal?: AbortSignal,
): Promise<Readonly<{ ok: true; values: ReadonlyMap<string, Readonly<{ value: string; revision: number }>> }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'changed' }>> {
    try {
        signal?.throwIfAborted();
        context.assertCurrent();
        const accountMode = await context.resolveAccountMode();
        context.assertCurrent();
        const result = await readSavedSecretCatalogInContext(context, signal);
        context.assertCurrent();
        if (!result.ok) return { ok: false, reason: 'unavailable' };
        const resources = result.resources.filter((row): row is Extract<SavedSecretResourceMaterialV1, { resourceId: string }> =>
            'resourceId' in row && references.includes(row.entry.ref));
        if (resources.length !== references.length || resources.some(resource => resource.entry.materialStatus !== 'ready' || !resource.entry.capabilities.use
            || resource.entry.revision === null)) return { ok: false, reason: 'unavailable' };

        // Resource protection is independent of Account Settings protection. Only an
        // encrypted resource requires this Account's recipient-envelope material.
        const needsAccountEncryption = resources.some(resource => resource.encryptionMode === 'e2ee');
        const encryption = needsAccountEncryption ? (await context.resolveAccountEncryption()).encryption : null;
        if (needsAccountEncryption) {
            const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
            if (storage.mode !== accountMode) return { ok: false, reason: 'unavailable' };
        }
        context.assertCurrent();

        const opened = await materializeSavedSecretResources({
            resources,
            decryptDataKeyEnvelope: async encryptedDataKey => encryption
                ? encryption.decryptEncryptionKey(encryptedDataKey, { serverId: context.serverId, accountId: context.accountId })
                : null,
        });
        const currentMode = (await fetchAccountEncryptionMode(context.credentials, { request: context.request })).mode;
        if (needsAccountEncryption) {
            const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
            if (current.mode !== accountMode) return { ok: false, reason: 'unavailable' };
        }
        signal?.throwIfAborted();
        context.assertCurrent();
        if (currentMode !== accountMode) return { ok: false, reason: 'unavailable' };
        const values = new Map<string, Readonly<{ value: string; revision: number }>>();
        for (const resource of resources) {
            const secret = opened.materializedSecrets.find(row => row.id === resource.entry.ref);
            const entry = opened.entries.find(row => row.ref === resource.entry.ref);
            if (!secret || entry?.materialStatus !== 'ready' || !entry.capabilities.use
                || typeof secret.encryptedValue.value !== 'string') return { ok: false, reason: 'unavailable' };
            values.set(resource.entry.ref, { value: secret.encryptedValue.value, revision: resource.entry.revision! });
        }
        return { ok: true, values };
    } catch {
        try { context.assertCurrent(); }
        catch { return { ok: false, reason: 'changed' }; }
        return { ok: false, reason: 'unavailable' };
    }
}
