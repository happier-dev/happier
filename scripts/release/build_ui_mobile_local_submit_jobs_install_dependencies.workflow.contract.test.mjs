import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local submit jobs install UI dependencies before expo-submit', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');
  const expectedScope = String(
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'eas.json'), 'utf8'))?.build?.base?.env?.HAPPIER_INSTALL_SCOPE ?? '',
  );

  const androidBlock = src.match(/submit_android:\n([\s\S]*?)\n  ota_update:/)?.[1] ?? '';
  const iosBlock = src.match(/submit_ios:\n([\s\S]*)/)?.[1] ?? '';

  for (const block of [androidBlock, iosBlock]) {
    assert.match(block, /- name: Enable Corepack \(Yarn\)/);
    assert.match(block, /corepack enable/);
    assert.match(block, /corepack prepare yarn@1\.22\.22 --activate/);
    assert.match(block, /- name: Install dependencies/);
    assert.match(block, /run: yarn install --frozen-lockfile --ignore-engines/);
    assert.match(block, /HAPPIER_INSTALL_SCOPE:\s*"([^"]+)"/);
    assert.match(block, new RegExp(`HAPPIER_INSTALL_SCOPE:\\s*"${expectedScope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.match(block, /HAPPIER_UI_VENDOR_WEB_ASSETS:\s*"0"/);
  }
});
