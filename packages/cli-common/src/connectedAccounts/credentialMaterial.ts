import type { QualifiedConnectedAccountCredentialSnapshotV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import {
    QualifiedConnectedAccountCredentialSecretUnavailableError,
    resolveQualifiedConnectedAccountCredentialValuesV1,
    type QualifiedConnectedAccountCredentialPayloadV1,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { parseQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';

import { QualifiedConnectedAccountMaterialError } from './materialError.js';

type SecretReadOptions = Readonly<{ signal?: AbortSignal }>;

/** The incumbent Saved Secret owner admits references and opens each resource
 * using that resource's explicit mode, independently of the Account mode. */
export type ConnectedAccountCredentialSecretReader = Readonly<{
    admit(references: readonly string[], options?: SecretReadOptions): Promise<void | ConnectedAccountCredentialOperationSecretReader>;
    read(reference: string, options?: SecretReadOptions): Promise<string | null>;
    readMaterial?(reference: string, options?: SecretReadOptions): Promise<Readonly<{
        value: string;
        fingerprint: string;
    }> | null>;
}>;

export type ConnectedAccountCredentialOperationSecretReader = Pick<ConnectedAccountCredentialSecretReader, 'read' | 'readMaterial'>;

type CredentialMaterialSnapshot = Extract<QualifiedConnectedAccountCredentialSnapshotV4, { revisionSemantics: 'revisioned' }>
    & Readonly<{ authenticationModeId: string }>;

export type QualifiedConnectedAccountCredentialMaterial = Readonly<{
    snapshot: CredentialMaterialSnapshot;
    credential: QualifiedConnectedAccountCredentialPayloadV1;
    storageMode: 'plain' | 'e2ee';
}>;

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Connected-account established operation was aborted');
}

function assertCredentialSnapshot(
    snapshot: QualifiedConnectedAccountCredentialSnapshotV4,
    account: QualifiedConnectedAccountRef,
): asserts snapshot is CredentialMaterialSnapshot {
    if (!sameQualifiedConnectedAccountRef(snapshot.ref, account)) {
        throw new QualifiedConnectedAccountMaterialError('credential_snapshot_identity_mismatch', 'Connected-account credential snapshot does not match the exact qualified account');
    }
    if (snapshot.revisionSemantics !== 'revisioned') {
        throw new QualifiedConnectedAccountMaterialError('credential_snapshot_unfenced', 'Connected-account credential snapshot is unfenced');
    }
    if (!snapshot.authenticationModeId) {
        throw new QualifiedConnectedAccountMaterialError('credential_authentication_mode_unavailable', 'Connected-account authentication mode is unavailable in the current descriptor');
    }
}

/** Resolves held keys only for this acquisition; writers retain secretRefs. */
export async function resolveQualifiedConnectedAccountCredentialSecrets(
    payload: QualifiedConnectedAccountCredentialPayloadV1,
    secrets: ConnectedAccountCredentialSecretReader,
    signal?: AbortSignal,
): Promise<Readonly<{ credential: QualifiedConnectedAccountCredentialPayloadV1; fingerprints: readonly string[] }>> {
    const refs = Object.values(payload.secretRefs ?? {});
    if (refs.length === 0) return { credential: payload, fingerprints: [] };
    const options = signal ? { signal } : undefined;
    const admitted = await secrets.admit(refs, options) ?? secrets;
    const fingerprints: string[] = [];
    const credential = await resolveQualifiedConnectedAccountCredentialValuesV1(payload, async reference => {
        assertNotAborted(signal);
        if (!admitted.readMaterial) return await admitted.read(reference, options);
        const material = await admitted.readMaterial(reference, options);
        if (material) fingerprints.push(reference, material.fingerprint);
        return material?.value ?? null;
    });
    return { credential, fingerprints: Object.freeze(fingerprints) };
}

/** One exact selected Account read. Selection/grants remain with the binding
 * owner; transport and Account cipher acquisition are supplied by the host. */
export async function readQualifiedConnectedAccountCredentialMaterial(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    getAccountEncryptionMode(signal?: AbortSignal): Promise<'plain' | 'e2ee' | 'unknown'>;
    readCredential(input: Readonly<{ ref: QualifiedConnectedAccountRef; signal?: AbortSignal }>): Promise<QualifiedConnectedAccountCredentialSnapshotV4 | null>;
    openCredentialContent(mode: 'plain' | 'e2ee', envelope: StoredJsonContentEnvelope): unknown | Promise<unknown>;
    secrets?: ConnectedAccountCredentialSecretReader;
    signal?: AbortSignal;
}>): Promise<QualifiedConnectedAccountCredentialMaterial | null> {
    assertNotAborted(input.signal);
    const accountMode = await input.getAccountEncryptionMode(input.signal);
    if (accountMode === 'unknown') {
        throw new QualifiedConnectedAccountMaterialError('account_encryption_mode_unavailable', 'Connected-account account mode is unavailable');
    }
    const snapshot = await input.readCredential({ ref: input.account, signal: input.signal });
    assertNotAborted(input.signal);
    if (!snapshot) return null;
    assertCredentialSnapshot(snapshot, input.account);
    const plaintext = await input.openCredentialContent(accountMode, snapshot.content);
    if (plaintext === null) {
        throw new QualifiedConnectedAccountMaterialError('credential_content_unavailable', 'Connected-account credential content is unavailable for the current account mode');
    }
    const credential = parseQualifiedConnectedAccountCredentialPlaintextV1({
        ref: input.account,
        authenticationModeId: snapshot.authenticationModeId,
        metadata: snapshot.metadata,
        plaintext,
    });
    if (Object.keys(credential.secretRefs ?? {}).length > 0 && !input.secrets) {
        throw new QualifiedConnectedAccountCredentialSecretUnavailableError();
    }
    const resolved = input.secrets
        ? (await resolveQualifiedConnectedAccountCredentialSecrets(credential, input.secrets, input.signal)).credential
        : credential;
    assertNotAborted(input.signal);
    return Object.freeze({ snapshot, credential: resolved, storageMode: accountMode });
}
