import test from 'node:test';
import assert from 'node:assert/strict';

import { createCanonicalFingerprintFromExpoFingerprint } from './canonical-fingerprint.mjs';

test('canonical Expo fingerprint excludes generated native artifacts but keeps package source entries', () => {
  const raw = {
    hash: 'raw-hash',
    sources: [
      { type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'] },
      { type: 'dir', filePath: 'android', reasons: ['bareNativeDir'] },
      {
        type: 'file',
        filePath: 'node_modules/@more-tech/react-native-libsodium/package.json',
        hash: 'stable-package-hash',
      },
      {
        type: 'file',
        filePath: 'node_modules/@more-tech/react-native-libsodium/libsodium/build/config.log',
        hash: 'volatile-build-hash',
      },
      {
        type: 'file',
        filePath: 'node_modules/react-native-enriched-markdown/android/generated/source.java',
        hash: 'volatile-enriched-hash',
      },
      {
        type: 'file',
        filePath: 'node_modules/react-native-unistyles/nitrogen/generated/Spec.cpp',
        hash: 'volatile-unistyles-hash',
      },
    ],
  };

  const canonical = createCanonicalFingerprintFromExpoFingerprint(raw);
  const paths = canonical.sources.map((source) => source.filePath ?? source.id ?? '');

  assert.deepEqual(paths, ['node_modules/@more-tech/react-native-libsodium/package.json']);
});

test('canonical Expo fingerprint recomputes the hash after filtering volatile sources', () => {
  const raw = {
    sources: [
      { type: 'file', filePath: 'stable-a', hash: 'a' },
      { type: 'file', filePath: 'node_modules/react-native-unistyles/nitrogen/generated/Spec.cpp', hash: 'volatile' },
      { type: 'contents', id: 'stable-b', hash: 'b' },
    ],
  };

  const canonical = createCanonicalFingerprintFromExpoFingerprint(raw);

  assert.notEqual(canonical.hash, raw.hash);
  assert.equal(canonical.sources.length, 2);
  assert.match(canonical.hash, /^[a-f0-9]{40}$/);
});
