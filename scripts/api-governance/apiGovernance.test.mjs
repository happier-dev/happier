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
import { resolveWorkspaceBundleLockPath, withWorkspaceBundleLock } from '../workspaces/workspaceBundleLock.mjs';
import { withPatchedProcessEnv } from '../../apps/stack/scripts/testkit/core/env_scope.mjs';

const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a competing API publisher cannot replace outputs without the publication lease', async t => {
  const root = await createEntrypointFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  withPatchedProcessEnv(t, { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' });
  await withWorkspaceBundleLock(async () => {
    await assert.rejects(runApiGovernance({ profileId: 'plugin-ui', packageRoot: root, write: true }),
      error => error.code === 'EWORKSPACEBUNDLELOCKBUSY');
  }, { lockPath: resolveWorkspaceBundleLockPath(root) });
});

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
    "export * from './index.public.js';",
    '',
  ].join('\n'));
  await writeFixtureFile(root, 'src/index.public.ts', [
    "export { run } from './runtime.js';",
    '',
  ].join('\n'));
  await writeFixtureFile(root, 'src/runtime.ts', [
    'export class Hidden {',
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
    'export declare namespace External {',
    '    type Nested = {',
    '        flag?: boolean;',
    '    };',
    '}',
    '',
  ].join('\n');
  await writeFixtureFile(root, 'before-artifact-bundle/package/package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFixtureFile(root, 'before-artifact-bundle/package/dist/index.d.ts', [
    "export type { PublicActionInputById } from '@fixture/protocol';",
    "export type { ExternalOnly } from '@fixture/external';",
    "export declare function usesQualifiedExternal(): import('@fixture/external').External.Nested;",
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

test('the shared governance owner reserves embed, plugin-sdk, plugin-ui, and sdk profiles', () => {
  assert.deepEqual(
    Object.keys(API_GOVERNANCE_PROFILES).sort(),
    ['embed', 'plugin-sdk', 'plugin-ui', 'sdk'],
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
      sourcePrepared: false,
      publishedVersion: '1.2.3',
      previousPublishedInventoryPath: '/workspace/published/api-surface.json',
    },
  );

  assert.equal(
    parseApiGovernanceCliArgs([
      '--profile',
      'plugin-sdk',
      '--check',
      '--source-prepared',
    ], '/workspace').sourcePrepared,
    true,
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

test('the SDK profile projects identical declaration bytes from repo and package working directories', async () => {
  const packageRoot = join(REPOSITORY_ROOT, 'packages', 'sdk');
  const projectionModuleUrl = new URL('./emittedDeclarationSurface.mjs', import.meta.url).href;
  const projectionScript = [
    "import { createHash } from 'node:crypto';",
    "import { readFile } from 'node:fs/promises';",
    `import { projectPreparedDeclarationSurface } from ${JSON.stringify(projectionModuleUrl)};`,
    `const packageRoot = ${JSON.stringify(packageRoot)};`,
    "const packageJson = JSON.parse(await readFile(`${packageRoot}/package.json`, 'utf8'));",
    'const declarationReport = projectPreparedDeclarationSurface({',
    '  packageRoot,',
    '  packageJson,',
    "  title: 'SDK public declaration report',",
    '  bundledDependencies: packageJson.bundledDependencies ?? [],',
    '}).declarationReport;',
    "process.stdout.write(createHash('sha256').update(declarationReport).digest('hex'));",
  ].join('\n');
  const projectFrom = (cwd) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', projectionScript], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
    return result.stdout;
  };

  assert.equal(projectFrom(REPOSITORY_ROOT), projectFrom(packageRoot));
});

test('consumer typechecks leave generated surface publication to its owning input changes', async () => {
  for (const name of ['plugin-ui', 'sdk']) {
    const { scripts } = JSON.parse(await readFile(join(REPOSITORY_ROOT, `packages/${name}/package.json`), 'utf8'));
    const command = scripts['typecheck:local'];
    assert.doesNotMatch(command, /generate:|api-governance|prepare:declarations/u,
      `${name} source checking must consume the already prepared public inputs`);
  }
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
    'node ./scripts/bundleWorkspaceDeps.mjs --declarations --run-script=prepare:api-governance:prepared',
  );
  assert.equal(
    pluginSdkPackage.scripts['prepare:api-governance:prepared'],
    'pnpm --silent run prepare:declarations:prepared && node ./scripts/apiSurfaceCli.mjs --materialize-source --write && pnpm --silent run build:compiled',
  );
  assert.equal(
    pluginSdkPackage.scripts['check:api-governance'],
    'node ./scripts/bundleWorkspaceDeps.mjs --declarations --run-script=check:api-governance:locked',
  );
  assert.equal(
    pluginSdkPackage.scripts['check:api-governance:locked'],
    'pnpm --silent run check:prepare:api-governance:prepared && node ../../scripts/api-governance/cli.mjs --profile plugin-sdk --check',
    'The locked governance transaction must end with the one full-publisher output plan so capability-matrix.json derivation is validated after declaration preparation',
  );
  assert.equal(
    pluginSdkPackage.scripts['check:api-governance:prepared'],
    'node ../../scripts/api-governance/cli.mjs --profile plugin-sdk --check --source-prepared',
  );
  assert.equal(
    pluginSdkPackage.scripts['check:prepare:api-governance'],
    'node ./scripts/bundleWorkspaceDeps.mjs --declarations --run-script=check:prepare:api-governance:prepared',
  );
  assert.equal(
    pluginSdkPackage.scripts['check:prepare:api-governance:prepared'],
    'pnpm --silent run check:action-type-map && node ./scripts/apiSurfaceCli.mjs --materialize-source --check && pnpm --silent run build:compiled',
  );
  assert.match(
    pluginSdkPackage.scripts['test:prepared'],
    /\.\.\/\.\.\/scripts\/api-governance\/apiGovernance\.test\.mjs/u,
    'The finite Plugin SDK test lane must execute the shared governance mutation fixture',
  );
  assert.equal(
    pluginUiPackage.scripts['prepare:declarations'],
    'pnpm --dir ../plugin-sdk --silent run prepare:declarations',
  );
  assert.equal(
    pluginUiPackage.scripts['prepare:api-governance'],
    'pnpm --silent run prepare:declarations && pnpm --dir ../plugin-sdk --silent run check:public-toolchain:prepared && pnpm --silent run build:compiled',
  );
  assert.equal(
    pluginUiPackage.scripts['build:compiled'],
    'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json',
  );
  assert.equal(
    pluginUiPackage.scripts['check:api-governance'],
    'pnpm --silent run prepare:api-governance && node --max-old-space-size=6144 ../../scripts/api-governance/cli.mjs --profile plugin-ui --check',
  );
  assert.match(pluginUiPackage.scripts.prepack, /check:api-governance/u);
  assert.equal(
    pluginUiPackage.scripts['check:api-governance:prepared'],
    'node --max-old-space-size=6144 ../../scripts/api-governance/cli.mjs --profile plugin-ui --check',
  );
  assert.deepEqual(
    ['API.md', 'api-surface.json', 'api-declarations.md'].every((path) => pluginUiPackage.files.includes(path)),
    true,
  );
  assert.equal(
    sdkPackage.scripts['prepare:api-governance'],
    'pnpm --silent run prepare:declarations && node ./scripts/bundleWorkspaceDeps.mjs --artifact && pnpm --silent run build:compiled',
  );
  assert.equal(
    sdkPackage.scripts['check:api-governance'],
    'pnpm --silent run prepare:api-governance && node ../../scripts/api-governance/cli.mjs --profile sdk --check',
  );
  assert.equal(
    sdkPackage.scripts['check:api-governance:prepared'],
    'node ../../scripts/api-governance/cli.mjs --profile sdk --check',
  );
  assert.equal(
    sdkPackage.scripts.prepack,
    'pnpm --silent run check:actions && pnpm --silent run prepare:api-governance && node ../../scripts/api-governance/cli.mjs --profile sdk --write && pnpm --silent run check:api-governance:prepared',
    'SDK prepack must materialize the exact bundled declaration graph and its generated records before governing them',
  );

  const countCompilerInvocations = (packageJson, entrypoint) => {
    const active = new Set();
    const visit = (scriptName) => {
      assert.equal(active.has(scriptName), false, `${packageJson.name} script cycle at ${scriptName}`);
      active.add(scriptName);
      const command = packageJson.scripts[scriptName] ?? '';
      let count = [...command.matchAll(/buildTypeScriptPackageDist\.mjs/gu)].length;
      for (const match of command.matchAll(/pnpm --silent run ([\w:-]+)/gu)) {
        if (packageJson.scripts[match[1]] !== undefined) count += visit(match[1]);
      }
      for (const match of command.matchAll(/--run-script=([\w:-]+)/gu)) {
        if (packageJson.scripts[match[1]] !== undefined) count += visit(match[1]);
      }
      active.delete(scriptName);
      return count;
    };
    return visit(entrypoint);
  };

  for (const packageJson of [pluginSdkPackage, pluginUiPackage, sdkPackage]) {
    const prepack = packageJson.scripts.prepack;
    const effectivePrepack = packageJson.scripts['prepack:prepared'] ?? prepack;
    assert.equal(
      countCompilerInvocations(packageJson, 'prepack'),
      1,
      `${packageJson.name} prepack must compile its exact candidate once`,
    );
    assert.match(effectivePrepack, /check:api-governance:prepared/u);
  }
});

test('the finite public SDK task stages materialization before its mutation guard and source typechecks', async () => {
  const rootPackage = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const turboConfig = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'turbo.json'), 'utf8'));
  const pluginSdkPackage = JSON.parse(await readFile(
    join(REPOSITORY_ROOT, 'packages/plugin-sdk/package.json'),
    'utf8',
  ));
  const pluginUiPackage = JSON.parse(await readFile(
    join(REPOSITORY_ROOT, 'packages/plugin-ui/package.json'),
    'utf8',
  ));
  const sdkPackage = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'packages/sdk/package.json'), 'utf8'));

  assert.equal(
    pluginSdkPackage.scripts['api:finite'],
    'node ./scripts/bundleWorkspaceDeps.mjs --declarations --run-script=api:finite:prepared',
  );
  assert.equal(
    pluginSdkPackage.scripts['api:finite:prepared'],
    'node ../../scripts/api-governance/cli.mjs --profile plugin-sdk --check',
    'The finite governance transaction must verify the one full-publisher output plan, including capability-matrix.json derivation, after declaration preparation',
  );
  assert.equal(
    pluginSdkPackage.scripts['test:finite'],
    'pnpm --silent run test:prepared',
  );
  assert.match(
    pluginSdkPackage.scripts['test:prepared'],
    /node --test .*scripts\/\*\.test\.mjs/u,
  );
  assert.equal(
    pluginUiPackage.scripts['api:finite'],
    'pnpm --dir ../plugin-sdk --silent run check:public-toolchain:prepared && pnpm --silent run check:api-governance:prepared',
  );
  assert.equal(sdkPackage.scripts['api:finite'], 'pnpm --silent run check:api-governance:prepared');
  assert.equal(
    rootPackage.scripts['check:public-sdk:finite:local'],
    'turbo run api:finite test:finite typecheck:finite --filter=@happier-dev/plugin-sdk --filter=@happier-dev/plugin-ui --filter=@happier-dev/sdk --filter=@happier-dev/embed',
  );
  assert.deepEqual(turboConfig.tasks['test:finite'].dependsOn, ['api:finite']);
  assert.deepEqual(turboConfig.tasks['typecheck:finite'].dependsOn, ['api:finite']);
});

test('the plugin-sdk prepared-source profile validates emitted declarations without re-entering source projection', async () => {
  const root = await createPackedPluginSdkFixture();
  try {
    const current = await runApiGovernance({
      profileId: 'plugin-sdk',
      packageRoot: root,
      packageRootKind: 'source-complete-publication-sandbox',
      sourcePrepared: true,
      write: false,
      check: true,
    });

    assert.equal(current.status, 'current');
    assert.deepEqual(current.files.map((file) => file.path), ['api-declarations.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-ui profile gates only its committed census and generates declaration records on demand', async () => {
  const root = await createEntrypointFixture();
  try {
    const sourcePath = join(root, 'src/runtime.ts');
    const sourceBeforeDeclarationDrift = await readFile(sourcePath, 'utf8');
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

    // The declaration report and inventory are generated on demand, not
    // committed: a signature-only change never makes the committed census
    // drift, and a check leaves the generated records untouched.
    const declarationPath = join(root, 'dist/hidden.d.ts');
    const declaration = await readFile(declarationPath, 'utf8');
    await writeFile(
      declarationPath,
      declaration.replace('value?: string;', 'value: string;'),
      'utf8',
    );
    assert.equal(await readFile(sourcePath, 'utf8'), sourceBeforeDeclarationDrift);
    const declarationsBefore = await readFile(join(root, 'api-declarations.md'), 'utf8');

    const signatureOnly = spawnSync(
      process.execPath,
      [CLI_PATH, '--profile', 'plugin-ui', '--package-root', root, '--check'],
      { encoding: 'utf8' },
    );
    assert.equal(signatureOnly.status, 0, signatureOnly.stdout + signatureOnly.stderr);
    assert.equal(await readFile(join(root, 'api-declarations.md'), 'utf8'), declarationsBefore);

    // A check may materialize the generated records for a reader in the same
    // run, still without rewriting a committed record.
    const materialized = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      check: true,
      writeGenerated: true,
    });
    assert.equal(materialized.status, 'current');
    assert.deepEqual(
      materialized.files.filter((file) => file.written).map((file) => [file.path, file.summary]),
      [['api-declarations.md', ['dist/hidden.d.ts — Hidden']]],
    );
    assert.notEqual(await readFile(join(root, 'api-declarations.md'), 'utf8'), declarationsBefore);

    // The committed exported-name census still gates currentness.
    await writeFixtureFile(root, 'src/index.public.ts', [
      "export { added, run } from './runtime.js';",
      '',
    ].join('\n'));
    await writeFile(declarationPath.replace('hidden.d.ts', 'index.d.ts'), [
      "export declare function run(): import('./hidden.js').Hidden;",
      'export declare const added: 1;',
      '',
    ].join('\n'), 'utf8');
    const drift = spawnSync(
      process.execPath,
      [CLI_PATH, '--profile', 'plugin-ui', '--package-root', root, '--check'],
      { encoding: 'utf8' },
    );
    assert.equal(drift.status, 1, drift.stderr);
    assert.match(drift.stdout, /drift authorApiMarkdown API\.md/u);
    assert.doesNotMatch(drift.stdout, /api-surface\.json|api-declarations\.md/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-ui census releases the declaration graph before reading author source', async () => {
  const root = await createEntrypointFixture();
  try {
    // Each graph fits this heap on its own; retaining both compiler graphs
    // reproduces the public plugin-ui command's measured heap exhaustion.
    const declarations = Array.from({ length: 12_000 }, (_, index) => (
      `interface Private${index} { readonly id: string; readonly value?: number; }`
    )).join('\n');
    await writeFixtureFile(root, 'dist/hidden.d.ts', [
      declarations,
      'export declare class Hidden { value?: string; }',
      '',
    ].join('\n'));
    await writeFixtureFile(root, 'src/runtime.ts', [
      declarations,
      'export class Hidden { value?: string; }',
      'export function run(): Hidden { return new Hidden(); }',
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [
      '--max-old-space-size=128',
      CLI_PATH, '--profile', 'plugin-ui', '--package-root', root, '--write',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /plugin-ui write: current/u);
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.deepEqual(inventory.symbols.map((symbol) => symbol.exportName), ['run']);
    assert.match(await readFile(join(root, 'api-declarations.md'), 'utf8'), /value\?: string/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-ui author census excludes host presentation exports while retaining their package entrypoints', async () => {
  const root = await createEntrypointFixture();
  try {
    const packagePath = join(root, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    packageJson.exports['./presentation'] = {
      types: './dist/presentation/index.d.ts', default: './dist/presentation/index.js',
    };
    packageJson.exports['./presentation/typeScale'] = {
      types: './dist/presentation/typeScale.d.ts', default: './dist/presentation/typeScale.js',
    };
    await writeFixtureFile(root, 'package.json', `${JSON.stringify(packageJson)}\n`);
    await writeFixtureFile(root, 'dist/presentation/index.d.ts', 'export declare const HostRenderer: unique symbol;\n');
    await writeFixtureFile(root, 'dist/presentation/typeScale.d.ts', 'export declare const HostScale: unique symbol;\n');
    await writeFixtureFile(root, 'src/presentation/index.public.ts', 'export declare const HostRenderer: unique symbol;\n');
    await writeFixtureFile(root, 'src/presentation/typeScale/index.public.ts', 'export declare const HostScale: unique symbol;\n');
    const result = await runApiGovernance({ profileId: 'plugin-ui', packageRoot: root, write: true });
    assert.equal(result.status, 'current');
    const census = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.deepEqual(census.entrypoints.map((entry) => entry.specifier), ['.']);
    assert.deepEqual(census.symbols.map((entry) => entry.exportName), ['run']);
    assert.doesNotMatch(await readFile(join(root, 'API.md'), 'utf8'), /HostRenderer|HostScale|\.\/presentation/u);
    assert.deepEqual(JSON.parse(await readFile(packagePath, 'utf8')).exports, packageJson.exports);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-ui profile requires an author-owned source spec for every public entrypoint', async () => {
  const root = await createEntrypointFixture();
  try {
    await rm(join(root, 'src/index.public.ts'));
    await assert.rejects(
      () => runApiGovernance({
        profileId: 'plugin-ui',
        packageRoot: root,
        write: false,
        check: true,
      }),
      /author-owned source spec.*src\/index\.public\.ts/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-ui profile verifies an extracted final candidate that carries no author source', async () => {
  // A published tarball ships `dist` and the tracked records, never `src`, so
  // the author-owned source spec is a source-side contract that cannot be
  // re-checked against the exact final candidate.
  const root = await createEntrypointFixture();
  try {
    await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      packageRootKind: 'source-complete-publication-sandbox',
      write: true,
      check: false,
    });
    await rm(join(root, 'src'), { recursive: true, force: true });

    const current = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      packageRootKind: 'extracted-final-candidate',
      write: false,
      check: true,
    });
    assert.equal(current.status, 'current');
    assert.equal(current.summary.changedFiles, 0);

    await writeFile(join(root, 'dist/hidden.d.ts'), [
      'export declare class Hidden {',
      '  value: string;',
      '}',
      '',
    ].join('\n'), 'utf8');
    const drift = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      packageRootKind: 'extracted-final-candidate',
      write: false,
      check: true,
    });
    assert.equal(drift.status, 'drift');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-ui profile rejects an unknown package root kind', async () => {
  const root = await createEntrypointFixture();
  try {
    await assert.rejects(
      () => runApiGovernance({
        profileId: 'plugin-ui',
        packageRoot: root,
        packageRootKind: 'packed-candidate',
        write: false,
        check: true,
      }),
      /Unknown plugin-ui packageRootKind: packed-candidate/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-ui profile rejects a source spec export absent from prepared declarations', async () => {
  const root = await createEntrypointFixture();
  try {
    await writeFile(join(root, 'src/index.public.ts'), [
      "export { Hidden, run } from './runtime.js';",
      '',
    ].join('\n'), 'utf8');

    await assert.rejects(
      () => runApiGovernance({
        profileId: 'plugin-ui',
        packageRoot: root,
        write: false,
        check: true,
      }),
      /prepared declarations are missing source-spec export \.:Hidden:value/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the shared governance owner resolves complete qualified same-package references', async () => {
  const root = await createEntrypointFixture();
  try {
    // Every surface below reaches `Types.Hidden` through a qualified name whose
    // left identifier is a module or re-export namespace, the shape the report
    // must still traverse to the reached member declaration.
    await writeFixtureFile(root, 'dist/types.d.ts', [
      'export type Hidden = {',
      '    value?: string;',
      '};',
      'export declare const value: Hidden;',
      '',
    ].join('\n'));
    await writeFixtureFile(root, 'dist/reexport.d.ts', [
      "export * as Types from './types.js';",
      '',
    ].join('\n'));
    await writeFixtureFile(root, 'src/index.public.ts', [
      "export { runQuery, runReexport, runRef } from './runtime.js';",
      '',
    ].join('\n'));
    await writeFixtureFile(root, 'dist/index.d.ts', [
      "import * as Types from './types.js';",
      'export declare function runRef(): Types.Hidden;',
      'export declare function runQuery(): typeof Types.value;',
      "export declare function runReexport(): import('./reexport.js').Types.Hidden;",
      '',
    ].join('\n'));

    await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: true,
      check: false,
    });
    const written = await readFile(join(root, 'api-declarations.md'), 'utf8');
    assert.match(written, /### `dist\/types\.d\.ts` — `Hidden`/u);
    assert.match(written, /### `dist\/types\.d\.ts` — `value`/u);

    // Adversarial optional-to-required change inside the qualified member must
    // surface in the regenerated declaration report, naming that member.
    await writeFixtureFile(root, 'dist/types.d.ts', [
      'export type Hidden = {',
      '    value: string;',
      '};',
      'export declare const value: Hidden;',
      '',
    ].join('\n'));

    const regenerated = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      check: true,
      writeGenerated: true,
    });
    assert.deepEqual(
      regenerated.files.find((file) => file.path === 'api-declarations.md')?.summary,
      ['dist/types.d.ts — Hidden'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the plugin-sdk profile keeps an extracted final candidate check-only', async () => {
  await assert.rejects(
    () => runApiGovernance({
      profileId: 'plugin-sdk',
      packageRoot: join(tmpdir(), 'not-read-before-write-is-rejected'),
      packageRootKind: 'extracted-final-candidate',
      write: true,
      check: false,
    }),
    /Packed plugin-sdk declaration verification is check-only/u,
  );
});

test('the plugin-sdk profile verifies a packed candidate declaration graph without source files', async () => {
  const root = await createPackedPluginSdkFixture();
  try {
    const current = await runApiGovernance({
      profileId: 'plugin-sdk',
      packageRoot: root,
      packageRootKind: 'extracted-final-candidate',
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
      packageRootKind: 'extracted-final-candidate',
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
        packageRootKind: 'extracted-final-candidate',
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
      "export declare function usesQualifiedExternal(): import('@fixture/external').External.Nested;",
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
    // A qualified reference into a truly external, independently versioned
    // namespace stays a dependency edge named by the reached member.
    assert.match(beforeArtifactBundle, /`@fixture\/external#Nested`/u);
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

test('generic profiles persist the Plugin SDK structured deprecation facts from prepared declarations', async () => {
  for (const [profileId, packageName] of [
    ['plugin-ui', '@happier-dev/plugin-ui'],
    ['sdk', '@happier-dev/sdk'],
  ]) {
    const root = await createEntrypointFixture(packageName);
    try {
      await writeFile(join(root, 'dist/current-run.d.ts'), [
        "export declare function legacyRun(): import('./hidden.js').Hidden;",
        '',
      ].join('\n'), 'utf8');
      await writeFile(join(root, 'dist/index.d.ts'), [
        '/** @deprecated CurrentRun; remove when callers migrate to CurrentRun */',
        "export { legacyRun as run } from './current-run.js';",
        '',
      ].join('\n'), 'utf8');

      await runApiGovernance({
        profileId,
        packageRoot: root,
        write: true,
        check: false,
      });

      const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
      assert.deepEqual(inventory.symbols, [{
        specifier: '.',
        exportName: 'run',
        kind: 'value',
        declarationModule: 'dist/index.d.ts',
        declarationExport: 'run',
        replacement: 'CurrentRun',
        removalCondition: 'callers migrate to CurrentRun',
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('generic profiles retain structured deprecation facts declared behind an unannotated re-export', async () => {
  const root = await createEntrypointFixture('@happier-dev/plugin-ui');
  try {
    await writeFile(join(root, 'dist/legacy-run.d.ts'), [
      '/** @deprecated CurrentRun; remove when callers migrate to CurrentRun */',
      'export declare function legacyRun(): void;',
      '',
    ].join('\n'), 'utf8');
    await writeFile(
      join(root, 'dist/index.d.ts'),
      "export { legacyRun as run } from './legacy-run.js';\n",
      'utf8',
    );

    await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      write: true,
      check: false,
    });

    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.deepEqual(inventory.symbols, [{
      specifier: '.',
      exportName: 'run',
      kind: 'value',
      declarationModule: 'dist/index.d.ts',
      declarationExport: 'run',
      replacement: 'CurrentRun',
      removalCondition: 'callers migrate to CurrentRun',
    }]);

    const declarationPath = join(root, 'dist/legacy-run.d.ts');
    await writeFile(declarationPath, [
      '/** @deprecated CurrentRunV2; remove when callers migrate to CurrentRunV2 */',
      'export declare function legacyRun(): void;',
      '',
    ].join('\n'), 'utf8');
    const regenerated = await runApiGovernance({
      profileId: 'plugin-ui',
      packageRoot: root,
      check: true,
      writeGenerated: true,
    });
    assert.equal(regenerated.status, 'current');
    assert.deepEqual(
      regenerated.files.filter((file) => file.written).map((file) => file.path),
      ['api-surface.json'],
    );
    assert.equal(
      JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8')).symbols[0].replacement,
      'CurrentRunV2',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generic profiles reject deprecation prose outside the Plugin SDK structured form', async () => {
  const root = await createEntrypointFixture('@happier-dev/plugin-ui');
  try {
    await writeFile(join(root, 'dist/index.d.ts'), [
      '/** @deprecated Use CurrentRun */',
      "export declare function run(): import('./hidden.js').Hidden;",
      '',
    ].join('\n'), 'utf8');

    await assert.rejects(
      () => runApiGovernance({
        profileId: 'plugin-ui',
        packageRoot: root,
        write: true,
        check: false,
      }),
      /must document a deprecation as "@deprecated <replacement>; remove when <condition>"/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generic profiles stamp provenance only from the supplied published baseline inventory', async () => {
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
    await writeFixtureFile(root, 'src/index.public.ts', [
      "export { added, run } from './runtime.js';",
      '',
    ].join('\n'));
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
    // Publication provenance lives only in the generated inventory, so an
    // ordinary check never treats it as committed drift.
    assert.equal(ordinaryCheck.status, 'current');
    assert.equal(ordinaryCheck.summary.changedFiles, 0);

    await writeFile(
      declarationPath,
      `${await readFile(declarationPath, 'utf8')}\nexport declare const unpublished: 1;\n`,
      'utf8',
    );
    await writeFixtureFile(root, 'src/index.public.ts', [
      "export { added, run, unpublished } from './runtime.js';",
      '',
    ].join('\n'));
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
        { exportName: 'added', since: undefined },
        { exportName: 'run', since: undefined },
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
