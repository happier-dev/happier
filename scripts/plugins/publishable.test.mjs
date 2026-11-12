import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isPublishablePluginPackage, readPublishablePlugins } from './publishable.mjs';

test('only an explicit false bundled flag selects independently published plugins', () => {
  for (const value of [undefined, null, {}, { happier: {} }, { happier: { bundled: true } }, { happier: { bundled: 'false' } }]) {
    assert.equal(isPublishablePluginPackage(value), false);
  }
  assert.equal(isPublishablePluginPackage({ happier: { bundled: false } }), true);
  const root = mkdtempSync(join(tmpdir(), 'publishable-plugins-'));
  try {
    for (const [id, bundled] of [['bundled', true], ['external', false]]) {
      const dir = join(root, 'packages/plugins', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: bundled ? `@happier-dev/plugins-${id}` : '@example/custom-plugin', happier: { bundled } }));
    }
    assert.deepEqual(readPublishablePlugins(root), [{ id: 'external', packageName: '@example/custom-plugin', packageDir: join(root, 'packages/plugins/external') }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
