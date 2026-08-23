import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  API_GOVERNANCE_PROFILES,
  runApiGovernance,
} from './apiGovernance.mjs';
import { parseApiGovernanceCliArgs } from './cli.mjs';
import { projectPreparedDeclarationSurface } from './emittedDeclarationSurface.mjs';

const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function writeFixtureFile(root, relativePath, contents) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

async function createEntrypointFixture(packageName = '@happier-dev/plugin-ui-governance-fixture') {
  const root = await mkdtemp(join(tmpdir(), 'happier-api-governance-'));
  await writeFixtureFile(root, 'package.json', `${JSON.stringify({
    name: packageName,
    version: '0.0.0',
    type: 'module',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
  }, null, 2)}\n`);
  await writeFixtureFile(root, 'src/index.ts', [
    'class Hidden {',
    '  value?: string;',
    '}',
    '',
    'export function run(): Hidden {',
    '  return new Hidden();',
    '}',
    '',
  ].join('\n'));
  await writeFixtureFile(root, 'dist/index.d.ts', [
    "export declare function run(): import('./hidden.js').Hidden;",
    '',
  ].join('\n'));
  await writeFixtureFile(root, 'dist/hidden.d.ts', [
    'export declare class Hidden {',
    '  value?: string;',
    '}',
    '',
  ].join('\n'));
  return root;
}

async function createPackedPluginSdkFixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-packed-plugin-sdk-governance-'));
  const packageJson = {
    name: '@happier-dev/plugin-sdk',
    version: '0.0.0',
    type: 'module',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
  };
  await writeFixtureFile(root, 'package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFixtureFile(root, 'dist/index.d.ts', [
    "export declare function run(): import('./hidden.js').Hidden;",
    '',
  ].join('\n'));
  await writeFixtureFile(root, 'dist/hidden.d.ts', [
    'export declare class Hidden {',
    '  value?: string;',
    '}',
    '',
  ].join('\n'));
  const emitted = projectPreparedDeclarationSurface({
    packageRoot: root,
    packageJson,
    title: 'Plugin SDK public declaration report',
  });
  await writeFixtureFile(root, 'API.md', '# Plugin SDK API\n');
  await writeFixtureFile(root, 'api-surface.json', `${JSON.stringify({
    schemaVersion: 1,
    entrypoints: [{ specifier: '.', sourceModule: 'src/index.ts' }],
    symbols: [{
      specifier: '.',
      exportName: 'run',
      kind: 'value',
      sourceModule: 'src/index.ts',
      sourceExport: 'run',
    }],
  }, null, 2)}\n`);
  await writeFixtureFile(root, 'api-declarations.md', emitted.declarationReport);
  return root;
}

async function createBundledDeclarationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-bundled-declaration-governance-')));
  const packageRoot = join(root, 'before-artifact-bundle', 'package');
  const packageJson = {
    name: '@fixture/sdk',
    version: '0.0.0',
    type: 'module',
    bundledDependencies: ['@fixture/protocol'],
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
  };
  const protocolPackageJson = {
    name: '@fixture/protocol',
    version: '0.0.0',
    type: 'module',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
  };
  const protocolDeclaration = [
    'export type PublicActionInputById = Readonly<{ id: string }>;',
    '',
  ].join('\n');
  const externalPackageJson = {
    name: '@fixture/external',
    version: '0.0.0',
    type: 'module',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
  };
  const externalDeclaration = [
    'export type ExternalOnly = Readonly<{ external: true }>;',
    '',
  ].join('\n');
  await writeFixtureFile(root, 'before-artifact-bundle/package/package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFixtureFile(root, 'before-artifact-bundle/package/dist/index.d.ts', [
    "export type { PublicActionInputById } from '@fixture/protocol';",
    "export type { ExternalOnly } from '@fixture/external';",
    '',
  ].join('\n'));
  // This models a sandbox before its artifact bundler materializes the
  // declared dependency beneath the target package.
  await writeFixtureFile(root, 'before-artifact-bundle/node_modules/@fixture/protocol/package.json', `${JSON.stringify(protocolPackageJson, null, 2)}\n`);
  await writeFixtureFile(root, 'before-artifact-bundle/node_modules/@fixture/protocol/dist/index.d.ts', protocolDeclaration);
  await writeFixtureFile(root, 'before-artifact-bundle/node_modules/@fixture/external/package.json', `${JSON.stringify(externalPackageJson, null, 2)}\n`);
  await writeFixtureFile(root, 'before-artifact-bundle/node_modules/@fixture/external/dist/index.d.ts', externalDeclaration);
  return Object.freeze({
    externalDeclaration,
    externalPackageJson,
    packageJson,
    packageRoot,
    protocolDeclaration,
    protocolPackageJson,
    root,
  });
}

test('the shared governance owner reserves plugin-sdk, plugin-ui, and sdk profiles', () => {
  assert.deepEqual(
    Object.keys(API_GOVERNANCE_PROFILES).sort(),
    ['plugin-sdk', 'plugin-ui', 'sdk'],
  );
});

test('the shared CLI passes one generic publication provenance contract to every profile', () => {
  assert.deepEqual(
    parseApiGovernanceCliArgs([
      '--profile',
      'plugin-ui',
      '--write',
      '--published-version',
      '1.2.3',
      '--previous-published-inventory',
      'published/api-surface.json',
    ], '/workspace'),
    {
      profileId: 'plugin-ui',
      packageRoot: undefined,
      write: true,
      check: false,
      json: false,
      publishedVersion: '1.2.3',
      previousPublishedInventoryPath: '/workspace/published/api-surface.json',
    },
  );
  assert.throws(
    () => parseApiGovernanceCliArgs([
      '--profile',
      'plugin-ui',
      '--previous-published-inventory',
      'published/api-surface.json',
    ], '/workspace'),
    /--previous-published-inventory requires --published-version/u,
  );
});

test('plugin package scripts prepare declarations and invoke the shared governance owner', async () => {
  const pluginSdkPackage = JSON.parse(await readFile(
    join(REPOSITORY_ROOT, 'packages/plugin-sdk/package.json'),
    'utf8',
  ));
  const pluginUiPackage = JSON.parse(await readFile(
    join(REPOSITORY_ROOT, 'packages/plugin-ui/package.json'),
    'utf8',
  ));
  const sdkPackage = JSON.parse(await readFile(
    join(REPOSITORY_ROOT, 'packages/sdk/package.json'),
    'utf8',
 ));

  assert.equal(
    pluginSdkPackage.scripts['prepare:api-governance'],
    'yarn -s prepare:declarations && node ./scripts/apiSurfaceCli.mjs --materialize-source --write && yarn -s build:compiled',
  );
  assert.equal(
    pluginSdkPackage.scripts['check:api-governance'],
    'yarn -s check:prepare:api-governance && node ../../scripts/api-governance/cli.mjs --profile plugin-sdk --check',
  );
  assert.equal(
    pluginSdkPackage.scripts['check:api-governance:prepared'],
    'node ../../scripts/api-governance/cli.mjs --profile plugin-sdk --check',
  );
  assert.equal(
    pluginSdkPackage.scripts['check:prepare:api-governance'],
    'yarn -s prepare:declarations && node ./scripts/apiSurfaceCli.mjs --materialize-source --check && yarn -s build:compiled',
  );
  assert.equal(
    pluginUiPackage.scripts['prepare:declarations'],
    'yarn --cwd ../plugin-sdk -s prepare:declarations',
  );
  assert.equal(
    pluginUiPackage.scripts['prepare:api-governance'],
    'yarn -s prepare:declarations && yarn -s build',
  );
  assert.equal(
    pluginUiPackage.scripts['check:api-governance'],
    'yarn -s prepare:api-governance && node ../../scripts/api-governance/cli.mjs --profile plugin-ui --check',
  );
  assert.match(pluginUiPackage.scripts.prepack, /check:api-governance/u);
  assert.equal(
    pluginUiPackage.scripts['check:api-governance:prepared'],
    'node ../../scripts/api-governance/cli.mjs --profile plugin-ui --check',
  );
  assert.deepEqual(
    ['API.md', 'api-surface.json', 'api-declarations.md'].every((path) => pluginUiPackage.files.includes(path)),
    true,
  );
  assert.equal(
    sdkPackage.scripts['prepare:api-governance'],
    'yarn -s prepare:declarations && yarn -s build:compiled',
  );
  assert.equal(
    sdkPackage.scripts['check:api-governance'],
    'yarn -s prepare:api-governance && node ../../scripts/api-governance/cli.mjs --profile sdk --check',
  );
  assert.equal(
    sdkPackage.scripts['check:api-governance:prepared'],
    'node ../../scripts/api-governance/cli.mjs --profile sdk --check',
  );

  const countCompilerInvocations = (packageJson, entrypoint) => {
    const active = new Set();
    const visit = (scriptName) => {
      assert.equal(active.has(scriptName), false, `${packageJson.name} script cycle at ${scriptName}`);
      active.add(scriptName);
      const command = packageJson.scripts[scriptName] ?? '';
      let count = [...command.matchAll(/buildTypeScriptPackageDist\.mjs/gu)].length;
      for (const match of command.matchAll(/yarn -s ([\w:-]+)/gu)) {
        if (packageJson.scripts[match[1]] !== undefined) count += visit(match[1]);
      }
      active.delete(scriptName);
      return count;
    };
    return visit(entrypoint);
  };

  for (const packageJson of [pluginSdkPackage, pluginUiPackage, sdkPackage]) {
    const prepack = packageJson.scripts.prepack;
    assert.equal(
      countCompilerInvocations(packageJson, 'prepack'),
      1,
      `${packageJson.name} prepack must compile its exact candidate once`,
    );
    assert.match(prepack, /check:api-governance:prepared/u);
  }
});

test('the plugin-ui profile detects a reachable emitted declaration drift even when source is unchanged', async () => {
  const root = await createEntrypointFixture();
  try {
    const written = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: true,
      check: false,
    });
    assert.equal(written.status, 'current');
    assert.deepEqual(
      written.files.map((file) => file.path),
      ['API.md', 'api-declarations.md', 'api-surface.json'],
    );
    const writtenInventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.deepEqual(writtenInventory.entrypoints, [{
      specifier: '.',
      declarationModule: 'dist/index.d.ts',
    }]);
    assert.deepEqual(writtenInventory.symbols, [{
      specifier: '.',
      exportName: 'run',
      kind: 'value',
      declarationModule: 'dist/index.d.ts',
      declarationExport: 'run',
    }]);

    const current = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: false,
      check: true,
    });
    assert.equal(current.status, 'current');
    assert.equal(current.summary.changedFiles, 0);

    const declarationPath = join(root, 'dist/hidden.d.ts');
    const declaration = await readFile(declarationPath, 'utf8');
    await writeFile(
      declarationPath,
      declaration.replace('value?: string;', 'value: string;'),
      'utf8',
    );
    assert.match(await readFile(join(root, 'src/index.ts'), 'utf8'), /value\?: string;/u);

    const drift = spawnSync(
      process.execPath,
      [CLI_PATH, '--profile', 'plugin-ui', '--package-root', root, '--check'],
      { encoding: 'utf8' },
    );
    assert.equal(drift.status, 1, drift.stderr);
    assert.match(drift.stdout, /drift publicDeclarationReport api-declarations\.md: dist\/hidden\.d\.ts — Hidden/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-sdk profile verifies a packed candidate declaration graph without source files', async () => {
  const root = await createPackedPluginSdkFixture();
  try {
    const current = await runApiGovernance({
      profileId: 'plugin-sdk',
      packageRoot: root,
      write: false,
      check: true,
    });
    assert.equal(current.status, 'current');
    assert.equal(current.summary.changedFiles, 0);

    const declarationPath = join(root, 'dist/hidden.d.ts');
    const declaration = await readFile(declarationPath, 'utf8');
    await writeFile(
      declarationPath,
      declaration.replace('value?: string;', 'value: string;'),
      'utf8',
    );

    const drift = await runApiGovernance({
      profileId: 'plugin-sdk',
      packageRoot: root,
      write: false,
      check: true,
    });
    assert.equal(drift.status, 'drift');
    assert.deepEqual(
      drift.files.filter((file) => file.changed).map((file) => file.path),
      ['api-declarations.md'],
    );

    await writeFile(join(root, 'dist/index.d.ts'), [
      "export declare function renamed(): import('./hidden.js').Hidden;",
      '',
    ].join('\n'), 'utf8');
    await assert.rejects(
      () => runApiGovernance({
        profileId: 'plugin-sdk',
        packageRoot: root,
        write: false,
        check: true,
      }),
      /inventory is missing emitted export \.:renamed:value[\s\S]*inventory has no emitted export \.:run:value/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the emitted report gives declared bundled dependencies a candidate identity without absorbing other dependencies', async () => {
  const fixture = await createBundledDeclarationFixture();
  try {
    const beforeArtifactBundle = projectPreparedDeclarationSurface({
      packageRoot: fixture.packageRoot,
      packageJson: fixture.packageJson,
      title: 'Fixture public declaration report',
      bundledDependencies: fixture.packageJson.bundledDependencies,
    }).declarationReport;
    const afterArtifactBundleRoot = join(fixture.root, 'after-artifact-bundle', 'package');
    await writeFixtureFile(
      fixture.root,
      'after-artifact-bundle/package/package.json',
      `${JSON.stringify(fixture.packageJson, null, 2)}\n`,
    );
    await writeFixtureFile(fixture.root, 'after-artifact-bundle/package/dist/index.d.ts', [
      "export type { PublicActionInputById } from '@fixture/protocol';",
      "export type { ExternalOnly } from '@fixture/external';",
      '',
    ].join('\n'));
    await writeFixtureFile(
      fixture.root,
      'after-artifact-bundle/package/node_modules/@fixture/protocol/package.json',
      `${JSON.stringify(fixture.protocolPackageJson, null, 2)}\n`,
    );
    await writeFixtureFile(
      fixture.root,
      'after-artifact-bundle/package/node_modules/@fixture/protocol/dist/index.d.ts',
      fixture.protocolDeclaration,
    );
    await writeFixtureFile(
      fixture.root,
      'after-artifact-bundle/node_modules/@fixture/external/package.json',
      `${JSON.stringify(fixture.externalPackageJson, null, 2)}\n`,
    );
    await writeFixtureFile(
      fixture.root,
      'after-artifact-bundle/node_modules/@fixture/external/dist/index.d.ts',
      fixture.externalDeclaration,
    );
    const afterArtifactBundle = projectPreparedDeclarationSurface({
      packageRoot: afterArtifactBundleRoot,
      packageJson: fixture.packageJson,
      title: 'Fixture public declaration report',
      bundledDependencies: fixture.packageJson.bundledDependencies,
    }).declarationReport;
    assert.equal(beforeArtifactBundle, afterArtifactBundle);
    assert.match(
      beforeArtifactBundle,
      /Declared by `node_modules\/@fixture\/protocol\/dist\/index\.d\.ts` as `PublicActionInputById`\./u,
    );
    assert.match(
      beforeArtifactBundle,
      /Re-exported from another package as `ExternalOnly`; that package owns the declaration\./u,
    );
    assert.match(beforeArtifactBundle, /`@fixture\/external#ExternalOnly`/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('the prepared declaration projection retains an emitted type-only re-export of a class', async () => {
  const root = await createEntrypointFixture();
  try {
    await writeFixtureFile(root, 'dist/opaque-handle.d.ts', [
      'export declare abstract class OpaqueHandle {',
      '  protected readonly opaque: unique symbol;',
      '}',
      '',
    ].join('\n'));
    await writeFile(join(root, 'dist/index.d.ts'), [
      "export type { OpaqueHandle } from './opaque-handle.js';",
      "export declare function run(): import('./hidden.js').Hidden;",
      '',
    ].join('\n'), 'utf8');

    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const surface = projectPreparedDeclarationSurface({
      packageRoot: root,
      packageJson,
      title: 'Fixture public declaration report',
    });

    assert.deepEqual(
      surface.rows.map(({ exportName, kind }) => ({ exportName, kind })),
      [
        { exportName: 'OpaqueHandle', kind: 'type' },
        { exportName: 'run', kind: 'value' },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the future SDK profile uses the same entrypoint projection when its package appears', async () => {
  const root = await createEntrypointFixture('@happier-dev/sdk');
  try {
    const written = await runApiGovernance({
      profileId: 'sdk',
      packageRoot: root,
      write: true,
      check: false,
      publishedVersion: '1.0.0',
    });

    assert.equal(written.status, 'current');
    assert.deepEqual(written.publication, {
      publishedVersion: '1.0.0',
      previousPublishedInventoryPath: undefined,
    });
    assert.deepEqual(written.files.map((file) => file.path), [
      'API.md',
      'api-declarations.md',
      'api-surface.json',
    ]);
    assert.match(await readFile(join(root, 'API.md'), 'utf8'), /^# SDK public API$/mu);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8')).symbols.map((symbol) => symbol.since),
      ['1.0.0'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generic profiles stamp published provenance from the previous tarball inventory and retain it in ordinary checks', async () => {
  const root = await createEntrypointFixture('@happier-dev/plugin-ui');
  const previousInventoryPath = join(root, 'published-1.0.0-api-surface.json');
  try {
    const first = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: true,
      check: false,
      publishedVersion: '1.0.0',
    });
    assert.deepEqual(first.publication, {
      publishedVersion: '1.0.0',
      previousPublishedInventoryPath: undefined,
    });
    await writeFile(
      previousInventoryPath,
      await readFile(join(root, 'api-surface.json'), 'utf8'),
      'utf8',
    );

    const declarationPath = join(root, 'dist/index.d.ts');
    const declaration = await readFile(declarationPath, 'utf8');
    await writeFile(declarationPath, `${declaration}\nexport declare const added: 1;\n`, 'utf8');

    const second = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: true,
      check: false,
      publishedVersion: '1.1.0',
      previousPublishedInventoryPath: previousInventoryPath,
    });
    assert.deepEqual(second.publication, {
      publishedVersion: '1.1.0',
      previousPublishedInventoryPath: previousInventoryPath,
    });
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.deepEqual(
      inventory.symbols.map(({ exportName, since }) => ({ exportName, since })),
      [
        { exportName: 'added', since: '1.1.0' },
        { exportName: 'run', since: '1.0.0' },
      ],
    );

    const ordinaryCheck = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: false,
      check: true,
    });
    assert.equal(ordinaryCheck.status, 'current');
    assert.equal(ordinaryCheck.summary.changedFiles, 0);

    await writeFile(
      declarationPath,
      `${await readFile(declarationPath, 'utf8')}\nexport declare const unpublished: 1;\n`,
      'utf8',
    );
    const ordinaryWrite = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: true,
      check: false,
    });
    assert.equal(ordinaryWrite.status, 'current');
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8')).symbols.map(({
        exportName,
        since,
      }) => ({ exportName, since })),
      [
        { exportName: 'added', since: '1.1.0' },
        { exportName: 'run', since: '1.0.0' },
        { exportName: 'unpublished', since: undefined },
      ],
    );
    const currentAfterUnpublishedAddition = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: false,
      check: true,
    });
    assert.equal(currentAfterUnpublishedAddition.status, 'current');
    assert.equal(currentAfterUnpublishedAddition.summary.changedFiles, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
