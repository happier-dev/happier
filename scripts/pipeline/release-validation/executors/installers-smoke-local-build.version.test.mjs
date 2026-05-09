import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLocalBuildInstallVersionForTests } from './installers-smoke-local-build.mjs';

test('local-build install version prefers explicit build output version', () => {
  const version = resolveLocalBuildInstallVersionForTests({
    version: '0.2.6-preview.12',
    artifacts: ['happier-v0.2.6-darwin-arm64.tar.gz'],
  });

  assert.equal(version, '0.2.6-preview.12');
});

test('local-build install version falls back to artifact filename version', () => {
  const version = resolveLocalBuildInstallVersionForTests({
    artifacts: ['happier-v0.2.6-darwin-arm64.tar.gz'],
  });

  assert.equal(version, '0.2.6');
});

test('local-build install version supports prerelease artifact filenames', () => {
  const version = resolveLocalBuildInstallVersionForTests({
    artifacts: ['happier-v1.2.3-preview.4-darwin-arm64.tar.gz'],
  });

  assert.equal(version, '1.2.3-preview.4');
});

