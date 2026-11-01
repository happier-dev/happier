import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createSessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from './encryption';
import { materializeSessionAccessGrantEnvelope } from './sessionAccessGrantEnvelopeHost';

const homeUrl = 'https://share-home.test';
const sessionKey = new Uint8Array(32).fill(71);
const holder = tweetnacl.box.keyPair();
const credentials = { token: 'token', encryption: { type: 'dataKey' as const, publicKey: holder.publicKey, machineKey: holder.secretKey } };
const teamGrant = { sessionId: 'shared-session', subject: { kind: 'team', teamId: 'team-1' }, accessLevel: 'view', canApprovePermissions: false };
const directGrant = { sessionId: 'shared-session', subject: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view', canApprovePermissions: false };
const recipient = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
/** Another resource's key (a Saved Secret, Workflow or Machine) the Home can name as this Session's. */
const foreignResourceKey = new Uint8Array(32).fill(0x5a);
const unrelatedCiphertext = encodeBase64(encrypt(new Uint8Array(32).fill(1), 'dataKey', { v: 1 }));

/** The Home's HTTP surface is the boundary; the metadata tuple owner stays real beneath it. */
function serveSession(overrides: Readonly<{
  encryptionMode?: 'e2ee' | 'plain'; envelopeRecipient?: Uint8Array; patchStatus?: number;
  /** The key the Home names in the caller's envelope, and the metadata it serves with it. */
  servedKey?: Uint8Array; metadata?: string; metadataLayoutVersion?: 0 | 1;
}> = {}) {
  const opened = createSessionOwnerMetadataV1({ metadata: { path: '/work', host: 'holder' } });
  if (!opened.ok) throw new Error('Expected owner metadata fixture');
  const metadataLayoutVersion = overrides.metadataLayoutVersion ?? 1;
  const session = { id: 'shared-session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
    encryptionMode: overrides.encryptionMode ?? 'e2ee', metadataLayoutVersion, metadataVersion: 1, share: null,
    metadata: overrides.metadata ?? encodeBase64(encrypt(sessionKey, 'dataKey', { v: 1 })), agentState: null, agentStateVersion: 0,
    // Layout-0 rows carry no owner envelope.
    ...(metadataLayoutVersion === 1 ? { ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
      material: { type: 'dataKey', machineKey: holder.secretKey }, ownerMetadata: opened.ownerMetadata, randomBytes: getRandomBytes }) } : {}),
    dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: overrides.servedKey ?? sessionKey,
      recipientPublicKey: overrides.envelopeRecipient ?? holder.publicKey, randomBytes: getRandomBytes })) };
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    const { pathname } = new URL(url);
    if (pathname === '/v2/sessions/shared-session') return { status: 200, data: { session } };
    if (pathname === '/v1/user/recipient') return { status: 200, data: { user: { id: 'recipient', firstName: 'R', lastName: null,
      avatar: null, username: 'recipient', bio: null, badges: [], status: 'none', recipientEnvelopeReadiness: { status: 'available' },
      publicKey: Buffer.from(recipient.signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(recipient.content.publicKey),
      contentPublicKeySig: encodeBase64(signAccountContentKeyBindingV1({
        accountSigningSecretKey: recipient.signing.secretKey, contentPublicKey: recipient.content.publicKey })) } } };
    if (pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'e2ee', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    return { status: 404, data: {} };
  });
  return vi.spyOn(axios, 'patch').mockImplementation(async () => ({
    status: overrides.patchStatus ?? 200,
    data: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 } },
  }));
}

const materializeTeamGrant = () => materializeSessionAccessGrantEnvelope({
  token: 'token', credentials, serverHttpBaseUrl: homeUrl, input: teamGrant,
});
const materializeDirectGrant = () => materializeSessionAccessGrantEnvelope({
  token: 'token', credentials, serverHttpBaseUrl: homeUrl, input: directGrant,
});
const openedByRecipient = (input: unknown) => {
  const envelope = (input as { accountEnvelopeInput?: { encryptedDataKey: string } }).accountEnvelopeInput;
  return envelope ? openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64(envelope.encryptedDataKey), recipientSecretKeyOrSeed: recipient.content.secretKey }) : null;
};

describe('materializeSessionAccessGrantEnvelope direct grant key binding', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('seals the Session key that opens this Session\'s shared metadata to the recipient', async () => {
    serveSession();
    const result = await materializeDirectGrant();
    expect(result.retainedEnvelopeFallback).toBe(false);
    expect(openedByRecipient(result.input)).toEqual(sessionKey);
  });

  it.each([
    ['another resource\'s key with metadata it cannot open', { servedKey: foreignResourceKey, metadata: unrelatedCiphertext }],
    ['another resource\'s key with its own non-Session content', { servedKey: foreignResourceKey,
      metadata: encodeBase64(encrypt(foreignResourceKey, 'dataKey', { host: 'alice', platform: 'linux' })) }],
    ['the Session key under the legacy layout, which proves nothing', { metadataLayoutVersion: 0 as const }],
  ])('seals no key to the recipient when the Home serves %s', async (_case, overrides) => {
    serveSession(overrides);
    const result = await materializeDirectGrant();
    expect(result.input).not.toHaveProperty('accountEnvelopeInput');
    expect(result.retainedEnvelopeFallback).toBe(true);
  });

  it('names the layout update as the repair for a legacy-layout Session', async () => {
    serveSession({ metadataLayoutVersion: 0 });
    await expect(materializeDirectGrant()).resolves.toMatchObject({ repairActionId: 'session.access.layout.update' });
  });
});

describe('materializeSessionAccessGrantEnvelope Team share statement', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('seals the statement into the Session metadata with the Session key before the grant is sent', async () => {
    const patch = serveSession();
    await expect(materializeTeamGrant()).resolves.toMatchObject({ input: teamGrant, retainedEnvelopeFallback: false });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![0]).toBe(`${homeUrl}/v2/sessions/shared-session`);
    const body = patch.mock.calls[0]![1] as Readonly<{ sharedMetadata: Readonly<{ ciphertext: string }> }>;
    expect(decrypt(sessionKey, 'dataKey', decodeBase64(body.sharedMetadata.ciphertext)))
      .toMatchObject({ teamShareStatementV1: { v: 1, teamIds: ['team-1'] } });
  });

  it.each([
    ['a Plain Session', { encryptionMode: 'plain' as const }],
    ['a manager whose device cannot open the Session key', { envelopeRecipient: tweetnacl.box.keyPair().publicKey }],
    ['another resource\'s key the Home names as the Session key', { servedKey: foreignResourceKey,
      metadata: encodeBase64(encrypt(foreignResourceKey, 'dataKey', { host: 'alice', platform: 'linux' })) }],
  ])('writes nothing for %s and keeps the key-free share', async (_case, overrides) => {
    const patch = serveSession(overrides);
    await expect(materializeTeamGrant()).resolves.toMatchObject({ input: teamGrant, retainedEnvelopeFallback: false });
    expect(patch).not.toHaveBeenCalled();
  });

  it('keeps the share working when the statement cannot be written', async () => {
    serveSession({ patchStatus: 403 });
    await expect(materializeTeamGrant()).resolves.toMatchObject({ input: teamGrant, retainedEnvelopeFallback: false });
  });
});
