import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { decodeBase64, encodeBase64, encrypt, getRandomBytes } from '@/api/encryption';
import { addSessionInitialAccessTeamShareStatement, prepareSessionInitialAccessDataKeyEnvelopes } from './sessionCreationInitialAccess';

const holder = tweetnacl.box.keyPair();
const credentials = { token: 'token', encryption: { type: 'dataKey' as const, publicKey: holder.publicKey, machineKey: holder.secretKey } };
const sessionKey = new Uint8Array(32).fill(41);
/** The returned row as the Home serves it; its key envelope and metadata are the Home's claim. */
const returnedRow = (servedKey: Uint8Array | null, metadata: string, metadataLayoutVersion = 1) => ({
  id: 'created', metadataLayoutVersion, metadata,
  dataEncryptionKey: servedKey
    ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: servedKey, recipientPublicKey: holder.publicKey, randomBytes: getRandomBytes }))
    : null,
});

describe('Session creation Team share statement', () => {
  const grants = [
    { subject: { kind: 'team' as const, teamId: 'team-a' }, accessLevel: 'view' as const, canApprovePermissions: false },
    { subject: { kind: 'group' as const, teamId: 'team-b', groupId: 'group' }, accessLevel: 'view' as const, canApprovePermissions: false },
    { subject: { kind: 'account' as const, accountId: 'direct' }, accessLevel: 'view' as const, canApprovePermissions: false },
  ];

  it('states every collective audience of an E2EE create', () => {
    expect(addSessionInitialAccessTeamShareStatement({ path: '/work' }, { primaryTeamId: 'team-a', initialAccess: { grants } }, 'e2ee'))
      .toEqual({ path: '/work', teamShareStatementV1: { v: 1, teamIds: ['team-a', 'team-b'] } });
  });

  it.each([
    ['Plain', { initialAccess: { grants } }, 'plain'],
    ['private E2EE', {}, 'e2ee'],
  ] as const)('states nothing for a %s create', (_case, fields, mode) => {
    expect(addSessionInitialAccessTeamShareStatement({ path: '/work' }, fields, mode)).toEqual({ path: '/work' });
  });
});

describe('Session envelope scope refusal', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it.each([
    { payload: { error: 'credential_scope_denied' }, code: 'credential_scope_denied' },
    { payload: { error: 'credential_scope_denied', details: {} }, code: 'not_authenticated' },
  ])('preserves only a strict scope refusal: $code', async ({ payload, code }) => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 403, data: payload });
    await expect(prepareSessionInitialAccessDataKeyEnvelopes({
      fields: { initialAccess: { grants: [{ subject: { kind: 'team', teamId: 'team' }, accessLevel: 'view', canApprovePermissions: false }] } },
      sessionId: 'same', sessionEncryptionMode: 'e2ee', credentials,
      session: returnedRow(sessionKey, encodeBase64(encrypt(sessionKey, 'dataKey', { v: 1 }))),
      token: 'token', serverHttpBaseUrl: 'http://envelopes.test',
    })).rejects.toMatchObject({ code, status: 403 });
  });
});

describe('Session creation recipient pass key binding', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const member = { content: tweetnacl.box.keyPair(), signing: tweetnacl.sign.keyPair() };
  const owedPage = { status: 'required', summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, nextCursor: null,
    items: [{ recipientAccountId: 'member', envelopeState: 'missing', contentKey: { status: 'available',
      accountSigningPublicKey: Buffer.from(member.signing.publicKey).toString('hex'), contentPublicKey: encodeBase64(member.content.publicKey),
      contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
        accountSigningSecretKey: member.signing.secretKey, contentPublicKey: member.content.publicKey })) } }] };
  const runPass = (session: ReturnType<typeof returnedRow>) => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: owedPage });
    const sealed: string[] = [];
    vi.spyOn(axios, 'patch').mockImplementation(async (_url: string, body: unknown) => {
      sealed.push(...(body as { entries: Array<{ encryptedDataKey: string }> }).entries.map(entry => entry.encryptedDataKey));
      return { status: 200, data: { appliedCount: sealed.length } };
    });
    const result = prepareSessionInitialAccessDataKeyEnvelopes({ fields: { primaryTeamId: 'team-1' }, sessionId: 'created',
      sessionEncryptionMode: 'e2ee', credentials, session, token: 'token', serverHttpBaseUrl: 'http://envelopes.test' });
    return { result, sealed: () => sealed.map(envelope => openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(envelope), recipientSecretKeyOrSeed: member.content.secretKey })) };
  };

  it('seals the returned Session key that opens its shared metadata to the Team member', async () => {
    const pass = runPass(returnedRow(sessionKey, encodeBase64(encrypt(sessionKey, 'dataKey', { v: 1 }))));
    await pass.result;
    expect(pass.sealed()).toEqual([sessionKey]);
  });

  const foreignResourceKey = new Uint8Array(32).fill(0x5a);
  it.each([
    ['another resource\'s key with metadata it cannot open', returnedRow(foreignResourceKey,
      encodeBase64(encrypt(new Uint8Array(32).fill(1), 'dataKey', { v: 1 })))],
    ['another resource\'s key with its own non-Session content', returnedRow(foreignResourceKey,
      encodeBase64(encrypt(foreignResourceKey, 'dataKey', { host: 'alice', platform: 'linux' })))],
    ['no key envelope, which must not fall back to Account key material', returnedRow(null,
      encodeBase64(encrypt(holder.secretKey, 'dataKey', { v: 1 })))],
  ])('seals no key when the create response carries %s', async (_case, session) => {
    const pass = runPass(session);
    await expect(pass.result).rejects.toMatchObject({ code: 'session_data_key_unavailable' });
    expect(pass.sealed()).toEqual([]);
  });
});
