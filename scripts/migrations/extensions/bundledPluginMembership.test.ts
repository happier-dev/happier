import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readBundledPluginPackageNames } from './bundledPluginMembership.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('excludes reservation-only Channels provider packages from bundled plugins', () => {
  const bundledPluginPackageNames = readBundledPluginPackageNames(repoRoot);

  assert.ok(bundledPluginPackageNames.includes('@happier-dev/plugins-channel-telegram'));
  assert.ok(!bundledPluginPackageNames.includes('@happier-dev/plugins-channel-discord'));
});

test('ships only eligible Channels provider packages through the canonical CLI and UI projections', () => {
  const cliPackageJson = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
    bundledDependencies?: unknown;
    dependencies?: Record<string, unknown>;
  };
  const bundledDependencies = Array.isArray(cliPackageJson.bundledDependencies)
    ? cliPackageJson.bundledDependencies.map(String)
    : [];
  const generatedPluginSources = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  const generatedUiPluginEntries = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );

  for (const packageName of ['@happier-dev/plugins-channel-telegram']) {
    assert.ok(bundledDependencies.includes(packageName));
    assert.equal(cliPackageJson.dependencies?.[packageName], '0.0.0');
    assert.ok(generatedPluginSources.includes(packageName));
    assert.ok(generatedUiPluginEntries.includes(packageName));
  }

  const reservationOnlyPackageName = '@happier-dev/plugins-channel-discord';
  assert.ok(!bundledDependencies.includes(reservationOnlyPackageName));
  assert.equal(cliPackageJson.dependencies?.[reservationOnlyPackageName], undefined);
  assert.ok(!generatedPluginSources.includes(reservationOnlyPackageName));
  assert.ok(!generatedUiPluginEntries.includes(reservationOnlyPackageName));
});
