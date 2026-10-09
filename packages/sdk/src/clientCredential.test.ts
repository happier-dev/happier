import { describe, expect, it } from 'vitest';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { createClientCredential } from './clientCredential.js';

const context = {
  serverIdentityId: 'srv_sdk',
  accountId: 'account-1',
  tokenId: '123e4567-e89b-42d3-a456-426614174000',
  contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=',
};
const wrappingSecret = new Uint8Array(32).fill(7);
const contentPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
const token = formatAccountApiTokenCredentialV1({
  bearer,
  wrappingSecret: encodeBase64(wrappingSecret, 'base64url'),
  serverIdentityId: context.serverIdentityId,
  accountId: context.accountId,
  contentPublicKey: context.contentPublicKey,
});
const encryptionAccess = wrapApiTokenEncryptionAccessV1({
  context,
  wrappingSecret,
  contentPrivateKey,
  randomBytes: (length) => new Uint8Array(length).fill(3),
});

describe('SDK API-token credential lifetime', () => {
  it('refreshes shared material per invocation while retaining immutable Runner material', async () => {
    const credential = createClientCredential(token);
    let sharedReads = 0;
    const shared = () => Promise.resolve({ kind: 'machine' as const,
      material: { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(++sharedReads) } });
    const first = await credential.encryption!.getMachineMaterial('machine:alice', shared);
    const second = await credential.encryption!.getMachineMaterial('machine:alice', shared);
    expect(sharedReads).toBe(2);
    expect(first).not.toEqual(second);
    let runnerReads = 0;
    const runner = () => Promise.resolve({ kind: 'runner' as const,
      material: { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(++runnerReads) } });
    await credential.encryption!.getMachineMaterial('machine:runner', runner);
    await credential.encryption!.getMachineMaterial('machine:runner', runner);
    expect(runnerReads).toBe(1);
    credential.dispose();
    if (first.kind === 'machine' && second.kind === 'machine') {
      expect(first.material.machineKey).toEqual(new Uint8Array(32));
      expect(second.material.machineKey).toEqual(new Uint8Array(32));
    }
  });

  it('sees a new sharing grant after a previously unlisted target used Account sealing', async () => {
    const credential = createClientCredential(token);
    let granted = false;
    const resolve = () => Promise.resolve({ kind: granted ? 'machine' as const : 'account' as const,
      material: { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(granted ? 23 : 17) } });
    expect((await credential.encryption!.getMachineMaterial('machine:alice', resolve)).kind).toBe('account');
    granted = true;
    expect((await credential.encryption!.getMachineMaterial('machine:alice', resolve)).kind).toBe('machine');
    credential.dispose();
  });
  it('zeros opened content material and fails closed after disposal', async () => {
    const credential = createClientCredential(token);
    const material = await credential.encryption!.getMaterial(async () => ({
      v: 1, accountId: context.accountId, tokenId: context.tokenId, encryptionAccess,
    }));
    expect(material.machineKey).toEqual(contentPrivateKey);
    credential.dispose();
    expect(material.machineKey).toEqual(new Uint8Array(32));
    await expect(credential.encryption!.getMaterial(async () => {
      throw new Error('Disposed credentials must not retrieve material');
    })).rejects.toMatchObject({
      name: 'HappierClientClosedError',
    });
  });
});
