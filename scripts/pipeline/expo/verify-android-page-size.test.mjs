import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { androidElfFixture } from './fixtures/android-elf.mjs';
import { verifyAndroidPageSize } from './verify-android-page-size.mjs';

function bundle(t, { alignment = '16k', packaging = 2, extraModule = false, bytes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-page-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'base/lib/arm64-v8a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'base/lib/arm64-v8a/libfixture.so'), bytes ?? androidElfFixture(alignment));
  fs.writeFileSync(path.join(dir, 'BundleConfig.pb'), Buffer.from([18, 6, 18, 4, 8, 1, 16, packaging]));
  if (extraModule) {
    fs.mkdirSync(path.join(dir, 'voice/lib/arm64-v8a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'voice/lib/arm64-v8a/libvoice.so'), androidElfFixture('4k'));
  }
  const aabPath = path.join(dir, 'fixture.aab');
  execFileSync('zip', ['-qr', aabPath, 'base', 'BundleConfig.pb', ...(extraModule ? ['voice'] : [])], { cwd: dir });
  return aabPath;
}

test('verifies real compiled ELF LOAD segments and the APK page alignment requested by the AAB', (t) => {
  const result = verifyAndroidPageSize({ aabPath: bundle(t) });
  assert.equal(result.packaging, 2);
  assert.equal(result.libraries.length, 1);
  assert.ok(result.libraries[0].alignments.every((alignment) => alignment >= 16384));
});

test('rejects a real 4KB library even when only an additional feature module contains it', (t) => {
  assert.throws(() => verifyAndroidPageSize({ aabPath: bundle(t, { extraModule: true }) }), /voice\/lib\/arm64-v8a\/libvoice.so: LOAD alignment 4096/u);
});

test('rejects 4KB APK packaging even when all ELF libraries are aligned', (t) => {
  assert.throws(() => verifyAndroidPageSize({ aabPath: bundle(t, { packaging: 1 }) }), /PAGE_ALIGNMENT_16K/u);
});

test('fails closed on malformed or truncated ELF rather than skipping a library', (t) => {
  for (const bytes of [Buffer.from('invalid'), androidElfFixture().subarray(0, 128)]) {
    assert.throws(() => verifyAndroidPageSize({ aabPath: bundle(t, { bytes }) }), /Android 16KB page-size verification failed/u);
  }
});
