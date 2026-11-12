import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tests = dirname(fileURLToPath(import.meta.url));
const ios = resolve(tests, '../ios');
const fixture = resolve(tests, '../../../../../packages/protocol/src/crypto/fixtures/sessionMessageContentV1.json');

test('Swift native worker opens shared historical/current content and seals byte AES', { skip: process.platform !== 'darwin' }, () => {
  // Host libsodium is the same C API the app module imports through Clibsodium.
  const sodium = ['/opt/homebrew/opt/libsodium', '/usr/local/opt/libsodium'].find(path => existsSync(join(path, 'include/sodium.h')));
  assert.ok(sodium, 'installed native libsodium required; do not install it from this test');
  const work = mkdtempSync(join(tmpdir(), 'happier-content-codec-'));
  try {
    writeFileSync(join(work, 'module.modulemap'), `module Clibsodium { header "${sodium}/include/sodium.h" link "sodium" export * }\n`);
    const binary = join(work, 'content-tests');
    execFileSync('swiftc', ['-I', work, '-I', join(sodium, 'include'), '-L', join(sodium, 'lib'), '-lsodium', '-lz', '-o', binary,
      join(ios, 'HappierCryptoWorkerBase64.swift'), join(ios, 'HappierCryptoWorkerAesGcm.swift'),
      join(ios, 'HappierCryptoWorkerSecretbox.swift'), join(ios, 'HappierCryptoWorkerSessionCrypto.swift'),
      join(ios, 'HappierCryptoWorkerDataKeyEnvelope.swift'), join(tests, 'ContentCodecTests.swift')], { stdio: 'pipe' });
    assert.match(execFileSync(binary, [fixture, resolve(tests, '../../../../../packages/protocol/src/crypto/fixtures/contentInflateBoundsV1.json')], { encoding: 'utf8' }), /round trips passed/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
