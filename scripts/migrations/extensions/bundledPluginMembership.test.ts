import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readBundledPluginPackageNames } from './bundledPluginMembership.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Both first-party Channels providers ship. Discord's `reservation_only` hold
 * was lifted with the rest of its vertical, so this file asserts the shipping
 * contract that is true now instead of an exclusion the product superseded.
 * The `reservation_only` MECHANISM keeps its own discriminating coverage
 * against synthetic packages in `syncCliBundledExtensionPackaging.test.ts` and
 * `generateBundledPluginEntries.test.ts`; repeating it here against a real
 * package only re-encodes one product decision as a build rule.
 */
const CHANNELS_PROVIDER_PACKAGE_NAMES = [
  '@happier-dev/plugins-channel-discord',
  '@happier-dev/plugins-channel-telegram',
] as const;

test('includes every first-party Channels provider package in bundled plugin membership', () => {
  const bundledPluginPackageNames = readBundledPluginPackageNames(repoRoot);

  for (const packageName of CHANNELS_PROVIDER_PACKAGE_NAMES) {
    assert.ok(
      bundledPluginPackageNames.includes(packageName),
      `${packageName} is missing from bundled plugin membership`,
    );
  }
});

test('ships every Channels provider package through the canonical CLI and UI projections', () => {
  const cliPackageJson = JSON.parse(readFileSync(resolve(repoRoot, 'apps/cli/package.json'), 'utf8')) as {
    bundledDependencies?: unknown;
    dependencies?: Record<string, unknown>;
  };
  const bundledDependencies = Array.isArray(cliPackageJson.bundledDependencies)
    ? cliPackageJson.bundledDependencies.map(String)
    : [];
  const generatedPluginManifests = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'),
    'utf8',
  );
  const generatedUiPluginEntries = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );

  for (const packageName of CHANNELS_PROVIDER_PACKAGE_NAMES) {
    assert.ok(
      bundledDependencies.includes(packageName),
      `${packageName} is missing from apps/cli bundledDependencies`,
    );
    assert.equal(
      cliPackageJson.dependencies?.[packageName],
      '0.0.0',
      `${packageName} is missing from apps/cli dependencies`,
    );
    assert.ok(
      generatedPluginManifests.includes(packageName),
      `${packageName} is missing from the generated CLI bundled-plugin projection`,
    );
    assert.ok(
      generatedUiPluginEntries.includes(packageName),
      `${packageName} is missing from the generated UI bundled-plugin projection`,
    );
  }
});
