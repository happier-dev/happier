import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../crypto/base64.js';
import { signAccountContentKeyBindingV1 } from '../crypto/accountContentKeyBindingV1.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/contentPublicKeyFingerprint.js';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import { decodeBase64 } from '../crypto/base64.js';
import { prepareArtifactRecipientKeyEnvelopesV1, runArtifactRecipientKeyPreparationV1 } from './artifactRecipientKeyPreparationV1.js';
import type { ArtifactAccessRecipientCensusResponseV1 } from './artifactAccessV1.js';

describe('Artifact key-holder preparation', () => {
  it('prepares missing and rotated recipient keys while retaining current envelopes and withholding unavailable bindings', () => {
    const signingSecret = randomBytes(32);
    const signingPublic = ed25519.getPublicKey(signingSecret);
    const contentSecret = randomBytes(32);
    const contentPublic = x25519.getPublicKey(contentSecret);
    const fingerprint = computeContentPublicKeyFingerprint(contentPublic);
    const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic });
    const contentKey = { status: 'available' as const, accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(contentPublic), contentPublicKeySignature: encodeBase64(signature) };
    const base = { contentKey, contentPublicKeyFingerprint: fingerprint, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null };
    const dataKey = randomBytes(32);
    const existingEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: contentPublic, randomBytes }));
    const result = prepareArtifactRecipientKeyEnvelopesV1({ dataKey, randomBytes, recipients: [
      { ...base, recipientAccountId: 'missing' },
      { ...base, recipientAccountId: 'rotated', encryptedDataKey: existingEnvelope, recipientContentPublicKeyFingerprint: `content-public-key-sha256:${'0'.repeat(64)}` },
      { ...base, recipientAccountId: 'current', encryptedDataKey: existingEnvelope, recipientContentPublicKeyFingerprint: fingerprint },
      { ...base, recipientAccountId: 'plain', contentKey: { status: 'unavailable', reason: 'plain_account' } },
      { ...base, recipientAccountId: 'unverified', contentKey: { ...contentKey, contentPublicKeySignature: encodeBase64(new Uint8Array(64)) } },
    ] });
    expect(result.map((row) => row.recipientAccountId)).toEqual(['missing', 'rotated']);
    for (const row of result) {
      expect(row.recipientContentPublicKeyFingerprint).toBe(fingerprint);
      expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(row.encryptedDataKey), recipientSecretKeyOrSeed: contentSecret })).toEqual(new Uint8Array(dataKey));
    }
    const replacementKey = randomBytes(32);
    const replacement = prepareArtifactRecipientKeyEnvelopesV1({ dataKey: replacementKey, randomBytes,
      replaceExisting: true, recipients: [{ ...base, recipientAccountId: 'current', encryptedDataKey: existingEnvelope,
        recipientContentPublicKeyFingerprint: fingerprint }] });
    expect(replacement.map(row => row.recipientAccountId)).toEqual(['current']);
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(replacement[0]!.encryptedDataKey),
      recipientSecretKeyOrSeed: contentSecret })).toEqual(new Uint8Array(replacementKey));

    // Existing content grants still need the independent private revision key.
    const provenanceDataKey = randomBytes(32);
    const privatePreparation = prepareArtifactRecipientKeyEnvelopesV1({ dataKey, provenanceDataKey, randomBytes,
      recipients: [{ ...base, recipientAccountId: 'current', encryptedDataKey: existingEnvelope,
        recipientContentPublicKeyFingerprint: fingerprint }] });
    expect(privatePreparation.map(row => row.recipientAccountId)).toEqual(['current']);
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(privatePreparation[0]!.encryptedProvenanceDataKey!),
      recipientSecretKeyOrSeed: contentSecret })).toEqual(new Uint8Array(provenanceDataKey));
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(privatePreparation[0]!.encryptedDataKey),
      recipientSecretKeyOrSeed: contentSecret })).toEqual(new Uint8Array(dataKey));
  });

  it('never commits a key opened from an earlier caller envelope after the resource key changed', async () => {
    let committed = false;
    await expect(runArtifactRecipientKeyPreparationV1({
      artifactId: 'artifact', dataKey: randomBytes(32), openedDataEncryptionKey: 'old-caller-envelope', randomBytes,
      readCensus: async () => ({ artifactId: 'artifact', ownerAccountId: 'owner', access: 'edit', encryptionMode: 'e2ee',
        dataEncryptionKey: 'new-owner-envelope', callerDataEncryptionKey: 'new-caller-envelope', recipients: [] }),
      commit: async () => { committed = true; return { appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] }; },
    })).rejects.toMatchObject({ code: 'artifact_data_key_changed' });
    expect(committed).toBe(false);
  });

  it('never reseals the owner and does not commit when every grantee envelope is current', async () => {
    const signingSecret = randomBytes(32);
    const signingPublic = ed25519.getPublicKey(signingSecret);
    const contentPublic = x25519.getPublicKey(randomBytes(32));
    const fingerprint = computeContentPublicKeyFingerprint(contentPublic);
    const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic });
    const recipient = { contentKey: { status: 'available' as const, accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(contentPublic), contentPublicKeySignature: encodeBase64(signature) },
      contentPublicKeyFingerprint: fingerprint, encryptedDataKey: null, recipientContentPublicKeyFingerprint: null };
    const dataKey = randomBytes(32);
    const currentEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: contentPublic, randomBytes }));
    let preparedIds: string[] = [];
    let commits = 0;
    const census: ArtifactAccessRecipientCensusResponseV1 = { artifactId: 'artifact', ownerAccountId: 'owner', access: 'edit', encryptionMode: 'e2ee',
      dataEncryptionKey: 'owner-envelope', callerDataEncryptionKey: 'caller-envelope', recipients: [
        { ...recipient, recipientAccountId: 'owner' },
        { ...recipient, recipientAccountId: 'peer' },
      ] };
    const params = { artifactId: 'artifact', dataKey, openedDataEncryptionKey: 'caller-envelope', randomBytes,
      readCensus: async () => census,
      commit: async (input: { recipientKeyEnvelopes: readonly { recipientAccountId: string }[] }) => {
        commits += 1;
        preparedIds = input.recipientKeyEnvelopes.map((row) => row.recipientAccountId);
        return { appliedRecipientAccountIds: preparedIds, skippedRecipientAccountIds: [] };
      } };
    await runArtifactRecipientKeyPreparationV1(params);
    expect(preparedIds).toEqual(['peer']);
    expect(commits).toBe(1);
    census.recipients[1] = { ...recipient, recipientAccountId: 'peer', encryptedDataKey: currentEnvelope,
      recipientContentPublicKeyFingerprint: fingerprint };
    preparedIds = [];
    await expect(runArtifactRecipientKeyPreparationV1(params)).resolves.toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] });
    expect(preparedIds).toEqual([]);
    expect(commits).toBe(1);
  });

  it('does no key work for a plain resource', async () => {
    let committed = false;
    await expect(runArtifactRecipientKeyPreparationV1({
      artifactId: 'artifact', dataKey: null, openedDataEncryptionKey: null, randomBytes,
      readCensus: async () => ({ artifactId: 'artifact', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] }),
      commit: async () => { committed = true; return { appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] }; },
    })).resolves.toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] });
    expect(committed).toBe(false);
  });

  it('keeps content preparation usable while the private grant key is not delivered, but rejects stale private preparation', async () => {
    let committed = false;
    const params = { artifactId: 'artifact', dataKey: randomBytes(32), openedDataEncryptionKey: 'caller-envelope', randomBytes,
      readCensus: async (): Promise<ArtifactAccessRecipientCensusResponseV1> => ({ artifactId: 'artifact', ownerAccountId: 'owner', access: 'edit', encryptionMode: 'e2ee',
        dataEncryptionKey: 'owner-envelope', callerDataEncryptionKey: 'caller-envelope', provenanceDataEncryptionKey: 'private-owner-envelope',
        callerProvenanceDataEncryptionKey: null, recipients: [] }),
      commit: async () => { committed = true; return { appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] }; } };
    await expect(runArtifactRecipientKeyPreparationV1(params)).resolves.toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] });
    await expect(runArtifactRecipientKeyPreparationV1({ ...params, provenanceDataKey: randomBytes(32),
      openedProvenanceDataEncryptionKey: 'stale-private-envelope' })).rejects.toMatchObject({ code: 'artifact_data_key_changed' });
    expect(committed).toBe(false);
  });
});
