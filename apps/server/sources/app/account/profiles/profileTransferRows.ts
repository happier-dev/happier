import {
    assertProfileTransferContentForModeV1,
    ProfileTransferMutationV1Schema,
    profileTransferInventoriesEqualV1,
    type ProfileTransferInventoryEntryV1,
    type ProfileTransferMutationV1,
    type ProfileTransferMutationResponseV1,
} from '@happier-dev/protocol/profiles/profileTransferV1';
import { parseSavedSecretRefV1, formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { hasProfileTransferSourceV1, readEffectiveProfileSecretBindingsV1 } from '@happier-dev/protocol/profiles/read';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';
import type { Tx } from '@/storage/inTx';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { inTx } from '@/storage/inTx';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { openPlainAccountSettingsDbValue, PlainAccountSettingsStorageUnavailableError } from '@/app/encryption/accountSettingsStorage';
import { PROFILE_ACCOUNT_KV_PREFIX, PROFILE_TRANSFER_ACCOUNT_KV_KEY, parseProfilePhysicalKey } from '@/app/kv/accountScopedKv';
import {
    mutateReservedAccountScopedKvRowInTx, listReservedAccountScopedKvRowsInTx,
} from '@/app/kv/reservedAccountScopedKvRow';
import { readArtifactForCallerInTx, projectPlainArtifactSharingResourceV1 } from '@/app/artifacts/artifactAccessService';
import { listSavedSecretResourcesForAccountInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { profileRecordDomain, mutateProfileRowsInTx } from './profileRows';
import { profileTransferDomain, readProfileTransferControlInTx, markProfileTransferChangedInTx } from './profileTransferControl';
export { profileTransferDomain, readProfileTransferControlInTx, profileTransferControlReadResponseV1, markProfileTransferChangedInTx } from './profileTransferControl';

type InventoryResult = Readonly<{ status: 'verified' }> | Exclude<ProfileTransferMutationResponseV1, { status: 'updated' | 'already-active' }>;

/** Complete raw destination census: partial page/list projections never establish transfer authority. */
async function verifyProfileTransferInventoryInTx(tx: Tx, input: Readonly<{
    accountId: string; inventory: readonly ProfileTransferInventoryEntryV1[]; operation: 'prepare' | 'activate';
    authentication?: TeamOperationAuthenticationContext;
}>): Promise<InventoryResult> {
    const listed = await listReservedAccountScopedKvRowsInTx(tx, {
        accountId: input.accountId, physicalPrefix: PROFILE_ACCOUNT_KV_PREFIX, domain: profileRecordDomain,
    });
    if (listed.status !== 'listed') return listed;
    const rows = listed.rows.filter(row => row.envelope !== null);
    const expectedRows = input.inventory.filter(entry => entry.kind === 'account_row');
    if (rows.length !== expectedRows.length) return { status: 'inventory-incomplete' };
    const rowsById = new Map(expectedRows.map(entry => [entry.id, entry]));
    const artifactProfileIds = new Map<string, Set<string>>();
    const plainRecords: ProfileRecordV1[] = [];
    const artifactsById = new Map<string, ArtifactSharingResourceV1>();
    const savedSecretIds = new Set<string>();
    for (const row of listed.rows) {
        const id = parseProfilePhysicalKey(row.physicalKey);
        if (id === null) return { status: 'invalid-stored-content' };
        if (row.envelope === null) continue;
        const expected = rowsById.get(id);
        if (!expected || expected.revision !== row.revision) return { status: 'inventory-incomplete' };
        if (row.envelope.t === 'plain') {
            const record = row.envelope.v;
            if (record.id !== id) return { status: 'invalid-stored-content' };
            plainRecords.push(record);
            if (record.definition.kind === 'artifact') {
                const profileIds = artifactProfileIds.get(record.definition.artifactId) ?? new Set<string>();
                profileIds.add(record.id);
                artifactProfileIds.set(record.definition.artifactId, profileIds);
            }
        }
    }
    if ([...artifactProfileIds.keys()].some(id => !input.inventory.some(entry => entry.kind === 'artifact' && entry.id === id))) {
        return { status: 'inventory-incomplete' };
    }
    for (const entry of input.inventory) {
        if (entry.kind === 'artifact') {
            // The Artifact owner checks current ownership/grants, visibility, mode and recipient key readiness.
            const resource = await readArtifactForCallerInTx(tx, { actorAccountId: input.accountId, artifactId: entry.id });
            if (!resource.ok) return { status: 'invalid-reference' };
            if (resource.artifact.headerVersion !== entry.revision.headerVersion || resource.artifact.bodyVersion !== entry.revision.bodyVersion) {
                return { status: 'inventory-incomplete' };
            }
            const profileIds = artifactProfileIds.get(entry.id);
            if (profileIds !== undefined) {
                const projected = projectPlainArtifactSharingResourceV1(resource.artifact);
                if (!projected) return { status: 'invalid-reference' };
                artifactsById.set(entry.id, projected);
            }
        }
    }
    for (const record of plainRecords) {
        const bindings = readEffectiveProfileSecretBindingsV1(record, { artifactsById });
        if (bindings === null) return { status: 'invalid-reference' };
        for (const value of Object.values(bindings)) {
            const reference = parseSavedSecretRefV1(value);
            if (reference.kind === 'shared_resource') savedSecretIds.add(reference.resourceId);
            else if (input.operation === 'activate') return { status: 'invalid-reference' };
        }
    }
    if ([...savedSecretIds].some(id => !input.inventory.some(entry => entry.kind === 'saved_secret' && entry.id === id))) {
        return { status: 'inventory-incomplete' };
    }
    const secretInventory = input.inventory.filter(entry => entry.kind === 'saved_secret');
    const secrets = secretInventory.length > 0 ? await listSavedSecretResourcesForAccountInTx(tx, input.accountId, input.authentication) : [];
    for (const entry of secretInventory) {
        const ref = formatSharedSavedSecretRefV1(entry.id);
        const resource = secrets.find(secret => 'ref' in secret && secret.ref === ref);
        if (!resource || !('ref' in resource) || !resource.capabilities.use) return { status: 'invalid-reference' };
        if (resource.revision !== entry.revision) return { status: 'inventory-incomplete' };
    }
    return { status: 'verified' };
}

/** Returning a refusal after imported rows were written would commit a partial preparation. */
export class ProfileTransferTransactionAbort extends Error {
    constructor(readonly result: ProfileTransferMutationResponseV1) { super(result.status); this.name = 'ProfileTransferTransactionAbort'; }
}

/** Preparation imports and its proof commit together; activation only changes the fenced proof. */
export async function mutateProfileTransferInTx(tx: Tx, input: Readonly<{
    accountId: string; mutation: ProfileTransferMutationV1; authentication?: TeamOperationAuthenticationContext;
}>): Promise<ProfileTransferMutationResponseV1> {
    const mutation = ProfileTransferMutationV1Schema.parse(input.mutation);
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === 'account_not_found') return { status: 'account-not-found' };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent', reason: fence.reason };
    const current = await readProfileTransferControlInTx(tx, input);
    if (current.status !== 'present' && current.status !== 'absent' && current.status !== 'deleted') return current;
    // Plain can prove activation here; E2EE's canonical authorized client opens the same envelope before retrying.
    if (current.status === 'present' && current.envelope.t === 'plain' && current.envelope.v.phase === 'active') {
        return { status: 'already-active', revision: current.revision };
    }
    const revision = current.status === 'absent' ? 'absent' : current.revision;
    if (revision !== mutation.expectedRevision) return { status: 'conflict', revision: revision === 'absent' ? -1 : revision };
    if (fence.account.settingsVersion !== mutation.sourceSettingsVersion) return { status: 'settings-conflict', revision: fence.account.settingsVersion };
    try { assertProfileTransferContentForModeV1(mutation.content, fence.account.currentness.encryptionMode); }
    catch { return { status: 'account-mode-mismatch' }; }
    if (mutation.operation === 'activate' && current.status !== 'present') {
        // Real source absence is already native destination authority, never a synthesized transfer marker.
        return { status: 'inventory-incomplete' };
    }
    if (mutation.operation === 'prepare' && fence.account.currentness.encryptionMode === 'plain') {
        try {
            const source = openPlainAccountSettingsDbValue({ accountId: input.accountId, dbValue: fence.account.settings });
            if (source?.t !== 'plain' || !hasProfileTransferSourceV1(source.v)) return { status: 'inventory-incomplete' };
        } catch (error) {
            if (error instanceof PlainAccountSettingsStorageUnavailableError) return { status: 'invalid-stored-content' };
            throw error;
        }
    }
    if (mutation.operation === 'activate' && current.status === 'present' && current.envelope.t === 'plain' && mutation.content.t === 'plain') {
        const prepared = current.envelope.v;
        if (prepared.sourceSettingsVersion !== mutation.sourceSettingsVersion
            || prepared.migratedLogicalRevision !== mutation.content.v.migratedLogicalRevision
            || !profileTransferInventoriesEqualV1(prepared.inventory, mutation.inventory)) return { status: 'inventory-incomplete' };
    }
    let imported = false;
    if (mutation.operation === 'prepare' && mutation.imports.length > 0) {
        const result = await mutateProfileRowsInTx(tx, { accountId: input.accountId, mutations: mutation.imports,
            ...(input.authentication === undefined ? {} : { authentication: input.authentication }) });
        if (result.status !== 'updated') return result;
        imported = true;
    }
    const inventory = await verifyProfileTransferInventoryInTx(tx, { accountId: input.accountId, inventory: mutation.inventory, operation: mutation.operation,
        ...(input.authentication === undefined ? {} : { authentication: input.authentication }) });
    if (inventory.status !== 'verified') {
        if (imported) throw new ProfileTransferTransactionAbort(inventory);
        return inventory;
    }
    const result = await mutateReservedAccountScopedKvRowInTx(tx, {
        accountId: input.accountId, physicalKey: PROFILE_TRANSFER_ACCOUNT_KV_KEY, expectedRevision: mutation.expectedRevision,
        envelope: mutation.content, domain: profileTransferDomain,
        markChanged: ({ tx, revision }) => markProfileTransferChangedInTx(tx, { accountId: input.accountId, revision }),
    });
    if (result.status !== 'updated' && imported) throw new ProfileTransferTransactionAbort(result);
    return result;
}

export async function mutateProfileTransfer(input: Readonly<{
    accountId: string; mutation: ProfileTransferMutationV1; authentication?: TeamOperationAuthenticationContext;
}>): Promise<ProfileTransferMutationResponseV1> {
    try { return await inTx(tx => mutateProfileTransferInTx(tx, input)); }
    catch (error) {
        if (error instanceof ProfileTransferTransactionAbort) return error.result;
        throw error;
    }
}
