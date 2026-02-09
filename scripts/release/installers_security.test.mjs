import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sourceRoot = join(repoRoot, 'scripts', 'release', 'installers');
const installShPath = join(sourceRoot, 'install.sh');
const selfHostShPath = join(sourceRoot, 'self-host.sh');
const installPs1Path = join(sourceRoot, 'install.ps1');
const publicKeyPath = join(sourceRoot, 'happier-release.pub');

test('release-owned installer scripts enforce minisign verification defaults', async () => {
  const installSh = await readFile(installShPath, 'utf8');
  const selfHostSh = await readFile(selfHostShPath, 'utf8');
  const publicKey = (await readFile(publicKeyPath, 'utf8')).trim();
  const publicKeyLines = publicKey.split('\n').map((line) => line.trim()).filter(Boolean);
  const publicKeyPayload = publicKeyLines.at(-1) ?? '';

  assert.match(installSh, /HAPPIER_MINISIGN_PUBKEY_URL/);
  assert.match(installSh, /https:\/\/happier\.dev\/happier-release\.pub/);
  assert.match(installSh, /Signature verified\./);
  assert.doesNotMatch(installSh, /skipped signature verification/i);
  assert.ok(publicKeyPayload.length > 10);
  assert.ok(installSh.includes(publicKeyPayload), 'install.sh should embed the release minisign public key payload');

  assert.match(selfHostSh, /HAPPIER_MINISIGN_PUBKEY_URL/);
  assert.match(selfHostSh, /https:\/\/happier\.dev\/happier-release\.pub/);
  assert.match(selfHostSh, /Signature verified\./);
  assert.doesNotMatch(selfHostSh, /skipped signature verification/i);
  assert.ok(selfHostSh.includes(publicKeyPayload), 'self-host.sh should embed the release minisign public key payload');
});

test('release-owned windows installer enforces minisign verification defaults', async () => {
  const installPs1 = await readFile(installPs1Path, 'utf8');
  const publicKey = (await readFile(publicKeyPath, 'utf8')).trim();
  const publicKeyLines = publicKey.split('\n').map((line) => line.trim()).filter(Boolean);
  const publicKeyPayload = publicKeyLines.at(-1) ?? '';
  assert.match(installPs1, /HAPPIER_MINISIGN_PUBKEY_URL/);
  assert.match(installPs1, /https:\/\/happier\.dev\/happier-release\.pub/);
  assert.match(installPs1, /Signature verified\./);
  assert.doesNotMatch(installPs1, /skip.*signature/i);
  assert.ok(publicKeyPayload.length > 10);
  assert.ok(installPs1.includes(publicKeyPayload), 'install.ps1 should embed the release minisign public key payload');
});

test('release-owned minisign public key exists', async () => {
  const publicKey = await readFile(publicKeyPath, 'utf8');
  assert.match(publicKey, /minisign public key/i);
  assert.match(publicKey, /^RWQ/m);
});
