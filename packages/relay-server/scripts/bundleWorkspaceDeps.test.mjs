import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('declares external runtime dependencies required by bundled workspace packages', () => {
  const relayPackageJson = JSON.parse(readFileSync(resolve(repoRoot, 'packages', 'relay-server', 'package.json'), 'utf8'));
  const bundledWorkspacePackagePaths = [
    resolve(repoRoot, 'packages', 'release-runtime', 'package.json'),
  ];

  const relayDependencyNames = new Set(Object.keys(relayPackageJson.dependencies ?? {}));
  const requiredExternalDependencies = new Set();
  for (const packageJsonPath of bundledWorkspacePackagePaths) {
    const bundledPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    for (const dependencyName of Object.keys(bundledPackageJson.dependencies ?? {})) {
      if (!dependencyName.startsWith('@happier-dev/')) {
        requiredExternalDependencies.add(dependencyName);
      }
    }
  }

  const missingDependencies = [...requiredExternalDependencies].filter((name) => !relayDependencyNames.has(name));
  assert.deepEqual(missingDependencies, []);
});
