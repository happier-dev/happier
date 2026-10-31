import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MINISIGN_PUBLIC_KEY,
  lookupSha256,
  resolveVerifiedReleaseArtifactDigest,
  sha256HexOfBytes,
  verifyMinisign,
  verifyReleaseArtifactBytes,
  verifyReleaseArtifactDigest,
} from '../dist/releaseArtifactVerification.js';
import {
  CHECKSUMS_TEXT,
  PUBLIC_KEY_FILE,
  RELEASE_ARTIFACT_NAME,
  RELEASE_ARTIFACT_SHA256,
  RELEASE_ARTIFACT_TEXT,
  SIGNATURE_FILE_ED,
  SIGNATURE_FILE_PREHASHED,
  UNRELATED_PUBLIC_KEY_FILE,
  replaceSignatureLine,
} from './fixtures/minisignVectors.mjs';

const ARTIFACT_BYTES = new TextEncoder().encode(RELEASE_ARTIFACT_TEXT);

const baseParams = Object.freeze({
  artifactName: RELEASE_ARTIFACT_NAME,
  artifactBytes: ARTIFACT_BYTES,
  checksumsText: CHECKSUMS_TEXT,
  checksumsSignatureFile: SIGNATURE_FILE_ED,
  minisignPublicKeyFile: PUBLIC_KEY_FILE,
});

test('the narrow cross-runtime entry exposes the whole verification decision', () => {
  assert.equal(typeof verifyReleaseArtifactBytes, 'function');
  assert.equal(typeof sha256HexOfBytes, 'function');
  assert.equal(typeof verifyMinisign, 'function');
  assert.equal(typeof lookupSha256, 'function');
  assert.match(DEFAULT_MINISIGN_PUBLIC_KEY, /^RW/m);
});

test('sha256HexOfBytes matches the platform digest', () => {
  assert.equal(sha256HexOfBytes(ARTIFACT_BYTES), RELEASE_ARTIFACT_SHA256);
  assert.equal(sha256HexOfBytes(ARTIFACT_BYTES), createHash('sha256').update(ARTIFACT_BYTES).digest('hex'));
  assert.equal(sha256HexOfBytes(new Uint8Array()), createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
});

test('a signed checksums file plus a matching artifact digest verifies', () => {
  assert.deepEqual(verifyReleaseArtifactBytes(baseParams), {
    ok: true,
    artifactName: RELEASE_ARTIFACT_NAME,
    sha256: RELEASE_ARTIFACT_SHA256,
  });
});

test('the signed checksum identity carries exact Runner archive bounds', () => {
  const metadata = { sizeBytes: 17, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 11, mode: 0o755 }] };
  const checksumsText = `${RELEASE_ARTIFACT_SHA256}  ${RELEASE_ARTIFACT_NAME}\n# happier-artifact-v1 ${JSON.stringify({ name: RELEASE_ARTIFACT_NAME, ...metadata })}\n`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.alloc(8, 3);
  const signature = sign(null, Buffer.from(checksumsText), privateKey);
  const trustedComment = Buffer.from('runner archive metadata');
  const checksumsSignatureFile = [
    'untrusted comment: fixture',
    Buffer.concat([Buffer.from('Ed'), keyId, signature]).toString('base64'),
    `trusted comment: ${trustedComment.toString()}`,
    sign(null, Buffer.concat([signature, trustedComment]), privateKey).toString('base64'),
  ].join('\n');
  const minisignPublicKeyFile = `untrusted comment: fixture\n${Buffer.concat([
    Buffer.from('Ed'), keyId, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
  ]).toString('base64')}`;

  assert.deepEqual(resolveVerifiedReleaseArtifactDigest({
    artifactName: RELEASE_ARTIFACT_NAME,
    checksumsText,
    checksumsSignatureFile,
    minisignPublicKeyFile,
  }), { ok: true, artifactName: RELEASE_ARTIFACT_NAME, sha256: RELEASE_ARTIFACT_SHA256, archiveMetadata: metadata });
});

test('the prehashed ED checksums signature verifies through the same decision', () => {
  assert.deepEqual(
    verifyReleaseArtifactBytes({ ...baseParams, checksumsSignatureFile: SIGNATURE_FILE_PREHASHED }),
    { ok: true, artifactName: RELEASE_ARTIFACT_NAME, sha256: RELEASE_ARTIFACT_SHA256 },
  );
});

test('an unrelated signing key fails closed before any digest is trusted', () => {
  assert.deepEqual(
    verifyReleaseArtifactBytes({ ...baseParams, minisignPublicKeyFile: UNRELATED_PUBLIC_KEY_FILE }),
    { ok: false, reason: 'checksums_signature_invalid' },
  );
});

test('a tampered checksums file fails closed even when the artifact matches it', () => {
  const tamperedSha256 = sha256HexOfBytes(new TextEncoder().encode('attacker payload'));
  const tamperedChecksums = `${tamperedSha256}  ${RELEASE_ARTIFACT_NAME}\n`;
  assert.deepEqual(
    verifyReleaseArtifactBytes({
      ...baseParams,
      artifactBytes: new TextEncoder().encode('attacker payload'),
      checksumsText: tamperedChecksums,
    }),
    { ok: false, reason: 'checksums_signature_invalid' },
  );
});

test('a tampered signature file fails closed', () => {
  assert.deepEqual(
    verifyReleaseArtifactBytes({
      ...baseParams,
      checksumsSignatureFile: replaceSignatureLine(SIGNATURE_FILE_ED, 2, 'trusted comment: attacker supplied'),
    }),
    { ok: false, reason: 'checksums_signature_invalid' },
  );
});

test('a missing checksums entry fails closed with the requested artifact name', () => {
  assert.deepEqual(
    verifyReleaseArtifactBytes({ ...baseParams, artifactName: 'happier-runner-v0.3.0-windows-x64.zip' }),
    { ok: false, reason: 'checksum_entry_missing', artifactName: 'happier-runner-v0.3.0-windows-x64.zip' },
  );
});

test('a mismatched artifact digest fails closed and reports both digests', () => {
  const substituted = new TextEncoder().encode('substituted runner bytes');
  assert.deepEqual(verifyReleaseArtifactBytes({ ...baseParams, artifactBytes: substituted }), {
    ok: false,
    reason: 'artifact_digest_mismatch',
    artifactName: RELEASE_ARTIFACT_NAME,
    expectedSha256: RELEASE_ARTIFACT_SHA256,
    actualSha256: sha256HexOfBytes(substituted),
  });
});

test('an injected platform digest owns byte hashing but never the trust decision', () => {
  const computed = [];
  const result = verifyReleaseArtifactBytes({
    ...baseParams,
    computeSha256Hex: (bytes) => {
      computed.push(bytes.length);
      return createHash('sha256').update(bytes).digest('hex');
    },
  });
  assert.deepEqual(result, { ok: true, artifactName: RELEASE_ARTIFACT_NAME, sha256: RELEASE_ARTIFACT_SHA256 });
  assert.deepEqual(computed, [ARTIFACT_BYTES.length]);

  assert.deepEqual(
    verifyReleaseArtifactBytes({
      ...baseParams,
      computeSha256Hex: () => `${'0'.repeat(63)}1`,
    }),
    {
      ok: false,
      reason: 'artifact_digest_mismatch',
      artifactName: RELEASE_ARTIFACT_NAME,
      expectedSha256: RELEASE_ARTIFACT_SHA256,
      actualSha256: `${'0'.repeat(63)}1`,
    },
  );
});

test('hexadecimal digest casing never decides the outcome', () => {
  assert.deepEqual(
    verifyReleaseArtifactBytes({ ...baseParams, computeSha256Hex: () => RELEASE_ARTIFACT_SHA256.toUpperCase() }),
    { ok: true, artifactName: RELEASE_ARTIFACT_NAME, sha256: RELEASE_ARTIFACT_SHA256 },
  );
});

test('the cross-runtime verification closure never imports a Node builtin', () => {
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const visited = new Set();
  const pending = ['releaseArtifactVerification.js'];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    visited.add(relative);
    const source = readFileSync(resolve(distDir, relative), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/(^|[\s;])\/\/[^\n]*/gu, '$1');
    assert.equal(
      /from\s*['"]node:|require\(\s*['"]node:|['"]node:[a-z/]+['"]/u.test(source),
      false,
      `${relative} must not import a Node builtin`,
    );
    assert.equal(/\bBuffer\b/u.test(source), false, `${relative} must not depend on the Node Buffer global`);
    for (const match of source.matchAll(/from\s*['"](\.[^'"]+)['"]/gu)) {
      pending.push(match[1].replace(/^\.\//u, ''));
    }
  }
  assert.ok(visited.size >= 3, `expected the verification closure to be walked, saw ${[...visited].join(', ')}`);
});

const digest = 'a'.repeat(64);
test('streamed platform hashes use the same artifact digest decision', () => {
  assert.deepEqual(verifyReleaseArtifactDigest({
    artifactName: 'runner.zip', expectedSha256: digest, actualSha256: digest.toUpperCase(),
  }), { ok: true, artifactName: 'runner.zip', sha256: digest });
  assert.equal(verifyReleaseArtifactDigest({
    artifactName: 'runner.zip', expectedSha256: digest, actualSha256: 'b'.repeat(64),
  }).ok, false);
});

test('empty or malformed platform hashes cannot verify', () => {
  for (const invalidDigest of ['', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    assert.equal(verifyReleaseArtifactDigest({
      artifactName: 'runner.zip', expectedSha256: invalidDigest, actualSha256: invalidDigest,
    }).ok, false);
  }
});
