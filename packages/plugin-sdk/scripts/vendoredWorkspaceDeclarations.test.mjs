import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { assertVendoredWorkspaceDeclarationsAreCurrent } from './vendoredWorkspaceDeclarations.mjs';

/**
 * Builds a throwaway repository whose layout matches the real one: a workspace
 * package under `packages/<name>`, the yarn workspace link the package name
 * resolves through, and — optionally — the physical vendored copy
 * `bundleWorkspaceDeps` publishes under the host package's own `node_modules`.
 */
async function createRepoFixture({ vendoredDeclarations }) {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'vendored-declarations-'));
  const packageRoot = resolve(repoRoot, 'packages', 'plugin-sdk');
  const workspaceRoot = resolve(repoRoot, 'packages', 'protocol');

  await writeFile(resolve(repoRoot, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`);
  await writeFile(resolve(repoRoot, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(resolve(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

  await mkdir(resolve(workspaceRoot, 'dist', 'plugins'), { recursive: true });
  await writeFile(
    resolve(workspaceRoot, 'package.json'),
    `${JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }, null, 2)}\n`,
  );
  await writeFile(
    resolve(workspaceRoot, 'dist', 'plugins', 'manifest.d.ts'),
    'export type PluginDeclarativeNodeV2 = { kind: string };\n',
  );
  await writeFile(resolve(workspaceRoot, 'dist', 'plugins', 'manifest.js'), 'export {};\n');

  await mkdir(resolve(repoRoot, 'node_modules', '@happier-dev'), { recursive: true });
  await symlink(
    resolve(repoRoot, 'packages', 'protocol'),
    resolve(repoRoot, 'node_modules', '@happier-dev', 'protocol'),
  );

  await mkdir(packageRoot, { recursive: true });
  if (vendoredDeclarations) {
    const vendorRoot = resolve(packageRoot, 'node_modules', '@happier-dev', 'protocol');
    await mkdir(vendorRoot, { recursive: true });
    await writeFile(
      resolve(vendorRoot, 'package.json'),
      `${JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }, null, 2)}\n`,
    );
    for (const [relativePath, contents] of Object.entries(vendoredDeclarations)) {
      const absolutePath = resolve(vendorRoot, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents);
    }
  }

  return { repoRoot, packageRoot, workspaceRoot };
}

async function createPreparedRepoFixture(t, vendoredDeclarations = null) {
  const fixture = await createRepoFixture({ vendoredDeclarations });
  const { repoRoot, packageRoot, workspaceRoot } = fixture;
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await writeFile(resolve(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugin-sdk',
    bundledDependencies: ['@happier-dev/protocol'] }));
  await writeFile(resolve(workspaceRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol',
    version: '0.0.0', type: 'module', main: './dist/plugins/manifest.js', types: './dist/plugins/manifest.d.ts' }));
  const common = resolve(repoRoot, 'packages/cli-common');
  await mkdir(resolve(common, 'dist/workspaces'), { recursive: true });
  await writeFile(resolve(common, 'package.json'), JSON.stringify({ name: '@happier-dev/cli-common', type: 'module' }));
  // Admitted producer outputs are the filesystem boundary. The package graph,
  // loader, preparation adapter, physical copier and freshness check stay real.
  await writeFile(resolve(common, 'dist/workspaces/index.js'),
    `export * from ${JSON.stringify(new URL('../../cli-common/src/workspaces/index.ts', import.meta.url).href)};\n`);
  const scriptUrl = new URL('./bundleWorkspaceDeps.mjs', import.meta.url);
  const source = (await readFile(scriptUrl, 'utf8')).replace(/(from\s+)'(\.[^']+)'/g,
    (_match, prefix, relativePath) => `${prefix}${JSON.stringify(new URL(relativePath, scriptUrl).href)}`);
  await mkdir(resolve(packageRoot, 'scripts'), { recursive: true });
  await writeFile(resolve(packageRoot, 'scripts/bundleWorkspaceDeps.mjs'), source);
  return fixture;
}

test('next SDK publication re-vendors changed Protocol declarations from the worker publication once', async (t) => {
  const { preparePluginSdkWorkspaceDeclarations } = await import('./bundleWorkspaceDeps.mjs');
  const { repoRoot, packageRoot, workspaceRoot } = await createPreparedRepoFixture(t);
  const publish = () => preparePluginSdkWorkspaceDeclarations({ repoRoot, pluginSdkDir: packageRoot,
    env: { ...process.env, HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1' },
    consumePreparedWorkspace: () => assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot, repoRoot }) });
  await publish();
  const declaration = resolve(workspaceRoot, 'dist/plugins/manifest.d.ts');
  const vendor = resolve(packageRoot, 'node_modules/@happier-dev/protocol/dist/plugins/manifest.d.ts');
  await writeFile(declaration, 'export type PluginDeclarativeNodeV2 = { kind: "current" };\n');
  await assert.rejects(assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot, repoRoot }), /stale/);
  await publish();
  assert.equal(await readFile(vendor, 'utf8'), await readFile(declaration, 'utf8'));
  const published = await stat(vendor, { bigint: true });
  await publish();
  assert.equal((await stat(vendor, { bigint: true })).mtimeNs, published.mtimeNs,
    'unchanged repeated demand must not rewrite the declaration');
  // Reproduce the incident's ordering: Protocol can publish again after the
  // initial copy, while a prepared SDK reader (for example DTO derivation) runs.
  // Publication retains the captured copy; an explicit check still refuses
  // the drift, and the next demand repairs it without rewriting this reader.
  await preparePluginSdkWorkspaceDeclarations({ repoRoot, pluginSdkDir: packageRoot,
    env: { ...process.env, HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1' },
    consumePreparedWorkspace: async ({ preparedWorkspaceEnv }) => {
      const captured = await readFile(vendor, 'utf8');
      await writeFile(declaration, 'export type PluginDeclarativeNodeV2 = { kind: "newer" };\n');
      await assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot, repoRoot,
        env: preparedWorkspaceEnv, allowCapturedPublication: true });
      assert.equal(await readFile(vendor, 'utf8'), captured);
      await assert.rejects(assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot, repoRoot,
        env: preparedWorkspaceEnv }), /stale/);
      await writeFile(vendor, 'export type PluginDeclarativeNodeV2 = never;\n');
      await assert.rejects(assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot, repoRoot,
        env: preparedWorkspaceEnv, allowCapturedPublication: true }), /stale/);
    } });
  await publish();
  assert.equal(await readFile(vendor, 'utf8'), await readFile(declaration, 'utf8'));
});

test('freshness remediation regenerates and prunes the closure on the consuming worker', async t => {
  const { repoRoot, packageRoot, workspaceRoot } = await createPreparedRepoFixture(t, {
    'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = never;\n',
    'dist/plugins/retired.d.ts': 'export type RetiredV1 = string;\n',
  });
  let command;
  await assert.rejects(assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot, repoRoot }), error => {
    command = error.message.match(/Refresh it from packages\/plugin-sdk with: (.+)/)?.[1];
    return typeof command === 'string';
  });
  const [executable, ...args] = command.split(' ');
  assert.equal(executable, 'node');
  await promisify(execFile)(process.execPath, args, { cwd: packageRoot,
    env: { ...process.env, HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1' } });
  await assert.doesNotReject(assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot, repoRoot }));
  const vendor = resolve(packageRoot, 'node_modules/@happier-dev/protocol/dist/plugins/manifest.d.ts');
  assert.equal(await readFile(vendor, 'utf8'), await readFile(resolve(workspaceRoot, 'dist/plugins/manifest.d.ts'), 'utf8'));
});

test('SDK validation entrypoints prepare stale worker declarations before consuming them', async t => {
  const { runPluginSdkPreparedScript } = await import('./bundleWorkspaceDeps.mjs');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const scriptName of ['test:source', 'typecheck:finite']) await t.test(scriptName, async t => {
    const { repoRoot, packageRoot } = await createPreparedRepoFixture(t, {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = never;\n',
      'dist/plugins/retired.d.ts': 'export type RetiredV1 = string;\n',
    });
    const scripts = Object.fromEntries(Object.entries(manifest.scripts).map(([name, command]) => [name,
      // Compiler/test-runner subprocesses are the system boundary. The public
      // package script graph and declaration preparation run unchanged.
      command.replace('vitest run --config vitest.source.config.ts', 'node ./scripts/consume.mjs')
        .replace('node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.tests.json',
          'node ./scripts/consume.mjs'),
    ]));
    const fixtureManifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    await writeFile(resolve(packageRoot, 'package.json'), JSON.stringify({ ...fixtureManifest, scripts }));
    await writeFile(resolve(packageRoot, 'scripts/consume.mjs'),
      `import { assertVendoredWorkspaceDeclarationsAreCurrent } from ${JSON.stringify(new URL('./vendoredWorkspaceDeclarations.mjs', import.meta.url).href)};\n`
      + `await assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot: ${JSON.stringify(packageRoot)}, repoRoot: ${JSON.stringify(repoRoot)} });\n`);
    await assert.doesNotReject(runPluginSdkPreparedScript(scriptName, { pluginSdkDir: packageRoot,
      env: { ...process.env, HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1' } }));
  });
});

test('vendored declaration freshness accepts a package that resolves through the workspace link', async () => {
  const fixture = await createRepoFixture({ vendoredDeclarations: null });
  try {
    await assertVendoredWorkspaceDeclarationsAreCurrent({
      packageRoot: fixture.packageRoot,
      repoRoot: fixture.repoRoot,
    });
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness accepts a copy whose declarations match the workspace build', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = { kind: string };\n',
      'dist/plugins/manifest.js': 'export {};\n',
    },
  });
  try {
    await assertVendoredWorkspaceDeclarationsAreCurrent({
      packageRoot: fixture.packageRoot,
      repoRoot: fixture.repoRoot,
    });
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness ignores canonical workspace sync staging copies', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = { kind: string };\n',
      'dist/plugins/manifest.js': 'export {};\n',
    },
  });
  try {
    for (const stagingName of [
      '.protocol.__sync_tmp__.12345',
      '.protocol.__sync_backup__.12345',
    ]) {
      const stagingRoot = resolve(
        fixture.packageRoot,
        'node_modules',
        '@happier-dev',
        stagingName,
      );
      await mkdir(resolve(stagingRoot, 'dist', 'plugins'), { recursive: true });
      await writeFile(
        resolve(stagingRoot, 'dist', 'plugins', 'manifest.d.ts'),
        'export type PluginDeclarativeNodeV2 = never;\n',
      );
    }

    await assert.doesNotReject(
      assertVendoredWorkspaceDeclarationsAreCurrent({
        packageRoot: fixture.packageRoot,
        repoRoot: fixture.repoRoot,
      }),
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness rejects a copy that predates a workspace declaration change', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = never;\n',
      'dist/plugins/manifest.js': 'export {};\n',
    },
  });
  try {
    await assert.rejects(
      assertVendoredWorkspaceDeclarationsAreCurrent({
        packageRoot: fixture.packageRoot,
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.match(error.message, /@happier-dev\/protocol/u);
        assert.match(error.message, /dist\/plugins\/manifest\.d\.ts/u);
        assert.match(error.message, /node \.\/scripts\/bundleWorkspaceDeps\.mjs/u);
        return true;
      },
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness rejects a declaration the workspace build no longer produces', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = { kind: string };\n',
      'dist/plugins/manifest.js': 'export {};\n',
      'dist/plugins/retired.d.ts': 'export type RetiredV1 = string;\n',
    },
  });
  try {
    await assert.rejects(
      assertVendoredWorkspaceDeclarationsAreCurrent({
        packageRoot: fixture.packageRoot,
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.match(error.message, /dist\/plugins\/retired\.d\.ts/u);
        return true;
      },
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness has nothing to assert outside a monorepo checkout', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = never;\n',
    },
  });
  await rm(resolve(fixture.repoRoot, 'pnpm-lock.yaml'), { force: true });
  try {
    await assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot: fixture.packageRoot });
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test('vendored declaration freshness rejects a copy it cannot compare against a workspace package', async () => {
  const fixture = await createRepoFixture({
    vendoredDeclarations: {
      'dist/plugins/manifest.d.ts': 'export type PluginDeclarativeNodeV2 = { kind: string };\n',
    },
  });
  await rm(resolve(fixture.repoRoot, 'node_modules', '@happier-dev', 'protocol'), { force: true });
  try {
    await assert.rejects(
      assertVendoredWorkspaceDeclarationsAreCurrent({
        packageRoot: fixture.packageRoot,
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.match(error.message, /@happier-dev\/protocol/u);
        return true;
      },
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});
