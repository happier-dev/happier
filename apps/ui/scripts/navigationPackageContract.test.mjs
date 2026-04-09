import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

test('apps/ui direct @react-navigation/native range satisfies navigator peer requirements', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const directNativeRange = packageJson?.dependencies?.['@react-navigation/native'];

  assert.equal(typeof directNativeRange, 'string');

  const navigatorPackages = [
    '@react-navigation/bottom-tabs',
    '@react-navigation/native-stack',
    '@react-navigation/drawer',
  ];

  for (const packageName of navigatorPackages) {
    const navigatorPackageJson = await readJson(
      join(packageRoot, 'node_modules', ...packageName.split('/'), 'package.json'),
    );
    const requiredNativeRange = navigatorPackageJson?.peerDependencies?.['@react-navigation/native'];

    assert.equal(
      typeof requiredNativeRange,
      'string',
      `${packageName} should declare a @react-navigation/native peer range`,
    );
    assert.equal(
      semver.subset(directNativeRange, requiredNativeRange),
      true,
      `apps/ui declares @react-navigation/native ${directNativeRange}, but ${packageName} requires ${requiredNativeRange}`,
    );
  }
});

test('apps/ui fast test lane includes the navigation package contract check', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = await readJson(join(packageRoot, 'package.json'));
  const testScript = packageJson?.scripts?.test;

  assert.equal(typeof testScript, 'string');
  assert.match(testScript, /\btest:unit\b/);
  assert.match(testScript, /navigationPackageContract\.test\.mjs/);
});
