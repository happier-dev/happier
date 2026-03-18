import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { installCompanionCliFromBundle } from './install_companion_cli.mjs';

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
    'untrusted comment: signature from happier stack test',
    b64(sigLineBytes),
    trustedComment,
    b64(globalSignature),
    '',
  ].join('\n');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('installCompanionCliFromBundle promotes the full CLI payload with shared installer logic', async (t) => {
  if (process.platform === 'win32') {
    t.skip('tar-based bundle test does not run on windows');
    return;
  }
  if (spawnSync('bash', ['-lc', 'command -v tar >/dev/null 2>&1'], { stdio: 'ignore' }).status !== 0) {
    t.skip('tar is required for bundle installation test');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happier-self-host-companion-cli-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const staging = join(tmp, 'staging');
  const rootName = 'happier-v1.2.3-preview.1-darwin-arm64';
  const rootDir = join(staging, rootName);
  await mkdir(join(rootDir, 'package-dist'), { recursive: true });
  await writeFile(join(rootDir, 'package-dist', 'index.mjs'), 'console.log("ok");\n', 'utf-8');
  const binaryPath = join(rootDir, 'happier');
  await writeFile(binaryPath, '#!/bin/sh\necho happier\n', 'utf-8');
  spawnSync('bash', ['-lc', `chmod +x "${binaryPath.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });

  const archiveName = `${rootName}.tar.gz`;
  const archivePath = join(tmp, archiveName);
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', staging, rootName], { encoding: 'utf-8' });
  assert.equal(tar.status, 0, tar.stderr || tar.stdout);

  const archiveBytes = await readFile(archivePath);
  const checksumsText = `${sha256Hex(archiveBytes)} ${archiveName}\n`;
  const { pubkeyFile, keyId, privateKey } = createMinisignKeyPair();
  const sigFile = signMinisignMessage({
    message: Buffer.from(checksumsText, 'utf-8'),
    keyId,
    privateKey,
  });

  const bundle = {
    version: '1.2.3-preview.1',
    archive: { name: archiveName, url: `data:application/octet-stream;base64,${archiveBytes.toString('base64')}` },
    checksums: { name: 'checksums-happier-v1.2.3-preview.1.txt', url: `data:text/plain,${encodeURIComponent(checksumsText)}` },
    checksumsSig: { name: 'checksums-happier-v1.2.3-preview.1.txt.minisig', url: `data:text/plain,${encodeURIComponent(sigFile)}` },
  };

  const homeDir = join(tmp, 'home');
  const result = await installCompanionCliFromBundle({
    bundle,
    processEnv: {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
    },
    pubkeyFile,
  });

  assert.equal(result.installed, true);
  assert.equal(result.version, '1.2.3-preview.1');
  assert.equal(existsSync(join(homeDir, 'cli', 'current', 'package-dist', 'index.mjs')), true);
  assert.equal(existsSync(join(homeDir, 'cli', 'previous')), false);
  const installedEntrypoint = await readFile(join(homeDir, 'cli', 'current', 'package-dist', 'index.mjs'), 'utf-8');
  assert.match(installedEntrypoint, /console\.log\("ok"\)/);
  assert.equal(existsSync(join(homeDir, 'bin', 'happier')), true);
  assert.equal(existsSync(join(homeDir, 'cli', 'current', 'happier')), true);
  assert.equal(existsSync(dirname(join(homeDir, 'cli', 'versions', '1.2.3-preview.1'))), true);
});
