import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadVerifiedReleaseAssetBundle } from '../dist/verifiedDownload.js';

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

function createMinisignKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublicKey = base64UrlToBuffer(jwk.x);
  assert.equal(rawPublicKey.length, 32);

  const keyId = Buffer.from('0123456789abcdef', 'hex');
  const publicKeyBytes = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);
  const pubkeyFile = `untrusted comment: minisign public key\n${b64(publicKeyBytes)}\n`;
  return { pubkeyFile, keyId, privateKey };
}

function signMinisignMessage({ message, keyId, privateKey }) {
  const signature = sign(null, message, privateKey);
  const sigLineBytes = Buffer.concat([Buffer.from('Ed'), keyId, signature]);
  const trustedComment = 'trusted comment: test';
  const trustedSuffix = Buffer.from(trustedComment.slice('trusted comment: '.length), 'utf-8');
  const globalSignature = sign(null, Buffer.concat([signature, trustedSuffix]), privateKey);
  return [
    'untrusted comment: signature from happier test',
    b64(sigLineBytes),
    trustedComment,
    b64(globalSignature),
    '',
  ].join('\n');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('downloadVerifiedReleaseAssetBundle downloads archive and verifies checksums + signature', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happier-release-runtime-verified-'));
  try {
    const { pubkeyFile, keyId, privateKey } = createMinisignKeyPair();
    const archiveName = 'happier-server-v1.2.3-preview.1-linux-x64.tar.gz';
    const archiveBytes = Buffer.from('hello archive', 'utf-8');
    const archiveSha = sha256Hex(archiveBytes);

    const checksumsText = `${archiveSha} ${archiveName}\n`;
    const sigFile = signMinisignMessage({
      message: Buffer.from(checksumsText, 'utf-8'),
      keyId,
      privateKey,
    });

    const archiveUrl = `data:application/octet-stream;base64,${archiveBytes.toString('base64')}`;
    const checksumsUrl = `data:text/plain,${encodeURIComponent(checksumsText)}`;
    const sigUrl = `data:text/plain,${encodeURIComponent(sigFile)}`;

    const bundle = {
      version: '1.2.3-preview.1',
      archive: { name: archiveName, url: archiveUrl },
      checksums: { name: `checksums-happier-server-v1.2.3-preview.1.txt`, url: checksumsUrl },
      checksumsSig: { name: `checksums-happier-server-v1.2.3-preview.1.txt.minisig`, url: sigUrl },
    };

    const result = await downloadVerifiedReleaseAssetBundle({
      bundle,
      destDir: tmp,
      pubkeyFile,
    });

    assert.equal(result.version, '1.2.3-preview.1');
    assert.equal(result.archiveName, archiveName);
    assert.ok(result.archivePath.endsWith(archiveName));
    const downloaded = await readFile(result.archivePath);
    assert.equal(downloaded.toString('utf-8'), archiveBytes.toString('utf-8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('downloadVerifiedReleaseAssetBundle rejects checksum mismatches', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happier-release-runtime-verified-bad-'));
  try {
    const { pubkeyFile, keyId, privateKey } = createMinisignKeyPair();
    const archiveName = 'happier-server-v1.2.3-linux-x64.tar.gz';
    const archiveBytes = Buffer.from('hello archive', 'utf-8');
    const checksumsText = `${'0'.repeat(64)} ${archiveName}\n`;
    const sigFile = signMinisignMessage({
      message: Buffer.from(checksumsText, 'utf-8'),
      keyId,
      privateKey,
    });

    const bundle = {
      version: '1.2.3',
      archive: { name: archiveName, url: `data:application/octet-stream;base64,${archiveBytes.toString('base64')}` },
      checksums: { name: `checksums-happier-server-v1.2.3.txt`, url: `data:text/plain,${encodeURIComponent(checksumsText)}` },
      checksumsSig: { name: `checksums-happier-server-v1.2.3.txt.minisig`, url: `data:text/plain,${encodeURIComponent(sigFile)}` },
    };

    await assert.rejects(
      () => downloadVerifiedReleaseAssetBundle({ bundle, destDir: tmp, pubkeyFile }),
      /checksum/i,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

