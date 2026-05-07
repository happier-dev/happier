import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyMinisign } from './minisignVerification.js';

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function base64UrlToBytes(value: unknown): Buffer {
  const s = String(value ?? '')
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(String(value ?? '').length / 4) * 4, '=');
  return Buffer.from(s, 'base64');
}

function createMinisignFixture(message: string): Readonly<{
  pubkeyFile: string;
  sigFile: string;
}> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublicKey = base64UrlToBytes(jwk.x);
  const keyId = Buffer.from('0123456789abcdef', 'hex');
  const publicKeyBytes = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);
  const signature = sign(null, Buffer.from(message, 'utf-8'), privateKey);
  const trustedComment = 'trusted comment: happier cli-common test';
  const trustedSuffix = Buffer.from(trustedComment.slice('trusted comment: '.length), 'utf-8');
  const globalSignature = sign(null, Buffer.concat([signature, trustedSuffix]), privateKey);
  return {
    pubkeyFile: `untrusted comment: minisign public key\n${b64(publicKeyBytes)}\n`,
    sigFile: [
      'untrusted comment: signature from happier test',
      b64(Buffer.concat([Buffer.from('Ed'), keyId, signature])),
      trustedComment,
      b64(globalSignature),
      '',
    ].join('\n'),
  };
}

describe('browser-safe minisign verification', () => {
  it('validates minisign Ed25519 signatures without Node crypto at runtime', () => {
    const message = 'verified checksums';
    const fixture = createMinisignFixture(message);

    expect(verifyMinisign({
      message,
      pubkeyFile: fixture.pubkeyFile,
      sigFile: fixture.sigFile,
    })).toBe(true);
    expect(verifyMinisign({
      message: 'tampered',
      pubkeyFile: fixture.pubkeyFile,
      sigFile: fixture.sigFile,
    })).toBe(false);
  });
});
