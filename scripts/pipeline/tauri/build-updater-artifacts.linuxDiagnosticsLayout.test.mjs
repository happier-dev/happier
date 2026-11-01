import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLinuxAppImageDiagnosticsLayout } from './build-updater-artifacts.mjs';

test('resolveLinuxAppImageDiagnosticsLayout returns consistent AppDir relative paths', () => {
  for (const [environment, productName, binaryName] of [
    ['production', 'Happier', 'happier-desktop'],
    ['preview', 'HappierPreview', 'happier-desktop-preview'],
    ['dev', 'HappierDev', 'happier-desktop-dev'],
    ['publicdev', 'HappierDev', 'happier-desktop-dev'],
  ]) {
    const layout = resolveLinuxAppImageDiagnosticsLayout({ environment });
    assert.equal(layout.productName, productName);
    assert.equal(layout.appRelativePath, `usr/bin/${binaryName}`);
    assert.equal(layout.legacyHsetupRelativePath, 'usr/bin/hsetup');
    assert.equal(layout.resourceHsetupDirRelativePath, `usr/lib/${productName}/binaries`);
    assert.equal(layout.resourceHsetupPrefix, 'hsetup-');
  }
});

