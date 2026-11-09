import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { signAccountContentKeyBindingV1 } from '../crypto/accountContentKeyBindingV1.js';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/contentPublicKeyFingerprint.js';
import { ResourceAccessRecipientCensusV1Schema, ResourceRecipientKeyEnvelopeCommitInputV1Schema } from './resourceGrantAccessV1.js';
import { runResourceRecipientKeyPreparationV1, summarizeResourceRecipientReadinessV1 } from './resourceRecipientKeyPreparationV1.js';
import { AccountRecipientEnvelopeUnavailableReasonSchema } from '../account/encryptionMode.js';
import { TaskRecipientReadinessV1Schema } from '../todos/taskResourceV1.js';

// Counting wrapper over the real verifier: signature checks per open are the cost contract.
const verification = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../crypto/accountContentKeyBindingV1.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../crypto/accountContentKeyBindingV1.js')>();
  return { ...actual, verifyAccountContentKeyBindingV1: (input: Parameters<typeof actual.verifyAccountContentKeyBindingV1>[0]) => {
    verification.calls += 1;
    return actual.verifyAccountContentKeyBindingV1(input);
  } };
});

function fixture() {
  const signingSecret = randomBytes(32), signingPublic = ed25519.getPublicKey(signingSecret);
  const contentSecret = randomBytes(32), contentPublic = x25519.getPublicKey(contentSecret);
  const dataKey = randomBytes(32);
  const ownerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: contentPublic, randomBytes }));
  const recipient = { recipientAccountId: 'peer',
    contentKey: { status: 'available' as const, accountSigningPublicKey: bytesToHex(signingPublic),
      contentPublicKey: encodeBase64(contentPublic), contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
        accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic,
      })) },
    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublic),
    encryptedDataKey: null, recipientContentPublicKeyFingerprint: null };
  const census = { ...ResourceAccessRecipientCensusV1Schema.parse({ ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
    dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope,
    recipients: [{ ...recipient, recipientAccountId: 'owner' }, recipient],
  }), discussionId: 'discussion' };
  return { dataKey, contentSecret, ownerEnvelope, census };
}

describe('shared resource key-holder preparation', () => {
  beforeEach(() => { verification.calls = 0; });

  it('verifies no recipient key on an unchanged open and exactly the new recipient on a membership advance', async () => {
    const { dataKey, ownerEnvelope, census } = fixture();
    const peer = census.recipients.find(recipient => recipient.recipientAccountId === 'peer')!;
    const current = Array.from({ length: 20 }, (_, index) => ({ ...peer, recipientAccountId: `current-${index}`,
      encryptedDataKey: ownerEnvelope, recipientContentPublicKeyFingerprint: peer.contentPublicKeyFingerprint }));
    const run = async (recipients: typeof census.recipients) => {
      const committed: string[] = [];
      await runResourceRecipientKeyPreparationV1({ dataKey, openedDataEncryptionKey: ownerEnvelope, randomBytes,
        readCensus: async () => ({ ...census, recipients }), validateIdentity: () => {},
        commit: async input => {
          committed.push(...input.recipientKeyEnvelopes.map(row => row.recipientAccountId));
          return { appliedRecipientAccountIds: committed, skippedRecipientAccountIds: [] };
        } });
      return committed;
    };
    await expect(run(current)).resolves.toEqual([]);
    expect(verification.calls).toBe(0);
    await expect(run([...current, peer])).resolves.toEqual(['peer']);
    expect(verification.calls).toBe(1);
  });

  it('never seals to a recipient key whose binding does not verify', async () => {
    const { dataKey, ownerEnvelope, census } = fixture();
    const peer = census.recipients.find(recipient => recipient.recipientAccountId === 'peer')!;
    if (peer.contentKey.status !== 'available') throw new Error('Expected an available key');
    const forged = { ...peer, contentKey: { ...peer.contentKey, contentPublicKeySignature: encodeBase64(new Uint8Array(64)) } };
    await expect(runResourceRecipientKeyPreparationV1({ dataKey, openedDataEncryptionKey: ownerEnvelope, randomBytes,
      readCensus: async () => ({ ...census, recipients: [forged] }), validateIdentity: () => {},
      commit: async () => { throw new Error('A forged binding must not commit'); },
    })).resolves.toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] });
  });

  it('summarizes projected recipient facts without collapsing mixed collective readiness', () => {
    const { census, ownerEnvelope } = fixture();
    const peer = census.recipients.find(recipient => recipient.recipientAccountId === 'peer')!;
    const recipients = ResourceAccessRecipientCensusV1Schema.shape.recipients.parse([
      { ...peer, recipientAccountId: 'ready', encryptedDataKey: ownerEnvelope,
        recipientContentPublicKeyFingerprint: peer.contentPublicKeyFingerprint },
      { ...peer, recipientAccountId: 'pending' },
      ...AccountRecipientEnvelopeUnavailableReasonSchema.options.map(reason => ({
        recipientAccountId: reason, contentKey: { status: 'unavailable', reason }, contentPublicKeyFingerprint: null,
        encryptedDataKey: null, recipientContentPublicKeyFingerprint: null,
      })),
    ]);
    expect(TaskRecipientReadinessV1Schema.parse(summarizeResourceRecipientReadinessV1('e2ee', recipients))).toEqual({ readyCount: 1, pendingCount: 1,
      unavailableCounts: { plain_account: 1, encryption_setup_required: 1, encryption_inconsistent: 1 } });
    expect(TaskRecipientReadinessV1Schema.parse(summarizeResourceRecipientReadinessV1('plain', recipients))).toEqual({ readyCount: recipients.length, pendingCount: 0,
      unavailableCounts: { plain_account: 0, encryption_setup_required: 0, encryption_inconsistent: 0 } });
  });
  it('seals the exact Discussion key for verified grantees and commits the captured owner-key fence', async () => {
    const { dataKey, contentSecret, ownerEnvelope, census } = fixture();
    const result = await runResourceRecipientKeyPreparationV1({ dataKey, openedDataEncryptionKey: ownerEnvelope, randomBytes,
      readCensus: async () => census,
      validateIdentity: current => { expect(current.discussionId).toBe('discussion'); },
      commit: async input => {
        expect(ResourceRecipientKeyEnvelopeCommitInputV1Schema.parse(input)).toEqual(input);
        expect(input.expectedDataEncryptionKey).toBe(ownerEnvelope);
        expect(input.recipientKeyEnvelopes.map(row => row.recipientAccountId)).toEqual(['peer']);
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.recipientKeyEnvelopes[0]!.encryptedDataKey),
          recipientSecretKeyOrSeed: contentSecret })).toEqual(new Uint8Array(dataKey));
        return { appliedRecipientAccountIds: ['peer'], skippedRecipientAccountIds: [] };
      },
    });
    expect(result).toEqual({ appliedRecipientAccountIds: ['peer'], skippedRecipientAccountIds: [] });
  });

  it('refuses stale caller custody and cancellation before any commit', async () => {
    const { dataKey, ownerEnvelope, census } = fixture();
    let committed = false;
    const params = { dataKey, openedDataEncryptionKey: ownerEnvelope, randomBytes,
      readCensus: async () => census, validateIdentity: () => {},
      commit: async () => { committed = true; return { appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] }; } };
    await expect(runResourceRecipientKeyPreparationV1({ ...params, openedDataEncryptionKey: 'previous-envelope' }))
      .rejects.toMatchObject({ code: 'resource_data_key_changed' });
    const controller = new AbortController();
    await expect(runResourceRecipientKeyPreparationV1({ ...params, signal: controller.signal,
      readCensus: async () => { controller.abort(); return census; } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(committed).toBe(false);
  });
});
