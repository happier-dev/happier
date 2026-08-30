import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LINUX_HOST_GRAPHICS_LIBRARY_PATTERNS,
  isLinuxHostGraphicsLibrary,
  isLinuxDesktopPackage,
  validateLinuxPackageMetadata,
} from './linux-desktop-artifact-policy.mjs';

test('Linux AppImage policy identifies host graphics libraries that must not be bundled', () => {
  assert.deepEqual(LINUX_HOST_GRAPHICS_LIBRARY_PATTERNS, [
    'libwayland-client.so',
    'libwayland-cursor.so',
    'libwayland-egl.so',
    'libwayland-server.so',
  ]);
  assert.equal(isLinuxHostGraphicsLibrary('usr/lib/libwayland-client.so.0'), true);
  assert.equal(isLinuxHostGraphicsLibrary('usr/lib/libwebkit2gtk-4.1.so.0'), false);
});

test('Linux desktop package policy accepts only native deb/rpm packages', () => {
  assert.equal(isLinuxDesktopPackage('happier-ui-desktop-linux-x86_64.deb'), true);
  assert.equal(isLinuxDesktopPackage('happier-ui-desktop-linux-x86_64.rpm'), true);
  assert.equal(isLinuxDesktopPackage('happier-ui-desktop-linux-x86_64.AppImage'), false);
});

test('Linux package metadata validation uses the owning package inspector', () => {
  const calls = [];
  validateLinuxPackageMetadata('/tmp/happier.deb', (command, args) => {
    calls.push([command, args]);
    return 'happier-ui-desktop\n0.2.0\namd64\n';
  });
  assert.deepEqual(calls, [['dpkg-deb', ['--show', '--showformat', '${Package}\\n${Version}\\n${Architecture}\\n', '/tmp/happier.deb']]]);
  assert.throws(() => validateLinuxPackageMetadata('/tmp/happier.rpm', () => 'bad'), /invalid RPM metadata/);
});
