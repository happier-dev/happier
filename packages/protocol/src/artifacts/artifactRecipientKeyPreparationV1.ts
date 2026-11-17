import { prepareVerifiedResourceRecipientEnvelopesV1, runResourceRecipientKeyPreparationV1 } from '../teams/resourceRecipientKeyPreparationV1.js';
import type {
  ArtifactAccessRecipientCensusResponseV1,
  ArtifactAccessGrantMutationResponseV1,
  ArtifactRecipientKeyEnvelopeInputV1,
  ArtifactRecipientKeyEnvelopeCommitInputV1,
  ArtifactRecipientKeyEnvelopeCommitResponseV1,
} from './artifactAccessV1.js';

/** Preparation cannot erase an acknowledged grant mutation or certify current content.
 * The ordinary fresh-read path retains all access/key checks and retries preparation. */
export async function completeArtifactAccessMutationPreparationV1(params: Readonly<{
  result: ArtifactAccessGrantMutationResponseV1;
  prepare: () => Promise<unknown>;
}>): Promise<ArtifactAccessGrantMutationResponseV1> {
  if (params.result.access === null) return params.result;
  try {
    await params.prepare();
    return params.result;
  } catch {
    return { ...params.result, preparation: { status: 'pending' } };
  }
}

/** Consumes an authorized audience; binding verification never grants access. */
export function prepareArtifactRecipientKeyEnvelopesV1(params: Readonly<{
  dataKey: Uint8Array;
  /** Independent owner/grant key; never included in public-share key custody. */
  provenanceDataKey?: Uint8Array | null;
  recipients: readonly ArtifactAccessRecipientCensusResponseV1['recipients'][number][];
  randomBytes: (length: number) => Uint8Array;
  /** Account transitions replace the resource key, invalidating even current wraps. */
  replaceExisting?: boolean;
}>): ArtifactRecipientKeyEnvelopeInputV1[] {
  return prepareVerifiedResourceRecipientEnvelopesV1(params, (recipient, current, seal) => {
    if (current && recipient.encryptedDataKey && (!params.provenanceDataKey || recipient.encryptedProvenanceDataKey)) return null;
    return {
      encryptedDataKey: current && recipient.encryptedDataKey ? recipient.encryptedDataKey : seal(params.dataKey),
      ...(params.provenanceDataKey ? { encryptedProvenanceDataKey: current && recipient.encryptedProvenanceDataKey
        ? recipient.encryptedProvenanceDataKey : seal(params.provenanceDataKey) } : {}),
    };
  });
}

/** Process-local census → verified seal → fenced commit, shared by key-holding hosts. */
export async function runArtifactRecipientKeyPreparationV1(params: Readonly<{
  artifactId: string;
  dataKey: Uint8Array | null;
  openedDataEncryptionKey: string | null;
  provenanceDataKey?: Uint8Array | null;
  openedProvenanceDataEncryptionKey?: string | null;
  randomBytes: (length: number) => Uint8Array;
  readCensus: () => Promise<ArtifactAccessRecipientCensusResponseV1>;
  commit: (input: ArtifactRecipientKeyEnvelopeCommitInputV1) => Promise<ArtifactRecipientKeyEnvelopeCommitResponseV1>;
  signal?: AbortSignal;
}>): Promise<ArtifactRecipientKeyEnvelopeCommitResponseV1> {
  return runResourceRecipientKeyPreparationV1<ArtifactAccessRecipientCensusResponseV1>({ ...params,
    validateIdentity: census => {
      if (census.artifactId !== params.artifactId) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
    },
    dataKeyChangedError: () => Object.assign(new Error('artifact_data_key_changed'), { code: 'artifact_data_key_changed' }),
    prepare: (input, census) => {
      if (params.provenanceDataKey && (!census.provenanceDataEncryptionKey || !census.callerProvenanceDataEncryptionKey
        || census.callerProvenanceDataEncryptionKey !== params.openedProvenanceDataEncryptionKey)) {
        throw Object.assign(new Error('artifact_data_key_changed'), { code: 'artifact_data_key_changed' });
      }
      return prepareArtifactRecipientKeyEnvelopesV1({ ...input, provenanceDataKey: params.provenanceDataKey, randomBytes: params.randomBytes });
    },
    commit: (input, census) => params.commit({ artifactId: params.artifactId, ...input,
      ...(census.provenanceDataEncryptionKey ? { expectedProvenanceDataEncryptionKey: census.provenanceDataEncryptionKey } : {}) }),
  });
}

/** An owned inventory row as the Artifact list projects it; a locked row carries no envelope. */
export type OwnedArtifactKeyRowV1 = Readonly<{
  id: string;
  ownerAccountId: string;
  access: string;
  encryptionMode?: 'plain' | 'e2ee';
  dataEncryptionKey?: string;
  provenanceDataEncryptionKey?: string | null;
}>;

/**
 * The owner's later-member repair, run on the Team-change wake. A Team or Group grant follows live
 * membership, so a member who joins later is owed an envelope only a keyholder can write. One owned
 * inventory, then the census → seal → commit above for each owned E2EE Artifact whose key opens.
 * The census decides the audience: outsiders and removed members get nothing new, and content is
 * never opened. One Artifact's refusal does not hold back the others; the first failure still
 * reaches the wake.
 */
export async function prepareOwnedArtifactRecipientKeysV1(params: Readonly<{
  ownerAccountId: string;
  readOwnedPage: (cursor: string | null) => Promise<Readonly<{ items: readonly OwnedArtifactKeyRowV1[]; nextCursor: string | null }>>;
  openKeys: (row: OwnedArtifactKeyRowV1) => Promise<Readonly<{ dataKey: Uint8Array; provenanceDataKey: Uint8Array | null }> | null>;
  randomBytes: (length: number) => Uint8Array;
  readCensus: (artifactId: string) => Promise<ArtifactAccessRecipientCensusResponseV1>;
  commit: (input: ArtifactRecipientKeyEnvelopeCommitInputV1) => Promise<ArtifactRecipientKeyEnvelopeCommitResponseV1>;
  signal?: AbortSignal;
}>): Promise<void> {
  let cursor: string | null = null;
  let firstFailure: unknown = null;
  do {
    params.signal?.throwIfAborted();
    const page = await params.readOwnedPage(cursor);
    for (const row of page.items) {
      const envelope = row.dataEncryptionKey;
      if (row.ownerAccountId !== params.ownerAccountId || row.access !== 'owner' || row.encryptionMode !== 'e2ee' || !envelope) continue;
      try {
        const keys = await params.openKeys(row);
        if (!keys) continue;
        await runArtifactRecipientKeyPreparationV1({ artifactId: row.id, dataKey: keys.dataKey, openedDataEncryptionKey: envelope,
          provenanceDataKey: keys.provenanceDataKey, openedProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null,
          randomBytes: params.randomBytes, readCensus: () => params.readCensus(row.id), commit: params.commit, signal: params.signal });
      } catch (error) {
        params.signal?.throwIfAborted();
        firstFailure ??= error;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  if (firstFailure) throw firstFailure;
}
