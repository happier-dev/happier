import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCliProxyApiPrebuiltExecutablePath } from './lib/cliproxyapi-managed-runtime-input.mjs';

const linuxX64 = { os: 'linux', arch: 'x64' };
const linuxArm64 = { os: 'linux', arch: 'arm64' };

test('resolveCliProxyApiPrebuiltExecutablePath allows one native matrix leaf to consume one signed wrapper', () => {
  assert.equal(
    resolveCliProxyApiPrebuiltExecutablePath({
      rawPath: '/tmp/happier-cliproxyapi-managed',
      targets: [linuxX64],
    }),
    '/tmp/happier-cliproxyapi-managed',
  );
});

test('resolveCliProxyApiPrebuiltExecutablePath rejects sharing one prebuilt wrapper across multiple targets', () => {
  assert.throws(
    () => resolveCliProxyApiPrebuiltExecutablePath({
      rawPath: '/tmp/happier-cliproxyapi-managed',
      targets: [linuxX64, linuxArm64],
    }),
    /exactly one CLI target/i,
  );
});
