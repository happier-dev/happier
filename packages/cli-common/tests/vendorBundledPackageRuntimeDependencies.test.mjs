import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('rmDirSafeSync retries transient ENOTEMPTY errors before removing a directory', async () => {
  const workspaces = await import('../dist/workspaces/index.js');
  assert.equal(typeof workspaces.rmDirSafeSync, 'function');

  let calls = 0;
  workspaces.rmDirSafeSync('/tmp/shared-runtime-dir', {
    rmSyncImpl() {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('ENOTEMPTY');
        err.code = 'ENOTEMPTY';
        throw err;
      }
    },
    retries: 5,
    delayMs: 0,
  });

  assert.equal(calls, 3);
});

test('vendorBundledPackageRuntimeDependencies vendors packages that only expose package.json metadata', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-vendor-runtime-deps-types-'));
  try {
    const srcPackageDir = join(tempRoot, 'packages', 'server-runtime');
    const destPackageDir = join(tempRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'server-runtime');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');
    const typesConnectDir = join(tempRoot, 'node_modules', '@types', 'connect');

    mkdirSync(srcPackageDir, { recursive: true });
    mkdirSync(destPackageDir, { recursive: true });
    mkdirSync(typesConnectDir, { recursive: true });

    writeFileSync(
      srcPackageJsonPath,
      `${JSON.stringify(
        {
          name: '@happier-dev/server-runtime',
          version: '0.0.0',
          type: 'module',
          dependencies: {
            '@types/connect': '3.4.38',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    writeFileSync(
      join(typesConnectDir, 'package.json'),
      `${JSON.stringify({ name: '@types/connect', version: '3.4.38', types: 'index.d.ts' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(typesConnectDir, 'index.d.ts'), 'export type Connect = unknown;\n', 'utf8');

    const workspaces = await import('../dist/workspaces/index.js');
    assert.equal(typeof workspaces.vendorBundledPackageRuntimeDependencies, 'function');

    workspaces.vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath, destPackageDir });

    assert.equal(
      JSON.parse(
        readFileSync(join(destPackageDir, 'node_modules', '@types', 'connect', 'package.json'), 'utf8'),
      ).name,
      '@types/connect',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependencies does not clobber an existing bundled node_modules tree when vendoring fails', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-vendor-runtime-deps-atomic-'));
  try {
    const srcPackageDir = join(tempRoot, 'packages', 'protocol');
    const destPackageDir = join(tempRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'protocol');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');

    const depADir = join(tempRoot, 'node_modules', 'dep-a');

    mkdirSync(srcPackageDir, { recursive: true });
    mkdirSync(destPackageDir, { recursive: true });
    mkdirSync(depADir, { recursive: true });

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

    // dep-a depends on dep-b, which is intentionally missing. Vendoring should throw.
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

    const existingDepADir = join(destPackageDir, 'node_modules', 'dep-a');
    mkdirSync(existingDepADir, { recursive: true });
    writeFileSync(
      join(existingDepADir, 'package.json'),
      `${JSON.stringify({ name: 'dep-a', version: 'old', main: 'index.js' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(existingDepADir, 'index.js'), 'module.exports = { a: \"old\" };\n', 'utf8');

    const workspaces = await import('../dist/workspaces/index.js');
    assert.equal(typeof workspaces.vendorBundledPackageRuntimeDependencies, 'function');

    assert.throws(() => {
      workspaces.vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath, destPackageDir });
    }, /dep-b/i);

    // The existing tree should remain intact on failure (vendoring is atomic).
    assert.equal(
      JSON.parse(readFileSync(join(destPackageDir, 'node_modules', 'dep-a', 'package.json'), 'utf8')).version,
      'old',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependencies vendors installed packages without a root export', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-vendor-runtime-deps-no-export-'));
  try {
    const srcPackageDir = join(tempRoot, 'packages', 'server-runtime');
    const destPackageDir = join(tempRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'server-runtime');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');
    const octokitAppDir = join(tempRoot, 'node_modules', '@octokit', 'app');

    mkdirSync(srcPackageDir, { recursive: true });
    mkdirSync(destPackageDir, { recursive: true });
    mkdirSync(octokitAppDir, { recursive: true });

    writeFileSync(
      srcPackageJsonPath,
      `${JSON.stringify(
        {
          name: '@happier-dev/server-runtime',
          version: '0.0.0',
          type: 'module',
          dependencies: {
            '@octokit/app': '1.0.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    writeFileSync(
      join(octokitAppDir, 'package.json'),
      `${JSON.stringify(
        {
          name: '@octokit/app',
          version: '1.0.0',
          exports: {
            './internal.js': './internal.js',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(join(octokitAppDir, 'internal.js'), 'export const internal = true;\n', 'utf8');

    const workspaces = await import('../dist/workspaces/index.js');
    assert.equal(typeof workspaces.vendorBundledPackageRuntimeDependencies, 'function');

    workspaces.vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath, destPackageDir });

    assert.equal(
      JSON.parse(
        readFileSync(join(destPackageDir, 'node_modules', '@octokit', 'app', 'package.json'), 'utf8'),
      ).name,
      '@octokit/app',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependencies vendors npm alias package folders', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-vendor-runtime-deps-alias-'));
  try {
    const srcPackageDir = join(tempRoot, 'packages', 'daemon-runtime');
    const destPackageDir = join(tempRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'daemon-runtime');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');
    const aliasDir = join(tempRoot, 'node_modules', 'string-width-cjs');

    mkdirSync(srcPackageDir, { recursive: true });
    mkdirSync(destPackageDir, { recursive: true });
    mkdirSync(aliasDir, { recursive: true });

    writeFileSync(
      srcPackageJsonPath,
      `${JSON.stringify(
        {
          name: '@happier-dev/daemon-runtime',
          version: '0.0.0',
          type: 'module',
          dependencies: {
            'string-width-cjs': 'npm:string-width@^4.2.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    writeFileSync(
      join(aliasDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'string-width',
          version: '4.2.3',
          main: 'index.js',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(join(aliasDir, 'index.js'), 'module.exports = (value) => String(value).length;\n', 'utf8');

    const workspaces = await import('../dist/workspaces/index.js');
    assert.equal(typeof workspaces.vendorBundledPackageRuntimeDependencies, 'function');

    workspaces.vendorBundledPackageRuntimeDependencies({ srcPackageJsonPath, destPackageDir });

    assert.equal(
      JSON.parse(
        readFileSync(join(destPackageDir, 'node_modules', 'string-width-cjs', 'package.json'), 'utf8'),
      ).name,
      'string-width',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('vendorBundledPackageRuntimeDependencies can resolve installed packages from a different workspace manifest path', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-vendor-runtime-deps-resolve-from-'));
  const artifactRoot = mkdtempSync(join(tmpdir(), 'cli-common-vendor-runtime-deps-artifact-root-'));
  try {
    const resolveFromPackageDir = join(tempRoot, 'apps', 'server');
    const srcPackageDir = join(artifactRoot, 'runtime-payload');
    const destPackageDir = join(artifactRoot, 'server-runtime');
    const resolveFromPackageJsonPath = join(resolveFromPackageDir, 'package.json');
    const srcPackageJsonPath = join(srcPackageDir, 'package.json');
    const depDir = join(tempRoot, 'node_modules', '@date-fns', 'tz');

    mkdirSync(resolveFromPackageDir, { recursive: true });
    mkdirSync(srcPackageDir, { recursive: true });
    mkdirSync(destPackageDir, { recursive: true });
    mkdirSync(depDir, { recursive: true });

    writeFileSync(
      resolveFromPackageJsonPath,
      `${JSON.stringify({ name: '@happier-dev/server', version: '0.0.0', type: 'module' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      srcPackageJsonPath,
      `${JSON.stringify(
        {
          name: '@happier-dev/server-runtime',
          version: '0.0.0',
          type: 'module',
          dependencies: {
            '@date-fns/tz': '^1.2.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    writeFileSync(
      join(depDir, 'package.json'),
      `${JSON.stringify({ name: '@date-fns/tz', version: '1.2.0', main: 'index.js' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(depDir, 'index.js'), 'module.exports = { tz: true };\n', 'utf8');

    const workspaces = await import('../dist/workspaces/index.js');
    assert.equal(typeof workspaces.vendorBundledPackageRuntimeDependencies, 'function');

    workspaces.vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath,
      destPackageDir,
      resolveFromPackageJsonPath,
    });

    assert.equal(
      JSON.parse(
        readFileSync(join(destPackageDir, 'node_modules', '@date-fns', 'tz', 'package.json'), 'utf8'),
      ).name,
      '@date-fns/tz',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('bundleInstalledPackageWithRuntimeDependencies preserves nested dependency trees for conflicting transitive packages', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bundle-installed-package-collision-'));
  try {
    const resolveFromPackageJsonPath = join(tempRoot, 'package.json');
    const destNodeModulesDir = join(tempRoot, 'artifact', 'node_modules');
    const rootPackageDir = join(tempRoot, 'node_modules', 'root-pkg');
    const depADir = join(tempRoot, 'node_modules', 'dep-a');
    const depBDir = join(tempRoot, 'node_modules', 'dep-b');
    const depASharedDir = join(depADir, 'node_modules', 'shared-dep');
    const depBSharedDir = join(depBDir, 'node_modules', 'shared-dep');

    mkdirSync(destNodeModulesDir, { recursive: true });
    mkdirSync(rootPackageDir, { recursive: true });
    mkdirSync(depADir, { recursive: true });
    mkdirSync(depBDir, { recursive: true });
    mkdirSync(depASharedDir, { recursive: true });
    mkdirSync(depBSharedDir, { recursive: true });

    writeFileSync(
      resolveFromPackageJsonPath,
      `${JSON.stringify({ name: 'fixture-root', version: '0.0.0', type: 'module' }, null, 2)}\n`,
      'utf8',
    );

    writeFileSync(
      join(rootPackageDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'root-pkg',
          version: '1.0.0',
          main: 'index.js',
          dependencies: {
            'dep-a': '^1.0.0',
            'dep-b': '^1.0.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(join(rootPackageDir, 'index.js'), 'module.exports = true;\n', 'utf8');

    writeFileSync(
      join(depADir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dep-a',
          version: '1.0.0',
          main: 'index.js',
          dependencies: {
            'shared-dep': '^1.0.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(join(depADir, 'index.js'), 'module.exports = true;\n', 'utf8');

    writeFileSync(
      join(depBDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dep-b',
          version: '1.0.0',
          main: 'index.js',
          dependencies: {
            'shared-dep': '^2.0.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(join(depBDir, 'index.js'), 'module.exports = true;\n', 'utf8');

    writeFileSync(
      join(depASharedDir, 'package.json'),
      `${JSON.stringify({ name: 'shared-dep', version: '1.0.0', main: 'index.js' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(depASharedDir, 'index.js'), 'module.exports = 1;\n', 'utf8');

    writeFileSync(
      join(depBSharedDir, 'package.json'),
      `${JSON.stringify({ name: 'shared-dep', version: '2.0.0', main: 'index.js' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(depBSharedDir, 'index.js'), 'module.exports = 2;\n', 'utf8');

    const workspaces = await import('../dist/workspaces/index.js');
    assert.equal(typeof workspaces.bundleInstalledPackageWithRuntimeDependencies, 'function');

    workspaces.bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'root-pkg',
      resolveFromPackageJsonPath,
      destNodeModulesDir,
    });

    assert.equal(
      JSON.parse(
        readFileSync(
          join(destNodeModulesDir, 'root-pkg', 'node_modules', 'dep-a', 'node_modules', 'shared-dep', 'package.json'),
          'utf8',
        ),
      ).version,
      '1.0.0',
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          join(destNodeModulesDir, 'root-pkg', 'node_modules', 'dep-b', 'node_modules', 'shared-dep', 'package.json'),
          'utf8',
        ),
      ).version,
      '2.0.0',
    );
    assert.equal(existsSync(join(destNodeModulesDir, 'shared-dep')), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('bundleInstalledPackageWithRuntimeDependencies keeps first-level deps scoped to the bundled package boundary', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-bundle-installed-runtime-deps-boundary-'));
  try {
    const hostPackageDir = join(tempRoot, 'apps', 'cli');
    const hostPackageJsonPath = join(hostPackageDir, 'package.json');
    const destNodeModulesDir = join(tempRoot, 'artifact', 'node_modules');
    const bundledPackageDir = join(tempRoot, 'node_modules', 'bundled-pkg');
    const hoistedDepDir = join(tempRoot, 'node_modules', 'dep-a');
    const nestedDepDir = join(bundledPackageDir, 'node_modules', 'dep-a');

    mkdirSync(hostPackageDir, { recursive: true });
    mkdirSync(destNodeModulesDir, { recursive: true });
    mkdirSync(bundledPackageDir, { recursive: true });
    mkdirSync(hoistedDepDir, { recursive: true });
    mkdirSync(nestedDepDir, { recursive: true });

    writeFileSync(
      hostPackageJsonPath,
      `${JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0', type: 'module' }, null, 2)}\n`,
      'utf8',
    );

    writeFileSync(
      join(bundledPackageDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'bundled-pkg',
          version: '1.0.0',
          main: 'index.js',
          dependencies: {
            'dep-a': '^2.0.0',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(join(bundledPackageDir, 'index.js'), 'module.exports = { bundled: true };\n', 'utf8');

    writeFileSync(
      join(hoistedDepDir, 'package.json'),
      `${JSON.stringify({ name: 'dep-a', version: '1.0.0', main: 'index.js' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(hoistedDepDir, 'index.js'), 'module.exports = { version: "1.0.0" };\n', 'utf8');

    writeFileSync(
      join(nestedDepDir, 'package.json'),
      `${JSON.stringify({ name: 'dep-a', version: '2.0.0', main: 'index.js' }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(nestedDepDir, 'index.js'), 'module.exports = { version: "2.0.0" };\n', 'utf8');

    const workspaces = await import('../dist/workspaces/index.js');
    assert.equal(typeof workspaces.bundleInstalledPackageWithRuntimeDependencies, 'function');

    workspaces.bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'bundled-pkg',
      resolveFromPackageJsonPath: hostPackageJsonPath,
      destNodeModulesDir,
    });

    assert.equal(
      JSON.parse(readFileSync(join(destNodeModulesDir, 'bundled-pkg', 'node_modules', 'dep-a', 'package.json'), 'utf8')).version,
      '2.0.0',
    );
    assert.equal(existsSync(join(destNodeModulesDir, 'dep-a')), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
