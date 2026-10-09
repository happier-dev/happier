import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readAndroidAabMetadata } from './read-android-aab-metadata.mjs';

// Fixture follows Android AAPT2 Resources.proto, XmlNode field 1 / XmlElement
// fields 3+4 / XmlAttribute fields 1+2+3+6 / Item field 7 / Primitive field 6.
// https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-16.0.0_r1/tools/aapt2/Resources.proto
function varint(input) {
  let value = BigInt(input);
  const bytes = [];
  while (value > 127n) { bytes.push(Number(value & 127n) | 128); value >>= 7n; }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}
function field(number, value) {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function attribute(name, value, compiled) {
  return field(4, Buffer.concat([
    ...(name === 'package' ? [] : [field(1, 'http://schemas.android.com/apk/res/android')]),
    field(2, name), ...(value ? [field(3, value)] : []), ...(compiled ? [field(6, compiled)] : []),
  ]));
}
export function manifest({ compiled = false, rawVersionCode = '', packageName = 'dev.happier.app', appVersion = '1.2.3', versionCode = '4242' } = {}) {
  const numeric = Buffer.concat([varint(6 * 8), varint(versionCode)]);
  return field(1, Buffer.concat([
    field(3, 'manifest'), attribute('package', packageName),
    attribute('versionCode', compiled ? rawVersionCode : versionCode, compiled ? field(7, numeric) : undefined),
    attribute('versionName', compiled ? '' : appVersion, compiled ? field(2, field(1, appVersion)) : undefined),
  ]));
}
export function archiveFixture(t, bytes = manifest()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aab-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'base', 'manifest'), { recursive: true });
  writeFileSync(path.join(dir, 'base', 'manifest', 'AndroidManifest.xml'), bytes);
  const aabPath = path.join(dir, 'fixture.aab');
  execFileSync('zip', ['-q', aabPath, 'base/manifest/AndroidManifest.xml'], { cwd: dir });
  return aabPath;
}

test('reads identity from actual ZIP protobuf manifest in raw and compiled AAPT2 representations', (t) => {
  for (const compiled of [false, true]) {
    const aabPath = archiveFixture(t, manifest({ compiled }));
    assert.deepEqual(readAndroidAabMetadata({ aabPath }), { packageName: 'dev.happier.app', appVersion: '1.2.3', versionCode: '4242' });
  }
});

test('the compiled Android version takes precedence over raw source attribute text', (t) => {
  const aabPath = archiveFixture(t, manifest({ compiled: true, rawVersionCode: '41', versionCode: '4242' }));
  assert.equal(readAndroidAabMetadata({ aabPath }).versionCode, '4242');
});

test('fails closed on missing or malformed archive identity', (t) => {
  for (const bytes of [Buffer.from([10, 127]), field(1, field(3, 'manifest')), manifest({ versionCode: '0' })]) {
    assert.throws(() => readAndroidAabMetadata({ aabPath: archiveFixture(t, bytes) }), /exact Android package\/version identity/);
  }
});
