import { hexToBytes } from '@noble/hashes/utils';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { verifyAccountContentKeyBindingV1 } from '../crypto/accountContentKeyBindingV1.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import type {
  ArtifactAccessRecipientCensusResponseV1,
  ArtifactRecipientKeyEnvelopeInputV1,
  ArtifactRecipientKeyEnvelopeCommitInputV1,
  ArtifactRecipientKeyEnvelopeCommitResponseV1,
} from './artifactAccessV1.js';

/** Consumes an authorized audience; binding verification never grants access. */
export function prepareArtifactRecipientKeyEnvelopesV1(params: Readonly<{
  dataKey: Uint8Array;
  /** Independent owner/grant key; never included in public-share key custody. */
  provenanceDataKey?: Uint8Array | null;
  recipients: ArtifactAccessRecipientCensusResponseV1['recipients'];
  randomBytes: (length: number) => Uint8Array;
  /** Account transitions replace the resource key, invalidating even current wraps. */
  replaceExisting?: boolean;
}>): ArtifactRecipientKeyEnvelopeInputV1[] {
  const prepared: ArtifactRecipientKeyEnvelopeInputV1[] = [];
  for (const recipient of params.recipients) {
    if (recipient.contentKey.status !== 'available') continue;
    let verified: ReturnType<typeof verifyAccountContentKeyBindingV1>;
    try {
      verified = verifyAccountContentKeyBindingV1({
        accountSigningPublicKey: hexToBytes(recipient.contentKey.accountSigningPublicKey),
        contentPublicKey: decodeBase64(recipient.contentKey.contentPublicKey),
        signature: decodeBase64(recipient.contentKey.contentPublicKeySignature),
      });
    } catch { continue; }
    if (!verified || verified.contentPublicKeyFingerprint !== recipient.contentPublicKeyFingerprint) continue;
    const current = !params.replaceExisting && recipient.recipientContentPublicKeyFingerprint === verified.contentPublicKeyFingerprint;
    if (current && recipient.encryptedDataKey && (!params.provenanceDataKey || recipient.encryptedProvenanceDataKey)) continue;
    prepared.push({ recipientAccountId: recipient.recipientAccountId,
      encryptedDataKey: current && recipient.encryptedDataKey ? recipient.encryptedDataKey : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: params.dataKey,
        recipientPublicKey: verified.contentPublicKey, randomBytes: params.randomBytes })),
      ...(params.provenanceDataKey ? { encryptedProvenanceDataKey: current && recipient.encryptedProvenanceDataKey
        ? recipient.encryptedProvenanceDataKey : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: params.provenanceDataKey,
          recipientPublicKey: verified.contentPublicKey, randomBytes: params.randomBytes })) } : {}),
      recipientContentPublicKeyFingerprint: verified.contentPublicKeyFingerprint });
  }
  return prepared;
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
  params.signal?.throwIfAborted();
  const census = await params.readCensus();
  params.signal?.throwIfAborted();
  if (census.artifactId !== params.artifactId) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
  const empty = { appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] };
  if (census.encryptionMode === 'plain' || !params.dataKey) return empty;
  if (!census.dataEncryptionKey || !census.callerDataEncryptionKey
    || census.callerDataEncryptionKey !== params.openedDataEncryptionKey) {
    throw Object.assign(new Error('artifact_data_key_changed'), { code: 'artifact_data_key_changed' });
  }
  if (params.provenanceDataKey && (!census.provenanceDataEncryptionKey || !census.callerProvenanceDataEncryptionKey
    || census.callerProvenanceDataEncryptionKey !== params.openedProvenanceDataEncryptionKey)) {
    throw Object.assign(new Error('artifact_data_key_changed'), { code: 'artifact_data_key_changed' });
  }
  const recipientKeyEnvelopes = prepareArtifactRecipientKeyEnvelopesV1({ dataKey: params.dataKey,
    provenanceDataKey: params.provenanceDataKey,
    recipients: census.recipients.filter((recipient) => recipient.recipientAccountId !== census.ownerAccountId),
    randomBytes: params.randomBytes });
  if (!recipientKeyEnvelopes.length) return empty;
  params.signal?.throwIfAborted();
  return params.commit({ artifactId: params.artifactId, expectedDataEncryptionKey: census.dataEncryptionKey,
    ...(census.provenanceDataEncryptionKey ? { expectedProvenanceDataEncryptionKey: census.provenanceDataEncryptionKey } : {}),
    recipientKeyEnvelopes });
}
