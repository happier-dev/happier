import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

// Native children expose ESM initialization order, which a transformed test
// graph can mask. Observe during collection, as bootstrap latency is not the
// contract. Exercise both real entry points before consuming provenance.
for (const entry of ['registries/registryItemsV1', 'account/settings/themeProfiles']) {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--conditions=happier-source', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      await import('./src/${entry}.ts');
      const { ThemeProfileV1Schema } = await import('./src/account/settings/themeProfiles.ts');
      const source = { kind: 'store', contributionId: 'dark', provenance: {
        sourceId: 'openvsx', itemId: 'publisher.palette', format: 'open-vsx',
        sourceUrl: 'https://open-vsx.org/api', ref: { kind: 'version', version: '1.0' }, importedAt: 1,
      } };
      const profile = { schemaVersion: 1, id: 'store_palette', name: 'Palette',
        createdAt: '2026-11-16', updatedAt: '2026-11-16',
        base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, source };
      assert.deepEqual(ThemeProfileV1Schema.parse(profile).source, source);
      assert.equal(ThemeProfileV1Schema.safeParse({ ...profile, source: {
        ...source, provenance: { ...source.provenance, importedAt: -1 },
      } }).success, false);
    `], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  test(`loads ${entry} before parsing a Store theme profile`, () => {
    assert.equal(result.status, 0, result.error?.stack ?? result.stderr);
  });
}
