import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLinuxAppImageDiagnosticsLayout } from './build-updater-artifacts.mjs';

test('resolveLinuxAppImageDiagnosticsLayout returns consistent AppDir relative paths', () => {
  const layout = resolveLinuxAppImageDiagnosticsLayout({ environment: 'dev' });
  assert.equal(layout.productName, 'HappierDev');
  assert.equal(layout.appRelativePath, 'usr/bin/app');
  assert.equal(layout.legacyHsetupRelativePath, 'usr/bin/hsetup');
  assert.equal(layout.resourceHsetupDirRelativePath, 'usr/lib/HappierDev/binaries');
  assert.equal(layout.resourceHsetupPrefix, 'hsetup-');
});

