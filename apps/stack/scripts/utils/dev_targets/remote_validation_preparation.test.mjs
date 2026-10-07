import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveYarnCommandInvocation } from '../../../../../scripts/workspaces/execYarnCommand.mjs';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { ensureWorkspacePackagesBuiltForComponent } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';

test('source-test preparation does not admit emitted outputs on cold, current or stale replicas', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-preparation-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  writeFileSync(join(root, 'yarn.lock'), '# fixture\n');
  const cli = join(root, 'apps/cli');
  const protocol = join(root, 'packages/protocol');
  mkdirSync(cli, { recursive: true });
  for (const name of ['ui', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
  }
  mkdirSync(join(protocol, 'src'), { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@fixture/cli', dependencies: { '@fixture/protocol': 'workspace:*' } }));
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({ name: '@fixture/protocol', main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
  writeFileSync(join(protocol, 'compile.mjs'), 'import { mkdirSync, writeFileSync } from "node:fs"; const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true }); writeFileSync(out + "/index.js", "export const value = 1;\\n");');
  const source = join(protocol, 'src/index.ts');
  writeFileSync(source, 'export const value = 1;\n');
  const prepare = async () => {
    for (const componentRelativeDir of ['apps/cli', 'apps/ui', 'packages/plugin-sdk']) {
      await prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir, validationKind: 'source-test' });
    }
  };
  await prepare();
  assert.throws(() => readFileSync(join(protocol, 'dist/index.js')), { code: 'ENOENT' });
  mkdirSync(join(protocol, 'dist'), { recursive: true });
  writeFileSync(join(protocol, 'dist/index.js'), 'export const value = 1;\n');
  await prepare();
  writeFileSync(source, 'export const value = 2;\n');
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist/index.js'), 'utf8'), 'export const value = 1;\n');
});

test('source-test collection follows Protocol source edits and rejects malformed reachable source without dist', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-collection-' });
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const vitestEntry = fileURLToPath(import.meta.resolve('vitest'));
  const source = join(root, 'protocol/src');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(root, 'protocol/package.json'), JSON.stringify({
    name: '@happier-dev/protocol', exports: { '.': { default: './dist/index.js' } },
  }));
  const config = join(root, 'vitest.config.mts');
  writeFileSync(config, `import { createWorkspacePackageSourcesPlugin } from ${JSON.stringify(join(repoRoot, 'scripts/testing/vitestWorkspacePackageResolution.ts'))};
export default { plugins: [createWorkspacePackageSourcesPlugin([{ packageName: '@happier-dev/protocol', packageSourceRoot: ${JSON.stringify(source)} }])], test: { include: ['owner.test.ts'], pool: 'forks', maxWorkers: 1 } };`);
  const writeSourceAndExpectation = value => {
    writeFileSync(join(source, 'index.ts'), `export const value = ${value};\n`);
    writeFileSync(join(root, 'owner.test.ts'), `import { test, expect } from ${JSON.stringify(vitestEntry)}; import { value } from '@happier-dev/protocol'; test('current source', () => expect(value).toBe(${value}));`);
  };
  const invocation = resolveYarnCommandInvocation(['-s', 'vitest', 'run', `--root=${root}`, `--config=${config}`]);
  const collect = () => spawnSync(invocation.command, invocation.args, {
    cwd: join(repoRoot, 'apps/cli'), env: process.env, encoding: 'utf8',
  });
  writeSourceAndExpectation(1);
  let result = collect();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  writeSourceAndExpectation(2);
  result = collect();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  writeFileSync(join(source, 'index.ts'), 'export const value = ;\n');
  result = collect();
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Failed Suites|Transform failed/);
});

test('remote typecheck preparation admits current component declarations without preparing CLI-only runtime dependencies', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-typecheck-declarations-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  writeFileSync(join(root, 'yarn.lock'), '# fixture\n');
  for (const name of ['ui', 'cli', 'server']) {
    const dir = join(root, 'apps', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@fixture/${name}`, dependencies: {
        '@fixture/protocol': 'workspace:*',
        ...(name === 'cli' ? { '@fixture/cli-runtime': 'workspace:*' } : {}),
      },
    }));
  }
  const protocol = join(root, 'packages', 'protocol');
  mkdirSync(join(protocol, 'src'), { recursive: true });
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({
    name: '@fixture/protocol', scripts: { build: 'fixture-compiler' },
    main: './dist/index.js', types: './dist/index.d.ts',
  }));
  const source = join(protocol, 'src', 'index.ts');
  writeFileSync(source, 'export type Value = "first";\n');
  const cliRuntime = join(root, 'packages', 'cli-runtime');
  mkdirSync(join(cliRuntime, 'src'), { recursive: true });
  writeFileSync(join(cliRuntime, 'package.json'), JSON.stringify({
    name: '@fixture/cli-runtime', scripts: { build: 'fixture-compiler' },
    main: './dist/index.js', types: './dist/index.d.ts',
  }));
  writeFileSync(join(cliRuntime, 'src', 'index.ts'), 'export declare const runtimeOnly: true;\n');
  let builds = 0;
  const prepare = () => prepareRemoteValidationWorkspace({
    repoDir: root,
    componentRelativeDir: 'apps/ui',
    validationKind: 'typecheck',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: (dir, options) => ensureWorkspacePackagesBuiltForComponent(dir, {
        ...options,
        // Replace only the compiler/package-manager process boundary; digest admission is real.
        workspaceBuildBoundary: {
          prepareEnv: async (_dir, env) => ({ ...env }),
          runPackageBuild: async (packageDir, { env }) => {
            builds += 1;
            writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export {};\n');
            writeFileSync(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), readFileSync(join(packageDir, 'src', 'index.ts')));
          },
        },
      }),
    }),
  });
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist', 'index.d.ts'), 'utf8'), 'export type Value = "first";\n');
  await prepare();
  assert.equal(builds, 1, 'unchanged declarations reuse content-digest admission');
  writeFileSync(source, 'export type Value = "second";\n');
  await prepare();
  assert.equal(builds, 2);
  assert.equal(readFileSync(join(protocol, 'dist', 'index.d.ts'), 'utf8'), 'export type Value = "second";\n');
  assert.throws(() => readFileSync(join(cliRuntime, 'dist', 'index.js')), { code: 'ENOENT' });
  assert.throws(() => readFileSync(join(cliRuntime, 'dist', 'index.d.ts')), { code: 'ENOENT' });
});

test('artifact-consuming preparation publishes cold outputs, reuses current outputs and rebuilds stale outputs', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-artifact-preparation-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  writeFileSync(join(root, 'yarn.lock'), '# fixture\n');
  for (const name of ['ui', 'cli', 'server']) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(join(root, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, version: '1.0.0' }));
  }
  const sdk = join(root, 'packages/plugin-sdk');
  const protocol = join(root, 'packages/protocol');
  mkdirSync(sdk, { recursive: true });
  mkdirSync(join(protocol, 'src'), { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@fixture/sdk', dependencies: { '@fixture/protocol': '1.0.0' } }));
  writeFileSync(join(protocol, 'package.json'), JSON.stringify({ name: '@fixture/protocol', type: 'module', version: '1.0.0', main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'node compile.mjs' } }));
  const count = join(root, 'builds');
  writeFileSync(join(protocol, 'compile.mjs'), `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'; const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true }); const source = readFileSync('src/index.ts', 'utf8'); writeFileSync(out + '/index.js', source); writeFileSync(out + '/index.d.ts', 'export declare const value: number;'); appendFileSync(${JSON.stringify(count)}, 'build\\n');`);
  const source = join(protocol, 'src/index.ts');
  const prepare = () => prepareRemoteValidationWorkspace({ repoDir: root, componentRelativeDir: 'packages/plugin-sdk', validationKind: 'runtime' });
  writeFileSync(source, 'export const value = 1;\n');
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist/index.js'), 'utf8'), 'export const value = 1;\n');
  await prepare();
  assert.equal(readFileSync(count, 'utf8'), 'build\n');
  writeFileSync(source, 'export const value = 2;\n');
  await prepare();
  assert.equal(readFileSync(join(protocol, 'dist/index.js'), 'utf8'), 'export const value = 2;\n');
  assert.equal(readFileSync(count, 'utf8'), 'build\nbuild\n');
});

test('remote validation preparation delegates component dependency outputs to the canonical workspace owner', async () => {
  const calls = [];
  const publicationCalls = [];
  const result = await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/cli',
    env: { TEST_ENV: '1' },
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async (...args) => {
        calls.push(args);
        return { ok: true, built: ['@happier-dev/plugins-codex'], skipped: [] };
      },
    }),
    loadCliBuildOwner: async () => ({
      resolveCliBundledWorkspacePackageNames: (options) => {
        assert.deepEqual(options, { repoRoot: '/remote/happier' });
        // Exact mixed CLI bundled selection shape: host workspaces plus bundled
        // plugins, as produced by the canonical bundled workspace resolver.
        return ['protocol', 'agents', 'plugins-codex', 'plugins-claude'];
      },
      publishBundledPluginArtifactsAfterWorkspaceBuild: async (options) => {
        publicationCalls.push(options);
        return true;
      },
    }),
  });

  assert.deepEqual(calls, [[
    '/remote/happier/apps/cli',
    { env: { TEST_ENV: '1' }, isolatePluginFailures: true },
  ]]);
  assert.deepEqual(result, {
    ok: true,
    built: ['@happier-dev/plugins-codex'],
    skipped: [],
  });
  assert.deepEqual(publicationCalls, [{
    repoRoot: '/remote/happier',
    workspaceNames: ['protocol', 'agents', 'plugins-codex', 'plugins-claude'],
    env: { TEST_ENV: '1' },
    publicationMode: 'live',
    bundledPluginArtifactPublication: { mode: 'write', targetOwnedOnly: true },
  }]);
});

test('remote development validation isolates an optional plugin at the real package build boundary', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-optional-validation-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/plugins/*'] }));
  writeFileSync(join(root, 'yarn.lock'), '# fixture\n');
  const ui = join(root, 'apps/ui');
  const inspector = join(root, 'packages/plugins/inspector');
  mkdirSync(ui, { recursive: true });
  mkdirSync(join(root, 'apps/cli'), { recursive: true });
  mkdirSync(join(root, 'apps/server'), { recursive: true });
  writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@fixture/cli' }));
  writeFileSync(join(root, 'apps/server/package.json'), JSON.stringify({ name: '@fixture/server' }));
  mkdirSync(inspector, { recursive: true });
  writeFileSync(join(ui, 'package.json'), JSON.stringify({
    name: '@fixture/ui', dependencies: { '@happier-dev/plugins-inspector': 'workspace:*' },
  }));
  writeFileSync(join(inspector, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-inspector', main: './dist/index.js', scripts: { build: 'fixture-compiler' },
  }));
  const result = await prepareRemoteValidationWorkspace({
    repoDir: root, componentRelativeDir: 'apps/ui', validationKind: 'typecheck',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: (dir, options) => ensureWorkspacePackagesBuiltForComponent(dir, {
        ...options, quiet: true,
        workspaceBuildBoundary: {
          prepareEnv: async (_dir, env) => ({ ...env }),
          runPackageBuild: async () => { throw new Error('optional UI compiler failed'); },
        },
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pluginFailures.map((failure) => failure.packageName), ['@happier-dev/plugins-inspector']);
  assert.match(result.pluginFailures[0].diagnostic.message, /optional UI compiler failed/);
});

test('remote validation preparation does not publish CLI projections for unrelated components', async () => {
  let loadedCliOwner = false;
  await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'packages/protocol',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async () => ({ ok: true, built: [], skipped: [] }),
    }),
    loadCliBuildOwner: async () => {
      loadedCliOwner = true;
      throw new Error('unrelated component must not load the CLI publisher');
    },
  });
  assert.equal(loadedCliOwner, false);
});

test('remote UI validation publishes source-derived manifests before component preparation validates plugins', async () => {
  const events = [];
  await prepareRemoteValidationWorkspace({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/ui',
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltForComponent: async (componentDir) => {
        events.push(`prepare:${componentDir}`);
        return { ok: true, built: [], skipped: [] };
      },
    }),
    loadCliBuildOwner: async () => ({
      resolveCliBundledWorkspacePackageNames: () => ['protocol', 'plugins-codex'],
      publishBundledPluginArtifactsAfterWorkspaceBuild: async () => {
        events.push('publish');
        return true;
      },
    }),
  });
  assert.deepEqual(events, [
    'publish',
    'prepare:/remote/happier/apps/ui',
    'prepare:/remote/happier/apps/cli',
  ]);
});

test('remote validation preparation rejects paths outside the synchronized repository', async () => {
  await assert.rejects(
    prepareRemoteValidationWorkspace({
      repoDir: '/remote/happier',
      componentRelativeDir: '../outside',
    }),
    /inside the synchronized repository/i,
  );
});
