import {
    SavedSecretResourceMaterialsResponseV1Schema,
    type SavedSecretResourceMaterialV1,
    type SavedSecretCatalogEntryV1,
} from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { requestHomeDomain, type HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { installedSecretSourceDeclarations, withSavedSecretProviderLabels } from './savedSecretCatalogPresentation';

function catalogProviderDeclarations(scope: ServerAccountScope) {
    return installedSecretSourceDeclarations(readPluginAccountAvailability(scope).readInstalledPlugins());
}

import type { SavedSecretResourceMaterialSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { SavedSecretResourceContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

export type SavedSecretCatalogReadResult =
    | Readonly<{ ok: true; resources: readonly SavedSecretResourceMaterialV1[] }>
    | Readonly<{ ok: false; failure: HomeDomainFailure }>;

/** Catalog presentation requests metadata only; material reads retain their admitted owner below. */
export async function readSavedSecretCatalogMetadataInContext(
    context: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'request' | 'assertCurrent'>,
    signal?: AbortSignal,
): Promise<Readonly<{ ok: true; resources: ReturnType<typeof SharedSavedSecretListOutputV1Schema.parse>['resources'] }>
    | Readonly<{ ok: false; failure: HomeDomainFailure }>> {
    const result = await requestHomeDomain({
        scope: { serverId: context.serverId, accountId: context.accountId },
        path: '/v1/account/saved-secrets/resources', effect: 'read', method: 'GET',
        input: undefined, schema: SharedSavedSecretListOutputV1Schema, signal, requestAuthority: context,
    });
    return result.ok ? { ok: true, resources: withSavedSecretProviderLabels(result.value.resources.map(entry => ({ entry })),
        catalogProviderDeclarations({ serverId: context.serverId, accountId: context.accountId })).map(resource => resource.entry) }
        : { ok: false, failure: result.failure };
}

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
        ? { ok: true, resources: withSavedSecretProviderLabels(result.value.resources, catalogProviderDeclarations(scope)) }
        : { ok: false, failure: result.failure };
}

/** Profile and resource transactions borrow their exact admitted Account lifetime. */
export async function readSavedSecretCatalogInContext(
    context: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'request' | 'assertCurrent'>,
    signal?: AbortSignal,
    selection?: SavedSecretResourceMaterialSelectionV1,
): Promise<SavedSecretCatalogReadResult> {
    const query = new URLSearchParams();
    if (selection?.resourceId) query.set('resourceId', selection.resourceId);
    if (selection?.expectedRevision !== undefined) query.set('expectedRevision', String(selection.expectedRevision));
    if (selection?.requireManage) query.set('requireManage', 'true');
    const result = await requestHomeDomain({
        scope: { serverId: context.serverId, accountId: context.accountId },
        path: `/v1/account/saved-secrets/resources/materials${query.size ? `?${query}` : ''}`, effect: 'read', method: 'GET',
        input: undefined, schema: SavedSecretResourceMaterialsResponseV1Schema, signal,
        requestAuthority: context,
    });
    return result.ok ? { ok: true, resources: result.value.resources } : { ok: false, failure: result.failure };
}

export type SavedSecretReferenceReadResult =
    | Readonly<{ ok: true; value: string; revision: number }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'changed' }>;

type SavedSecretReferenceMaterial = Readonly<{ value: string; revision: number; name: string; kind: SavedSecret['kind'] }>;

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
    admission?: Readonly<{ expectedRevision: number; requireManage: true; isCurrent?: () => boolean }>,
): Promise<SavedSecretReferenceReadResult> {
    const read = await readSavedSecretReferencesInContext(context, [reference], signal, admission);
    if (!read.ok) return read;
    const material = read.values.get(reference)!;
    return { ok: true, value: material.value, revision: material.revision };
}

export async function readSavedSecretReferencesInContext(
    context: SavedSecretReferenceAccountContext,
    references: readonly string[],
    signal?: AbortSignal,
    admission?: Readonly<{ expectedRevision: number; requireManage?: true; isCurrent?: () => boolean }>,
): Promise<Readonly<{ ok: true; values: ReadonlyMap<string, SavedSecretReferenceMaterial> }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'changed' }>> {
    const read = await readSavedSecretContentsInContext(context, references, signal, admission);
    if (!read.ok) return read;
    const values = new Map<string, SavedSecretReferenceMaterial>();
    for (const [ref, { content, revision }] of read.contents) {
        if (content.v !== 1) return { ok: false, reason: 'unavailable' };
        values.set(ref, { value: content.value, revision, name: content.name, kind: content.kind });
    }
    return { ok: true, values };
}

/** Scalar and native consumers open the same admitted content and project their own supported form. */
export async function readSavedSecretContentsInContext(
    context: SavedSecretReferenceAccountContext,
    references: readonly string[],
    signal?: AbortSignal,
    admission?: Readonly<{ expectedRevision: number; requireManage?: true; isCurrent?: () => boolean }>,
): Promise<Readonly<{ ok: true; contents: ReadonlyMap<string, Readonly<{ content: SavedSecretResourceContentV1; revision: number; entry: SavedSecretCatalogEntryV1 }>> }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'changed' }>> {
    const assertCurrent = () => {
        signal?.throwIfAborted();
        context.assertCurrent();
        if (admission?.isCurrent?.() === false) throw new Error('saved-secret-read-retired');
    };
    try {
        assertCurrent();
        const accountMode = await context.resolveAccountMode();
        assertCurrent();
        const parsedRef = references.length === 1 ? parseSavedSecretRefV1(references[0]!) : null;
        if (admission && parsedRef?.kind !== 'shared_resource') return { ok: false, reason: 'unavailable' };
        const result = await readSavedSecretCatalogInContext(context, signal,
            parsedRef?.kind === 'shared_resource' ? { resourceId: parsedRef.resourceId,
                ...(admission ? { expectedRevision: admission.expectedRevision,
                    ...(admission.requireManage ? { requireManage: true } : {}) } : {}) } : undefined);
        assertCurrent();
        if (!result.ok) return { ok: false, reason: result.failure.kind === 'conflict' ? 'changed' : 'unavailable' };
        const resources = result.resources.filter((row): row is Extract<SavedSecretResourceMaterialV1, { resourceId: string }> =>
            'resourceId' in row && references.includes(row.entry.ref));
        if (resources.length !== references.length || resources.some(resource => resource.entry.materialStatus !== 'ready' || !resource.entry.capabilities.use
            || resource.entry.revision === null)) return { ok: false, reason: 'unavailable' };
        if (admission && resources.some(resource => resource.entry.revision !== admission.expectedRevision)) return { ok: false, reason: 'changed' };
        if (admission?.requireManage && resources.some(resource => !resource.entry.capabilities.manageAccess)) return { ok: false, reason: 'unavailable' };

        // Resource protection is independent of Account Settings protection. Only an
        // encrypted resource requires this Account's recipient-envelope material.
        const needsAccountEncryption = resources.some(resource => resource.encryptionMode === 'e2ee');
        const encryption = needsAccountEncryption ? (await context.resolveAccountEncryption()).encryption : null;
        assertCurrent();
        if (needsAccountEncryption) {
            const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request, usage: 'identity' });
            assertCurrent();
            if (storage.mode !== accountMode) return { ok: false, reason: 'unavailable' };
        }
        assertCurrent();

        const opened = await materializeSavedSecretResources({
            resources,
            isCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
            decryptDataKeyEnvelope: async encryptedDataKey => encryption
                ? encryption.decryptEncryptionKey(encryptedDataKey, { serverId: context.serverId, accountId: context.accountId })
                : null,
        });
        assertCurrent();
        // Opening private material cannot authorize its later disclosure: the
        // server may have committed revocation before the socket delivers it.
        const currentMode = needsAccountEncryption
            ? (await resolveAccountStorageContext(context.credentials, { encryption, request: context.request, usage: 'fresh-authority' })).mode
            : (await fetchAccountEncryptionMode(context.credentials, { request: context.request, usage: 'fresh-authority' })).mode;
        assertCurrent();
        if (currentMode !== accountMode) return { ok: false, reason: 'unavailable' };
        const contents = new Map<string, Readonly<{ content: SavedSecretResourceContentV1; revision: number; entry: SavedSecretCatalogEntryV1 }>>();
        for (const resource of resources) {
            const content = opened.contents.get(resource.entry.ref);
            const entry = opened.entries.find(row => row.ref === resource.entry.ref);
            if (!content || entry?.materialStatus !== 'ready' || !entry.capabilities.use) return { ok: false, reason: 'unavailable' };
            contents.set(resource.entry.ref, { content, revision: resource.entry.revision!, entry });
        }
        return { ok: true, contents };
    } catch {
        if (signal?.aborted) return { ok: false, reason: 'unavailable' };
        try { assertCurrent(); }
        catch { return { ok: false, reason: 'changed' }; }
        return { ok: false, reason: 'unavailable' };
    }
}
