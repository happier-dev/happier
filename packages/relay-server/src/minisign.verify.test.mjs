import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { verifyMinisign } from '@happier-dev/release-runtime/minisign';

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

function base64UrlToBuffer(value) {
  const s = String(value ?? '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(value ?? '').length / 4) * 4, '=');
  return Buffer.from(s, 'base64');
}

test('verifyMinisign validates Ed25519 minisign signatures (Ed)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublicKey = base64UrlToBuffer(jwk.x);
  assert.equal(rawPublicKey.length, 32);

  const keyId = Buffer.from('0123456789abcdef', 'hex'); // 8 bytes
  const publicKeyBytes = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);

  const pubkeyFile = `untrusted comment: minisign public key\n${b64(publicKeyBytes)}\n`;

  const message = Buffer.from('hello from happier', 'utf-8');
  const signature = sign(null, message, privateKey);
  assert.equal(signature.length, 64);

  const sigLineBytes = Buffer.concat([Buffer.from('Ed'), keyId, signature]);
  const trustedComment = 'trusted comment: test';
  const trustedSuffix = Buffer.from(trustedComment.slice('trusted comment: '.length), 'utf-8');
  const globalSignature = sign(null, Buffer.concat([signature, trustedSuffix]), privateKey);
  assert.equal(globalSignature.length, 64);

  const sigFile = [
    'untrusted comment: signature from happier test',
    b64(sigLineBytes),
    trustedComment,
    b64(globalSignature),
    '',
  ].join('\n');

  assert.equal(verifyMinisign({ message, pubkeyFile, sigFile }), true);
});

test('verifyMinisign rejects invalid signatures', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublicKey = base64UrlToBuffer(jwk.x);
  const keyId = Buffer.from('0123456789abcdef', 'hex');
  const publicKeyBytes = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);
  const pubkeyFile = `untrusted comment: minisign public key\n${b64(publicKeyBytes)}\n`;

  const message = Buffer.from('hello', 'utf-8');
  const signature = sign(null, message, privateKey);
  const sigLineBytes = Buffer.concat([Buffer.from('Ed'), keyId, signature]);
  const trustedComment = 'trusted comment: test';
  const trustedSuffix = Buffer.from(trustedComment.slice('trusted comment: '.length), 'utf-8');
  const globalSignature = sign(null, Buffer.concat([signature, trustedSuffix]), privateKey);
  const sigFile = [
    'untrusted comment: sig',
    b64(sigLineBytes),
    trustedComment,
    b64(globalSignature),
    '',
  ].join('\n');

  assert.equal(verifyMinisign({ message: Buffer.from('tampered', 'utf-8'), pubkeyFile, sigFile }), false);
});
