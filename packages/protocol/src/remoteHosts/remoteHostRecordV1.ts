import { StoredRemoteHostRecordV1Schema, StoredLegacyRemoteHostRecordV1Schema, LegacyRemoteHostRecordV1Schema, RemoteHostCatalogRecordV1Schema, StoredRemoteHostCatalogContentV1Schema } from "./remoteHostSchemasV1.js";
import type { RemoteHostRecordV1, LegacyRemoteHostRecordV1, RemoteHostCatalogRecordV1, RemoteHostCatalogContentV1, RemoteHostStoredCatalogContentV1, RemoteHostCatalogDiagnosticV1, RemoteHostCatalogRowReadResponseV1, RemoteHostCatalogSnapshotV1 } from "./remoteHostSchemasV1.js";
export { RemoteHostAuthModeV1Schema, RemoteHostSshProfileV1Schema, RemoteHostRecordV1Schema, StoredRemoteHostRecordV1Schema, LegacyRemoteHostRecordV1Schema, StoredLegacyRemoteHostRecordV1Schema, RemoteHostCatalogRecordV1Schema, StoredRemoteHostCatalogRecordV1Schema, RemoteHostCatalogContentV1Schema, StoredRemoteHostCatalogContentV1Schema, RemoteHostCatalogRowFailureV1Schema, RemoteHostCatalogRowReadResponseV1Schema, RemoteHostCatalogRowMutationV1Schema, RemoteHostCatalogRowMutationResponseV1Schema, AccountEncryptionMigrateRemoteHostsDirectiveV1Schema, AccountEncryptionMigrateRemoteHostsResultV1Schema } from "./remoteHostSchemasV1.js";
export type { RemoteHostAuthModeV1, RemoteHostRecordV1, LegacyRemoteHostRecordV1, RemoteHostCatalogRecordV1, RemoteHostCatalogContentV1, RemoteHostStoredCatalogContentV1, StoredRemoteHostCatalogContentV1, RemoteHostCatalogDiagnosticV1, RemoteHostCatalogRowReadResponseV1, RemoteHostCatalogRowMutationV1, RemoteHostCatalogRowMutationResponseV1, AccountEncryptionMigrateRemoteHostsDirectiveV1, AccountEncryptionMigrateRemoteHostsResultV1, RemoteHostCatalogSnapshotV1 } from "./remoteHostSchemasV1.js";
import { z } from 'zod/mini';
import tweetnacl from 'tweetnacl';


import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';

import { listSavedSecretReferenceCarrierPathsV1 } from '../account/settings/savedSecretReferenceV1.js';
import { listSecretStringCarrierPathsV1 } from '../crypto/settingsSecretStringSchemasV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

export const REMOTE_HOST_ACCOUNT_KV_PREFIX_V1 = '@happier/account/remote-hosts/v1/' as const;
export const REMOTE_HOST_ACCOUNT_KV_KEY_V1 = `${REMOTE_HOST_ACCOUNT_KV_PREFIX_V1}catalog` as const;
export const REMOTE_HOST_ROWS_ROUTE_V1 = '/v1/account/entity-rows/remote-hosts' as const;
export const REMOTE_HOST_ACCOUNT_CIPHER_KIND_V1 = 'account_remote_host_catalog' as const;
type OpenedInventory<T> = Readonly<{ status: 'ready' | 'partial'; hosts: readonly T[]; diagnostics: readonly RemoteHostCatalogDiagnosticV1[] }>
    | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' }>;
function projectHosts<T>(raw: unknown, schema: z.ZodMiniType<T>, rejectRetiredMaterial = false): OpenedInventory<T> {
    if (!Array.isArray(raw)) return { status: 'unavailable', reason: 'invalid-stored-content' };
    const ids = new Set<string>();
    const hosts: T[] = [];
    const diagnostics: RemoteHostCatalogDiagnosticV1[] = [];
    raw.forEach((candidate, index) => {
        const id = candidate !== null && typeof candidate === 'object' && 'id' in candidate && typeof candidate.id === 'string' ? candidate.id : null;
        const parsed = schema.safeParse(candidate);
        const projectedCarriers = parsed.success ? new Set(listSavedSecretReferenceCarrierPathsV1(parsed.data)) : new Set<string>();
        const unknownReferences = listSavedSecretReferenceCarrierPathsV1(candidate).some(path => !projectedCarriers.has(path));
        const projectedMaterial = parsed.success ? new Set(listSecretStringCarrierPathsV1(parsed.data)) : new Set<string>();
        const unknownMaterial = listSecretStringCarrierPathsV1(candidate).some(path => !projectedMaterial.has(path));
        const ssh = candidate !== null && typeof candidate === 'object' && 'ssh' in candidate ? candidate.ssh : null;
        const retiredMaterial = rejectRetiredMaterial && ssh !== null && typeof ssh === 'object'
            && (('passwordEnc' in ssh && ssh.passwordEnc != null) || ('identityPrivateKeyEnc' in ssh && ssh.identityPrivateKeyEnc != null));
        if (!parsed.success || id === null || unknownReferences || unknownMaterial || retiredMaterial) diagnostics.push({ index, id, reason: 'invalid-stored-content' });
        else if (ids.has(id)) diagnostics.push({ index, id, reason: 'duplicate-identity' });
        else { ids.add(id); hosts.push(parsed.data); }
    });
    return { status: diagnostics.length ? 'partial' : 'ready', hosts, diagnostics };
}
export function readRetainedRemoteHostCatalogV1(raw: unknown): OpenedInventory<LegacyRemoteHostRecordV1> {
    return projectHosts(raw, StoredLegacyRemoteHostRecordV1Schema);
}
/** Destructive history cleanup requires lossless recognition, not the display projection. */
export function isCompleteRetainedRemoteHostCatalogV1(raw: unknown): boolean {
    const inventory = readRetainedRemoteHostCatalogV1(raw);
    if (inventory.status !== 'ready' || !Array.isArray(raw)) return false;
    return raw.every(candidate => {
        const parsed = LegacyRemoteHostRecordV1Schema.safeParse(candidate);
        return parsed.success && sameStrictJsonValue(parsed.data, candidate)
            && [parsed.data.ssh.passwordEnc, parsed.data.ssh.identityPrivateKeyEnc].every(secret => secret == null
                || Boolean(secret.value || secret.encryptedValue));
    });
}
export function readRemoteHostCatalogRecordV1(raw: unknown): OpenedInventory<RemoteHostRecordV1> {
    const record = z.object({ v: z.literal(1), hosts: z.array(z.unknown()) }).safeParse(raw);
    if (!record.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
    const projectedReferences = new Set(listSavedSecretReferenceCarrierPathsV1(record.data));
    const projectedMaterial = new Set(listSecretStringCarrierPathsV1(record.data));
    if (listSavedSecretReferenceCarrierPathsV1(raw).some(path => !projectedReferences.has(path))
        || listSecretStringCarrierPathsV1(raw).some(path => !projectedMaterial.has(path)))
        return { status: 'unavailable', reason: 'invalid-stored-content' };
    return projectHosts(record.data.hosts, StoredRemoteHostRecordV1Schema, true);
}
export function assertRemoteHostCatalogContentForModeV1(content: RemoteHostStoredCatalogContentV1, mode: 'plain' | 'e2ee'): void {
    if ((mode === 'plain') !== (content.t === 'plain') || (content.t === 'encrypted' && !isAccountScopedBlobCiphertextForKind({
        kind: REMOTE_HOST_ACCOUNT_CIPHER_KIND_V1, ciphertext: content.c,
    }))) throw new Error('account-mode-mismatch');
}
export function openRemoteHostCatalogContentV1(input: Readonly<{ content: unknown; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null }>):
    OpenedInventory<RemoteHostRecordV1> | Readonly<{ status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' }> {
    const content = StoredRemoteHostCatalogContentV1Schema.safeParse(input.content);
    if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
    try { assertRemoteHostCatalogContentForModeV1(content.data, input.mode); }
    catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
    if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
    if (content.data.t === 'plain') return readRemoteHostCatalogRecordV1(content.data.v);
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    const opened = openAccountScopedBlobCiphertext({ kind: REMOTE_HOST_ACCOUNT_CIPHER_KIND_V1, material: input.material, ciphertext: content.data.c });
    return opened ? readRemoteHostCatalogRecordV1(opened.value) : { status: 'unavailable', reason: 'invalid-stored-content' };
}
export function sealRemoteHostCatalogContentV1(input: Readonly<{ record: RemoteHostCatalogRecordV1; mode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null; randomBytes?: (length: number) => Uint8Array }>): RemoteHostCatalogContentV1 {
    const record = RemoteHostCatalogRecordV1Schema.parse(input.record);
    if (input.mode === 'plain') {
        if (input.material !== null) throw new Error('account-mode-mismatch');
        return { t: 'plain', v: record };
    }
    if (!input.material) throw new Error('encryption-material-unavailable');
    return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: REMOTE_HOST_ACCOUNT_CIPHER_KIND_V1,
        material: input.material, payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}
/** This reader has no migration side effect; the admitted Account loader owns the bounded cutover. */
export async function loadRemoteHostCatalogV1(input: Readonly<{ mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
    readRow(): Promise<RemoteHostCatalogRowReadResponseV1>; signal?: AbortSignal }>): Promise<RemoteHostCatalogSnapshotV1> {
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (input.mode === 'e2ee' && !input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
    const row = await input.readRow();
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (row.status === 'absent' || row.status === 'deleted') return { status: 'ready', hosts: [], diagnostics: [], revision: row.status === 'absent' ? 'absent' : row.revision };
    if (row.status !== 'present') return { status: 'unavailable', reason: row.status };
    const opened = openRemoteHostCatalogContentV1({ ...input, content: row.content });
    return opened.status === 'unavailable' ? opened : { ...opened, revision: row.revision };
}
