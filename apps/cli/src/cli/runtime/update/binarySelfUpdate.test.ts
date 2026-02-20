import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { updateBinaryFromReleaseAssets, resolveCliBinaryAssetBundleFromReleaseAssets } from './binarySelfUpdate';

function b64(buf: Buffer) {
  return Buffer.from(buf).toString('base64');
}

function base64UrlToBuffer(value: string) {
  const s = String(value ?? '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(value ?? '').length / 4) * 4, '=');
  return Buffer.from(s, 'base64');
}

function createMinisignKeyPair(): Readonly<{ pubkeyFile: string; keyId: Buffer; privateKey: KeyObject }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const rawPublicKey = base64UrlToBuffer(jwk.x);

  const keyId = Buffer.from('0123456789abcdef', 'hex');
  const publicKeyBytes = Buffer.concat([Buffer.from('Ed'), keyId, rawPublicKey]);
  const pubkeyFile = `untrusted comment: minisign public key\n${b64(publicKeyBytes)}\n`;
  return { pubkeyFile, keyId, privateKey };
}

function signMinisignMessage(params: Readonly<{ message: Buffer; keyId: Buffer; privateKey: KeyObject }>) {
  const signature = sign(null, params.message, params.privateKey);
  const sigLineBytes = Buffer.concat([Buffer.from('Ed'), params.keyId, signature]);
  const trustedComment = 'trusted comment: test';
  const trustedSuffix = Buffer.from(trustedComment.slice('trusted comment: '.length), 'utf-8');
  const globalSignature = sign(null, Buffer.concat([signature, trustedSuffix]), params.privateKey);
  return [
    'untrusted comment: signature from happier test',
    b64(sigLineBytes),
    trustedComment,
    b64(globalSignature),
    '',
  ].join('\n');
}

function sha256Hex(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('binarySelfUpdate', () => {
  it('resolves the newest platform tarball from a rolling-tag asset list (last match wins)', () => {
    const assets = [
      { name: 'happier-v1.0.0-linux-x64.tar.gz', browser_download_url: 'https://example/old.tgz' },
      { name: 'checksums-happier-v1.0.0.txt', browser_download_url: 'https://example/old-checksums.txt' },
      { name: 'checksums-happier-v1.0.0.txt.minisig', browser_download_url: 'https://example/old-checksums.txt.minisig' },
      { name: 'happier-v1.0.1-linux-x64.tar.gz', browser_download_url: 'https://example/new.tgz' },
      { name: 'checksums-happier-v1.0.1.txt', browser_download_url: 'https://example/new-checksums.txt' },
      { name: 'checksums-happier-v1.0.1.txt.minisig', browser_download_url: 'https://example/new-checksums.txt.minisig' },
    ];

    const resolved = resolveCliBinaryAssetBundleFromReleaseAssets({
      assets,
      os: 'linux',
      arch: 'x64',
      preferVersion: null,
    });

    expect(resolved.version).toBe('1.0.1');
    expect(resolved.archive.name).toBe('happier-v1.0.1-linux-x64.tar.gz');
  });

  it('downloads + verifies + replaces the running binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-binary-update-'));
    try {
      const homeDir = join(root, 'home');
      const scratch = join(root, 'scratch');
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(scratch, { recursive: true });

      const targetBin = join(root, 'happier');
      writeFileSync(targetBin, 'old\n', 'utf8');
      chmodSync(targetBin, 0o755);

      const version = '9.9.9-preview.2';
      const stem = `happier-v${version}-linux-x64`;
      const artifactDir = join(scratch, stem);
      mkdirSync(artifactDir, { recursive: true });
      const embeddedBin = join(artifactDir, 'happier');
      writeFileSync(embeddedBin, 'new\n', 'utf8');
      chmodSync(embeddedBin, 0o755);

      const archiveName = `${stem}.tar.gz`;
      const archivePath = join(scratch, archiveName);
      const tarRes = spawnSync('tar', ['-czf', archivePath, '-C', scratch, stem], { encoding: 'utf8' });
      expect(tarRes.status).toBe(0);

      const archiveBytes = readFileSync(archivePath);
      const archiveSha = sha256Hex(archiveBytes);

      const { pubkeyFile, keyId, privateKey } = createMinisignKeyPair();
      const checksumsText = `${archiveSha}  ${archiveName}\n`;
      const sigFile = signMinisignMessage({ message: Buffer.from(checksumsText, 'utf-8'), keyId, privateKey });

      const archiveUrl = `data:application/octet-stream;base64,${archiveBytes.toString('base64')}`;
      const checksumsUrl = `data:text/plain,${encodeURIComponent(checksumsText)}`;
      const sigUrl = `data:text/plain,${encodeURIComponent(sigFile)}`;

      const assets = [
        { name: archiveName, browser_download_url: archiveUrl },
        { name: `checksums-happier-v${version}.txt`, browser_download_url: checksumsUrl },
        { name: `checksums-happier-v${version}.txt.minisig`, browser_download_url: sigUrl },
      ];

      await updateBinaryFromReleaseAssets({
        assets,
        os: 'linux',
        arch: 'x64',
        execPath: targetBin,
        minisignPubkeyFile: pubkeyFile,
        preferVersion: null,
      });

      expect(readFileSync(targetBin, 'utf8')).toBe('new\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
