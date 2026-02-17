import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('vendorBundledPackageRuntimeDependencies vendors transitive external dependencies into the bundled package', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-vendor-runtime-deps-'));
  try {
    const srcPackageDir = join(tempRoot, 'packages', 'protocol');
    const destPackageDir = join(tempRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');

    const depADir = join(tempRoot, 'node_modules', 'dep-a');
    const depBDir = join(tempRoot, 'node_modules', 'dep-b');

    mkdirSync(srcPackageDir, { recursive: true });
    mkdirSync(destPackageDir, { recursive: true });
    mkdirSync(depADir, { recursive: true });
    mkdirSync(depBDir, { recursive: true });

    writeFileSync(
      srcPackageJsonPath,
      `${JSON.stringify(
        {
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          dependencies: {
            'dep-a': '^1.0.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    writeFileSync(
      join(depADir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dep-a',
          version: '1.0.0',
          main: 'index.js',
          dependencies: {
            'dep-b': '^1.0.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(join(depADir, 'index.js'), 'module.exports = { a: true };\n', 'utf8');

    writeFileSync(
      join(depBDir, 'package.json'),
      `${JSON.stringify({ name: 'dep-b', version: '1.0.0', main: 'index.js' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(depBDir, 'index.js'), 'module.exports = { b: true };\n', 'utf8');

    const workspaces = await import('../dist/workspaces/index.js');
    assert.equal(typeof workspaces.vendorBundledPackageRuntimeDependencies, 'function');

    workspaces.vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath, destPackageDir });

    assert.equal(
      JSON.parse(
        readFileSync(join(destPackageDir, 'node_modules', 'dep-a', 'package.json'), 'utf8'),
      ).name,
      'dep-a',
    );
    assert.equal(
      JSON.parse(
        readFileSync(join(destPackageDir, 'node_modules', 'dep-a', 'node_modules', 'dep-b', 'package.json'), 'utf8'),
      ).name,
      'dep-b',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

