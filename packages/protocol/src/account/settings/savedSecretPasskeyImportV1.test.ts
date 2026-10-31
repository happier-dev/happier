import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSavedSecretPasskeyImportV1 } from './savedSecretPasskeyImportV1.js';

const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  .export({ format: 'der', type: 'pkcs8' }).toString('base64');
const credential = {
  credentialId: 'Y3JlZGVudGlhbA==', isResidentCredential: true, rpId: 'login.example',
  privateKey, userHandle: 'dXNlcg==', signCount: 7, backupEligibility: true, backupState: false,
  userName: 'person', userDisplayName: 'Person',
};
const parse = (value: unknown) => parseSavedSecretPasskeyImportV1({ format: 'chromium-cdp', value });

describe('Saved Secret passkey export ingestion', () => {
  it('preserves native exported key bytes, identity, backup flags and counter without modifying the export', () => {
    const before = structuredClone(credential);
    expect(parse(credential)).toEqual({ status: 'ready', source: {
      kind: 'passkey', rpId: credential.rpId, credentialId: credential.credentialId,
      userHandle: credential.userHandle, privateKey, algorithm: -7, signCount: 7,
      backupEligibility: true, backupState: false, userName: 'person', userDisplayName: 'Person',
    } });
    expect(credential).toEqual(before);
    expect(parse({ ...credential, signCount: 0, backupEligibility: false })).toMatchObject({
      status: 'ready', source: { signCount: 0, backupEligibility: false, backupState: false },
    });
    expect(parse({ ...credential, signCount: -1 })).toMatchObject({ status: 'ready', source: { signCount: 0 } });
  });
  it.each([
    { ...credential, backupEligibility: undefined }, { ...credential, backupState: undefined },
    { ...credential, isResidentCredential: false },
    { ...credential, largeBlob: 'YmxvYg==' }, { ...credential, cmtgKeys: ['a2V5'] },
  ])('refuses source facts the destination cannot preserve', value => {
    expect(parse(value)).toEqual({ status: 'source_format_unsupported' });
  });
  it.each([
    null, { ...credential, privateKey: 'secret-sentinel!' },
    { ...credential, credentialId: 'YQ' }, { ...credential, rpId: 'login.example/path' },
    { ...credential, backupEligibility: false, backupState: true },
    { ...credential, signCount: 1.5 }, { ...credential, futureSecretExtension: 'secret-sentinel' },
  ])('returns a closed invalid result without echoing private input', value => {
    expect(parse(value)).toEqual({ status: 'input_invalid' });
  });
  it('does not reinterpret assertions or CXF passkeys as complete native exports', () => {
    expect(parse({ id: 'credential', response: { signature: 'signature' } })).toEqual({ status: 'input_invalid' });
    expect(parseSavedSecretPasskeyImportV1({ format: 'cxf', value: {
      type: 'passkey', rpId: 'login.example', key: privateKey,
    } })).toEqual({ status: 'source_format_unsupported' });
  });
});
