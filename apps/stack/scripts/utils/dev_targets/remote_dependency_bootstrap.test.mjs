import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { installWorkspaceAdmissionProcessFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectDependencyRefresh, resolveDependencyRefreshLockPath, withDependencyConsumption, withDependencyRefresh, withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';
import { resolveRemoteCommandPolicy } from './remote_commands.mjs';
import { ensureWorkspacePackagesBuiltForComponent, inspectWorkspaceQaStalePackages, WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveTypeScriptCliInvocation } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { execPnpm } from '../../../../../scripts/workspaces/execPnpmCommand.mjs';
import {
  REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES,
  REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS,
  verifyUiPatchedDependencies,
} from '../../../../ui/tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs';
import { ensureDepsInstalled, ensureServerGeneratedProviderOutputs } from '../proc/pm.mjs';
import { assertDependenciesReady } from '../proc/dependency_refresh.mjs';
import { buildSourceRuntimeBundle } from '../../build/build_source_runtime.mjs';
import { withPnpmInstallGuard } from '../worktrees/pnpm_install_guard.mjs';

import {
  REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS,
  adoptInstalledDependencies,
  bootstrapRemoteDependencies as bootstrapDependencies,
} from './remote_dependency_bootstrap.mjs';

async function setupPrismaFreshness(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-prisma-freshness-' });
  const root = fixture.root;
  const server = join(root, 'apps/server');
  for (const name of ['ui', 'cli', 'server']) await mkdir(join(root, 'apps', name), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', scripts: { 'generate:providers': 'node generate.mjs' } }));
  for (const name of ['ui', 'cli']) await writeFile(join(root, 'apps', name, 'package.json'), '{}');
  const binDir = fixture.path('bin');
  await mkdir(binDir);
  // Only the OS process boundary is replaced; real readiness and custody run.
  await writeFile(join(binDir, 'pnpm'), `#!${process.execPath}
    const fs = require('node:fs');
    const path = require('node:path');
    if (process.argv.includes('--version')) { console.log('12.14.0'); process.exit(0); }
    fs.appendFileSync(${JSON.stringify(join(root, 'generator-invocations.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
    if (process.argv.includes('install')) {
      fs.mkdirSync(${JSON.stringify(join(root, 'node_modules'))}, { recursive: true });
      process.exit(0);
    }
    const server = ${JSON.stringify(server)};
    const input = fs.readFileSync(path.join(server, 'schema-input'), 'utf8');
    const current = fs.readFileSync(path.join(server, 'generated-output'), 'utf8');
    if (process.argv.includes('--check')) process.exit(input === current ? 0 : 1);
    if (!fs.existsSync(${JSON.stringify(join(root, '.project/tmp/dependency-install.lock'))})) process.exit(9);
    if (process.env.HAPPIER_TEST_PRISMA_GENERATION_FAILURE === '1') process.exit(37);
    fs.writeFileSync(path.join(server, 'generated-output'), input);
  `);
  await chmod(join(binDir, 'pnpm'), 0o755);
  await writeFile(join(server, 'schema-input'), 'old');
  await writeFile(join(server, 'generated-output'), 'old');
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    npm_execpath: '', npm_node_execpath: '', HAPPIER_STACK_PM_CACHE_BASE_DIR: fixture.path('cache'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' };
  await withDependencyRefresh({ installDir: root, env }, async () => mkdir(join(root, 'node_modules')));
  return { root, server, env, generationLog: join(root, 'generator-invocations.jsonl') };
}

test('concurrent remote dependency bootstraps inspect fresh generations without exclusive acquisitions', {
  skip: process.platform === 'win32' ? 'Uses the POSIX package-manager executable fixture' : false,
}, async t => {
  const { root, env, generationLog } = await setupPrismaFreshness(t);
  const lockPath = resolveDependencyRefreshLockPath(root, env);
  const dispatch = () => bootstrapDependencies({ repoDir: root, validationKind: 'source-test',
    executionPlacement: 'remote', env, signal: t.signal });
  const callers = 4;
  let acquisitions = 0;
  let queued = 0;
  const allQueued = Promise.withResolvers();
  const link = fs.linkSync;
  fs.linkSync = (source, destination) => {
    const result = link(source, destination);
    if (destination === lockPath) acquisitions++;
    if (destination.startsWith(`${lockPath}.waiters${sep}exclusive-`) && ++queued === callers) allQueued.resolve();
    return result;
  };
  syncBuiltinESMExports();
  try {
    await Promise.all(Array.from({ length: callers }, dispatch));
    assert.equal(acquisitions, 0, 'fresh remote dispatches never join exclusive dependency custody');
    await writeFile(join(root, 'pnpm-lock.yaml'), '# changed remote inputs\n');
    const held = Promise.withResolvers(), release = Promise.withResolvers();
    const holding = withDependencyRefreshLock({ installDir: root, env, signal: t.signal }, async () => {
      held.resolve(); await release.promise;
    });
    await held.promise;
    acquisitions = 0;
    queued = 0;
    const pending = Promise.all(Array.from({ length: callers }, dispatch));
    try {
      await Promise.race([allQueued.promise, pending.then(() => {
        throw new Error('Stale dispatches completed before the held writer was released');
      })]);
    } finally { release.resolve(); }
    await holding;
    const results = await pending;
    assert.equal(results.filter(result => result.refreshed).length, 1, 'one stale caller installs');
    assert.equal(acquisitions, 1, 'other queued dispatches observe publication without taking an exclusive turn');
    const operations = (await readFile(generationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(operations.filter(args => args.includes('install')).length, 1);
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
});

test('concurrent actual-import scopes register shared readers with zero exclusive acquisitions', {
  skip: process.platform === 'win32' ? 'Uses the POSIX package-manager executable fixture' : false,
}, async t => {
  const { root, env } = await setupPrismaFreshness(t);
  const lockPath = resolveDependencyRefreshLockPath(root, env);
  let acquisitions = 0;
  const link = fs.linkSync;
  fs.linkSync = (source, destination) => {
    const result = link(source, destination);
    if (destination === lockPath) acquisitions++;
    return result;
  };
  syncBuiltinESMExports();
  try {
    await Promise.all(Array.from({ length: 4 }, () => withDependencyConsumption({ installDir: root, env }, async () => {
      await assertDependenciesReady({ installDir: root, env, signal: t.signal });
    })));
    assert.equal(acquisitions, 0, 'read-only imports never enter the exclusive writer queue');
    const enter = Promise.withResolvers();
    // Start outside the writer's AsyncLocalStorage: this is an independent
    // arriving consumer, not a prerequisite nested in the active installer.
    const arriving = (async () => {
      await enter.promise;
      return await withDependencyConsumption({ installDir: root, env, wait: false },
        () => assert.fail('an arriving import raced the active writer'));
    })();
    await withDependencyRefreshLock({ installDir: root, env, signal: t.signal }, async () => {
      enter.resolve();
      await assert.rejects(arriving, { code: 'EJSONOWNERFILELOCKBUSY' });
      assert.deepEqual(await readdir(`${lockPath}.readers`), [], 'a rejected import withdraws its reader record');
    });
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
});


test('Prisma readiness rejects a schema-only change and generation repairs it under the dependency writer', async t => {
  const { root, server, env } = await setupPrismaFreshness(t);
  await assertDependenciesReady({ installDir: root, env });
  await writeFile(join(server, 'schema-input'), 'new');
  await assert.rejects(assertDependenciesReady({ installDir: root, env }), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH', reason: 'prisma-outputs-incomplete' });
  assert.equal(await readFile(join(server, 'generated-output'), 'utf8'), 'old', 'readiness is read-only');
  await ensureServerGeneratedProviderOutputs(server, root, { env, quiet: true, signal: t.signal });
  assert.equal(await readFile(join(server, 'generated-output'), 'utf8'), 'new');
  await assertDependenciesReady({ installDir: root, env });
});

test('local source-test bootstrap has zero dependency waits behind a writer draining an old typecheck reader', async t => {
  const { root, env } = await setupPrismaFreshness(t);
  const lockPath = resolveDependencyRefreshLockPath(root, env);
  const consuming = Promise.withResolvers(), release = Promise.withResolvers(), acquired = Promise.withResolvers();
  const reader = withDependencyConsumption({ installDir: root, env }, async () => {
    consuming.resolve(); await release.promise;
  });
  await consuming.promise;
  const link = fs.linkSync;
  fs.linkSync = (source, destination) => {
    const result = link(source, destination);
    if (destination === lockPath) acquired.resolve();
    return result;
  };
  syncBuiltinESMExports();
  const writer = withDependencyRefreshLock({ installDir: root, env }, async () => {});
  await acquired.promise;
  fs.linkSync = link; syncBuiltinESMExports();
  let waits = 0, installs = 0;
  const cancellation = new AbortController();
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).includes(lockPath) && String(chunk).includes('dependency refresh lock')) {
      waits++; cancellation.abort(new Error('warm source-test bootstrap waited'));
    }
    return write.call(this, chunk, ...args);
  };
  try {
    await bootstrapDependencies({ repoDir: root, validationKind: 'source-test',
      componentRelativeDir: 'apps/server', executionPlacement: 'local', signal: cancellation.signal,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' },
      installInitialDependencies: async () => { installs++; } })
      .catch(error => { if (!cancellation.signal.aborted) throw error; });
  } finally {
    process.stderr.write = write; release.resolve(); await reader; await writer;
  }
  assert.equal(waits, 0);
  assert.equal(installs, 0);
});


test('Prisma warm worker bootstrap repairs schema-only changes without reinstalling dependencies', async t => {
  const { root, server, env } = await setupPrismaFreshness(t);
  await writeFile(join(server, 'schema-input'), 'new worker schema');
  await bootstrapDependencies({ repoDir: root, executionPlacement: 'remote', toolsOnly: true, env,
    installInitialDependencies: async () => assert.fail('schema-only changes must not reinstall dependencies') });
  assert.equal(await readFile(join(server, 'generated-output'), 'utf8'), 'new worker schema');
  await assertDependenciesReady({ installDir: root, env });
});

test('cold worker installation prepares generated providers once at producer completion and warm reuse publishes nothing', async t => {
  const { root, server, env, generationLog } = await setupPrismaFreshness(t);
  await rm(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(server, 'schema-input'), 'cold worker schema');
  const workerEnv = { ...env, HAPPIER_DEV_TARGET_EXECUTION: '1' };
  const bootstrap = () => bootstrapDependencies({ repoDir: root, executionPlacement: 'remote', toolsOnly: true, env: workerEnv });
  await bootstrap();
  assert.equal(await readFile(join(server, 'generated-output'), 'utf8'), 'cold worker schema');
  const invocations = async () => (await readFile(generationLog, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(args => args.includes('generate:providers'));
  const cold = await invocations();
  assert.equal(cold.filter(args => !args.includes('--check')).length, 1, 'the completed install must publish its real generated output');
  // One canonical stale-output repair checks before and inside its writer
  // custody. An earlier install-phase check repeats the same observation.
  assert.ok(cold.filter(args => args.includes('--check')).length <= 2,
    'one cold install must not run a separate provider-readiness phase before its completion owner');
  await bootstrap();
  const warm = await invocations();
  assert.equal(warm.filter(args => !args.includes('--check')).length, 1, 'unchanged warm input must not publish generated output again');
  assert.ok(warm.length - cold.length <= 1, 'warm reuse only verifies the published output');
  assert.equal(await readFile(join(server, 'generated-output'), 'utf8'), 'cold worker schema');
  await writeFile(join(server, 'schema-input'), 'failed warm schema');
  await assert.rejects(bootstrapDependencies({ repoDir: root, executionPlacement: 'remote', toolsOnly: true,
    env: { ...workerEnv, HAPPIER_TEST_PRISMA_GENERATION_FAILURE: '1' },
    installInitialDependencies: async () => assert.fail('an output-only failure must not reinstall dependencies'),
  }), error => error.exitCode === 37 && error.code !== 'HAPPIER_DEPENDENCY_REFRESH_FAILED');
  assert.equal((await invocations()).filter(args => !args.includes('--check')).length, 2,
    'the failed warm output producer runs once and is not replayed');
  assert.equal(await readFile(join(server, 'generated-output'), 'utf8'), 'cold worker schema');
});

test('Prisma source preparation repairs schemas before entering compilation; failed repair remains stale', async t => {
  const { root, server, env } = await setupPrismaFreshness(t);
  await writeFile(join(server, 'schema-input'), 'new source');
  const failingEnv = { ...env, HAPPIER_TEST_PRISMA_GENERATION_FAILURE: '1' };
  await assert.rejects(buildSourceRuntimeBundle({ repoDir: root, stackBaseDir: join(root, 'stacks/fixture'),
    component: 'server', env: failingEnv, signal: t.signal }), { exitCode: 37 });
  assert.equal(await readFile(join(server, 'generated-output'), 'utf8'), 'old');
  await assert.rejects(assertDependenciesReady({ installDir: root, env }), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH', reason: 'unfinished-installation' });
  // This fixture deliberately has no compiler: fingerprinting must only reach
  // that missing boundary after the real source preparation repaired outputs.
  await assert.rejects(buildSourceRuntimeBundle({ repoDir: root, stackBaseDir: join(root, 'stacks/fixture'),
    component: 'server', env, signal: t.signal }), { code: 'MODULE_NOT_FOUND' });
  assert.equal(await readFile(join(server, 'generated-output'), 'utf8'), 'new source');
});

test('remote dev startup refreshes a stale installed tree before publishing readiness', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-remote-dev-refresh-' });
  await mkdir(fixture.path('apps', 'stack'), { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('apps', 'stack', 'package.json'), '{"name":"fixture-stack"}');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# stale fixture\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n");
  const installer = fixture.path('pnpm.cjs');
  const installed = fixture.path('install-attempt');
  await writeFile(installer, `require('node:fs').writeFileSync(${JSON.stringify(installed)}, 'called'); process.exit(43);`);
  const binDir = fixture.path('bin');
  await mkdir(binDir);
  await writeFile(join(binDir, 'pnpm'), `#!${process.execPath}\nrequire(${JSON.stringify(installer)});\n`);
  await chmod(join(binDir, 'pnpm'), 0o755);
  await writeFile(join(binDir, 'pnpm.cmd'), `@"${process.execPath}" "${installer}" %*\r\n`);
  await assert.rejects(bootstrapDependencies({ repoDir: fixture.root, executionPlacement: 'remote', toolsOnly: true,
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`, npm_execpath: installer,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '',
      HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_ENV_FILE: '' } }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(await readFile(installed, 'utf8'), 'called');
  await assert.rejects(readFile(fixture.path('node_modules/.happier-stack-dependencies-ready')), { code: 'ENOENT' });
});

// These fixtures model worker mirrors; explicit local-policy cases below
// exercise the same refresh owner on the primary checkout.
const bootstrapRemoteDependencies = options => bootstrapDependencies({ executionPlacement: 'remote', ...options });

test('worker bootstrap restores server generated dependencies before publishing readiness', {
  skip: process.platform === 'win32' ? 'Exercises the POSIX package-manager executable boundary' : false,
}, async t => {
  for (const owner of ['bootstrap', 'package-manager', 'worktree']) for (const failGeneration of [false, true]) await t.test(`${owner}: ${failGeneration ? 'generation failure withholds admission' : 'generated client precedes admission'}`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'happier-worker-server-generation-' });
    await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@12.14.0' }));
    await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
    await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    for (const component of ['stack', 'ui', 'cli', 'server']) {
      await mkdir(fixture.path('apps', component), { recursive: true });
      await writeFile(fixture.path('apps', component, 'package.json'), JSON.stringify({
        name: component === 'server' ? '@happier-dev/server' : `@fixture/${component}`,
        ...(component === 'server' ? { scripts: { 'generate:providers': 'node generate.mjs' } } : {}),
      }));
    }
    const marker = fixture.path('node_modules', '.happier-stack-dependencies-ready');
    const generated = fixture.path('node_modules', '.prisma', 'client', 'index.js');
    const binDir = fixture.path('bin');
    await mkdir(binDir);
    // Only the package-manager process is replaced: real bootstrap, the shared
    // server prerequisite producer, writer locking and readiness remain live.
    await writeFile(join(binDir, 'pnpm'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('12.14.0'); process.exit(0); }
if (args.includes('--check')) process.exit(fs.existsSync(${JSON.stringify(generated)}) ? 0 : 1);
if (!fs.existsSync(${JSON.stringify(fixture.path('.project', 'tmp', 'dependency-install.lock'))})) throw new Error('Missing install custody');
if (fs.existsSync(${JSON.stringify(marker)})) throw new Error('Premature admission');
if (args[0] === 'install') {
  fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.14.0\\nnodeLinker: hoisted\\n');
} else if (args.join(' ') === '--filter @happier-dev/server run --silent generate:providers') {
  const lockPath = ${JSON.stringify(fixture.path('.project', 'tmp', 'dependency-install.lock'))};
  const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.createdAtMs)) throw new Error('Server generation requires its active dependency writer');
  if (${JSON.stringify(failGeneration)}) process.exit(47);
  fs.mkdirSync(path.dirname(${JSON.stringify(generated)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(generated)}, 'module.exports = { PrismaClient: class PrismaClient {} };\\n');
} else throw new Error('Unexpected package-manager operation');
`);
    await chmod(join(binDir, 'pnpm'), 0o755);
    const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      npm_execpath: '', npm_node_execpath: '', HAPPIER_DEV_TARGET_EXECUTION: '1',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '',
      HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_ENV_FILE: '' };
    const prepare = owner === 'bootstrap'
      ? bootstrapRemoteDependencies({ repoDir: fixture.root, validationKind: 'source-test', componentRelativeDir: 'apps/stack', env })
      : owner === 'package-manager'
        ? ensureDepsInstalled(fixture.path('apps', 'cli'), 'fixture CLI', { env, prepareComponentOutputs: false })
        : withPnpmInstallGuard({ installDir: fixture.root, env }, async ({ env: installEnv }) =>
            execPnpm(REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS, { cwd: fixture.root, env: installEnv }));
    if (failGeneration) {
      await assert.rejects(prepare, error => error.code === 'HAPPIER_DEPENDENCY_REFRESH_FAILED'
        && error.cause?.exitCode === 47);
      await assert.rejects(stat(marker), { code: 'ENOENT' });
    } else {
      await prepare;
      assert.equal(typeof createRequire(import.meta.url)(generated).PrismaClient, 'function');
      assert.equal((await inspectDependencyRefresh({ installDir: fixture.root,
        componentDir: owner === 'bootstrap' ? fixture.path('apps', 'stack') : owner === 'package-manager' ? fixture.path('apps', 'cli') : fixture.root,
        env })).required, false);
    }
  });
});

const runDependencyRefreshImmediately = async (_options, refresh) => await refresh({});

test('scriptless CLI bootstrap admits native pnpm patches and repairs warm patch loss through reinstallation', {
  skip: process.platform === 'win32' ? 'Exercises the POSIX package-manager executable boundary' : false,
}, async t => {
  const { root: repoDir } = await createTempFixture(t, { prefix: 'happier-scriptless-all-ui-patches-' });
  const sourceRepoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
  const uiDir = join(repoDir, 'apps/ui');
  const sourceUiDir = join(sourceRepoDir, 'apps/ui');
  const patchedDir = join(repoDir, 'patched-install');
  const require = createRequire(import.meta.url);
  const { parsePatch, reversePatch, applyPatch } = require('diff');
  const { parse, stringify } = require('yaml');
  const workspace = parse(await readFile(join(sourceRepoDir, 'pnpm-workspace.yaml'), 'utf8'));
  await mkdir(uiDir, { recursive: true });
  await cp(join(sourceUiDir, 'tools'), join(uiDir, 'tools'), { recursive: true });
  await cp(join(sourceUiDir, 'app.config.js'), join(uiDir, 'app.config.js'));
  const uiManifest = JSON.parse(await readFile(join(sourceUiDir, 'package.json'), 'utf8'));
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ ...uiManifest, scripts: { 'postinstall:real': 'node tools/postinstall.mjs' } }));
  for (const component of ['stack', 'cli', 'server']) {
    await mkdir(join(repoDir, 'apps', component), { recursive: true });
    await writeFile(join(repoDir, 'apps', component, 'package.json'), JSON.stringify({ name: `@fixture/${component}` }));
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@12.14.0' }));
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), stringify({
    packages: ['apps/*'], patchedDependencies: workspace.patchedDependencies,
  }));
  await cp(join(sourceRepoDir, 'patches'), join(repoDir, 'patches'), { recursive: true });
  await cp(join(sourceRepoDir, 'packages/brand'), join(repoDir, 'packages/brand'), {
    recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/dist'),
  });
  await mkdir(join(patchedDir, 'node_modules'), { recursive: true });
  await writeFile(join(patchedDir, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.14.0\nnodeLinker: hoisted\n');
  const patches = [];
  for (const [selector, patchFile] of Object.entries(workspace.patchedDependencies)) {
    const packageName = selector.slice(0, selector.lastIndexOf('@'));
    const packageDir = join(patchedDir, 'node_modules', packageName);
    await cp(join(sourceRepoDir, 'node_modules', packageName), packageDir, { recursive: true, dereference: true });
    const effects = parsePatch(await readFile(join(sourceRepoDir, patchFile), 'utf8'));
    patches.push({ packageName, effects });
    // The loaded pnpm install supplies these bytes. Reversibility against each
    // authored patch independently proves this fixture did not start pristine.
    for (const effect of effects) {
      const file = effect.newFileName === '/dev/null' ? effect.oldFileName : effect.newFileName;
      const input = await readFile(join(packageDir, file.replace(/^[ab]\//u, '')), 'utf8').catch(error => {
        if (error.code === 'ENOENT' && effect.newFileName === '/dev/null') return '';
        throw error;
      });
      assert.notEqual(applyPatch(input, reversePatch(effect)), false, `Installed native patch is missing: ${selector} ${file}`);
    }
  }
  const removePatch = async ({ packageName, effects }) => {
    const packageDir = join(repoDir, 'node_modules', packageName);
    for (const original of effects) {
      const effect = reversePatch(original);
      const file = effect.oldFileName === '/dev/null' ? effect.newFileName : effect.oldFileName;
      const path = join(packageDir, file.replace(/^[ab]\//u, ''));
      const input = await readFile(path, 'utf8').catch(error => {
        if (error.code === 'ENOENT' && effect.oldFileName === '/dev/null') return '';
        throw error;
      });
      const output = applyPatch(input, effect);
      assert.notEqual(output, false, `Cannot remove fixture patch: ${packageName} ${file}`);
      if (effect.newFileName === '/dev/null') await rm(path);
      else { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, output); }
    }
  };
  assert.ok(patches.some(({ packageName }) => packageName === 'react-native-enriched-markdown'));
  assert.ok(patches.some(({ packageName }) => packageName === '@elevenlabs/client'));
  const binDir = join(repoDir, 'bin');
  const trace = join(repoDir, 'pm-trace.jsonl');
  const marker = join(repoDir, 'node_modules/.happier-stack-dependencies-ready');
  const expectedMarker = join(repoDir, 'expected-marker.json');
  const generationPath = join(repoDir, '.project/tmp/dependency-install.lock.generation');
  const prepareAndVerify = async prepare => {
    const before = await readFile(marker, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    await writeFile(expectedMarker, JSON.stringify(before));
    await prepare();
    verifyUiPatchedDependencies({ uiPackageDir: uiDir });
    const mutation = JSON.parse(await readFile(generationPath, 'utf8'));
    assert.equal(mutation.completedGeneration, mutation.generation,
      'the dependency operation completes only after its patched outputs are ready');
  };
  await mkdir(binDir);
  const packageManager = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('12.14.0'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
if (!fs.existsSync(${JSON.stringify(join(repoDir, '.project/tmp/dependency-install.lock'))})) throw new Error('Dependency mutation escaped its lock');
const actualMarker = fs.existsSync(${JSON.stringify(marker)}) ? fs.readFileSync(${JSON.stringify(marker)}, 'utf8') : null;
if (actualMarker !== JSON.parse(fs.readFileSync(${JSON.stringify(expectedMarker)}, 'utf8'))) throw new Error('Readiness changed before patches completed');
const mutation = JSON.parse(fs.readFileSync(${JSON.stringify(generationPath)}, 'utf8'));
if (!mutation.generation || mutation.generation === mutation.completedGeneration) throw new Error('Dependency mutation completed before patches completed');
if (args[0] === 'install') {
  for (const packageName of ${JSON.stringify(patches.map(({ packageName }) => packageName))}) {
    fs.rmSync(path.join(${JSON.stringify(repoDir)}, 'node_modules', packageName), { recursive: true, force: true });
  }
  fs.cpSync(${JSON.stringify(patchedDir)}, ${JSON.stringify(repoDir)}, { recursive: true });
  for (const packageName of ['esbuild', '@esbuild', 'diff', 'yaml']) {
    const destination = path.join(${JSON.stringify(repoDir)}, 'node_modules', packageName);
    if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
      fs.symlinkSync(path.join(${JSON.stringify(sourceRepoDir)}, 'node_modules', packageName), destination);
    }
  }
} else if (args.join(' ') === '--filter @happier-dev/app run --silent postinstall:real') {
  const result = spawnSync(process.execPath, [${JSON.stringify(join(uiDir, 'tools/postinstall.mjs'))}], { env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else throw new Error('Unexpected package-manager command: ' + JSON.stringify(args));
`;
  for (const name of ['pnpm']) {
    await writeFile(join(binDir, name), packageManager);
    await chmod(join(binDir, name), 0o755);
  }
  const options = { repoDir, validationKind: 'source-test', componentRelativeDir: 'apps/cli', env: {
    ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`, npm_execpath: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '',
    HAPPIER_STACK_HOME_DIR: join(repoDir, 'home'), HAPPIER_STACK_ENV_FILE: '', HAPPIER_UI_VENDOR_WEB_ASSETS: '0',
    HAPPIER_DEV_TARGET_EXECUTION: '1',
  } };
  await prepareAndVerify(() => bootstrapRemoteDependencies(options));
  verifyUiPatchedDependencies({ uiPackageDir: uiDir });
  const output = join(repoDir, 'node_modules/react-native-enriched-markdown/lib/module/web/streamingReveal.js');
  const outputStat = await stat(output);
  const warmTrace = await readFile(trace, 'utf8');
  await prepareAndVerify(() => bootstrapRemoteDependencies(options));
  assert.equal(await readFile(trace, 'utf8'), warmTrace, 'already installed must not rewrite packages or rerun postinstall');
  assert.equal((await stat(output)).mtimeMs, outputStat.mtimeMs);
  // Bootstrap and full-PM/worktree preparation share the same install identity.
  const atmosphere = join(uiDir, 'sources/components/atmosphere/backdropWorkletCore.generated.js');
  await assert.rejects(stat(atmosphere), { code: 'ENOENT' }, 'dependency bootstrap must not compile moving application source');
  const elevenLabs = patches.find(({ packageName }) => packageName === '@elevenlabs/client');
  for (const prepare of [
    () => bootstrapRemoteDependencies(options),
    () => ensureDepsInstalled(join(repoDir, 'apps/cli'), 'fixture CLI', { env: options.env, prepareComponentOutputs: false }),
    () => withPnpmInstallGuard({ installDir: repoDir, env: options.env }, async () => {}),
  ]) {
    await removePatch(elevenLabs);
    await prepareAndVerify(prepare);
    assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, false,
      'canonical pnpm repair must preserve existing full-install admission');
    verifyUiPatchedDependencies({ uiPackageDir: uiDir });
    await assert.rejects(stat(atmosphere), { code: 'ENOENT' }, 'source artifact compilation must not participate in dependency repair');
  }
  await rm(output);
  await prepareAndVerify(() => bootstrapRemoteDependencies(options));
  verifyUiPatchedDependencies({ uiPackageDir: uiDir });
  const commands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(commands.filter(args => args[0] === 'install').length, 5, 'each corrupted native patch tree requires canonical pnpm reinstallation');
  // Local non-UI source tools must also inspect the shared UI patches.
  const otherPatch = patches.find(({ packageName }) => packageName === 'expo-crypto');
  assert.ok(otherPatch);
  await removePatch(otherPatch);
  await prepareAndVerify(() => bootstrapRemoteDependencies({ ...options, executionPlacement: 'local' }));
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, false,
    'local non-UI source tools repair the same shared installed patches');
  verifyUiPatchedDependencies({ uiPackageDir: uiDir });
  assert.equal((await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(args => args[0] === 'install').length, 6);
});

for (const flag of ['HAPPIER_STACK_SKIP_REFRESH_DEPS', 'HAPPIER_STACK_DISABLE_REFRESH_DEPS']) {
  for (const validationKind of ['source-test', 'typecheck']) test(`remote no-refresh admission preserves tree (${flag}, ${validationKind})`, async t => {
    const { root, env: fixtureEnv } = await setupPrismaFreshness(t);
    const env = { ...fixtureEnv, [flag]: '1' };
    const marker = join(root, 'node_modules', '.happier-stack-dependencies-ready');
    const admitted = await readFile(marker, 'utf8');
    await bootstrapDependencies({ repoDir: root, executionPlacement: 'remote', validationKind, env, signal: t.signal });
    assert.equal(await readFile(marker, 'utf8'), admitted, 'warm no-refresh validation remains read-only');
    await writeFile(join(root, 'pnpm-lock.yaml'), '# changed dependency inputs\n');
    await assert.rejects(bootstrapDependencies({ repoDir: root, executionPlacement: 'remote', validationKind, env,
      signal: t.signal, installInitialDependencies: async () => assert.fail('no-refresh policy must prevent installation'),
    }), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
    assert.equal(await readFile(marker, 'utf8'), admitted);
    await rm(join(root, 'node_modules'), { recursive: true });
    await assert.rejects(bootstrapDependencies({ repoDir: root, executionPlacement: 'remote', validationKind, env,
      signal: t.signal, installInitialDependencies: async () => assert.fail('no-refresh policy must also prevent a cold installation'),
    }), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
    await assert.rejects(stat(join(root, 'node_modules')), { code: 'ENOENT' });
  });
}

for (const policy of ['skip', 'disabled', 'service', 'refresh']) test(`local validation refreshes on demand and honors explicit no-refresh flags (${policy})`, {
  skip: process.platform === 'win32' ? 'Exercises the POSIX package-manager executable boundary' : false,
}, async t => {
  const { root: repoDir } = await createTempFixture(t, { prefix: 'happier-local-bootstrap-policy-' });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'], packageManager: 'pnpm@12.14.0' }));
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# original inputs\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), "packages:\n  - \"apps/*\"\n");
  for (const component of ['stack', 'ui', 'cli', 'server']) {
    await mkdir(join(repoDir, 'apps', component), { recursive: true });
    await writeFile(join(repoDir, 'apps', component, 'package.json'), JSON.stringify({ name: `@fixture/${component}` }));
  }
  await mkdir(join(repoDir, 'node_modules'));
  await withDependencyRefresh({ installDir: repoDir, env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' } }, async () => {});
  const markerPath = join(repoDir, 'node_modules/.happier-stack-dependencies-ready');
  const admittedBytes = await readFile(markerPath, 'utf8');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# changed inputs\n');
  const binDir = join(repoDir, 'bin');
  await mkdir(binDir);
  const installTrace = join(repoDir, 'installs.json');
  // Only the package-manager process is replaced. Dependency policy, freshness,
  // bootstrap and lifecycle ownership execute their real internal paths.
  const packageManager = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('12.14.0');
else if (args[0] === 'install') {
  if (process.env.HAPPIER_TEST_PNPM_FAILURE === '1') {
    console.error('ERR_PNPM_LOCKFILE_CONFIG_MISMATCH');
    process.exit(1);
  }
  fs.writeFileSync(${JSON.stringify(installTrace)}, JSON.stringify(args));
}
else throw new Error('Unexpected package-manager command: ' + JSON.stringify(args));
`;
  for (const command of ['pnpm']) {
    await writeFile(join(binDir, command), packageManager);
    await chmod(join(binDir, command), 0o755);
  }
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    npm_execpath: '', npm_node_execpath: '', HAPPIER_STACK_HOME_DIR: join(repoDir, 'home'),
    HAPPIER_STACK_ENV_FILE: '', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: policy === 'skip' ? '1' : '',
    HAPPIER_STACK_DISABLE_REFRESH_DEPS: policy === 'disabled' ? '1' : '',
    HAPPIER_STACK_SERVICE_MODE: policy === 'service' ? '1' : '',
    HAPPIER_STACK_SERVICE_ALLOW_REFRESH_DEPS: '', HAPPIER_STACK_ALLOW_REFRESH_DEPS: '' };
  if (policy === 'refresh') {
    await writeFile(join(repoDir, 'node_modules', 'retained-sentinel'), 'existing dependency bytes');
    await assert.rejects(bootstrapRemoteDependencies({ repoDir, validationKind: 'source-test',
      executionPlacement: 'local', env: { ...env, HAPPIER_TEST_PNPM_FAILURE: '1' } }),
    { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED', pnpmErrorCode: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' });
    assert.equal(await readFile(markerPath, 'utf8'), admittedBytes);
    assert.equal(await readFile(join(repoDir, 'node_modules', 'retained-sentinel'), 'utf8'), 'existing dependency bytes');
    for (const placement of [[], ['--execution-placement=local']]) execFileSync(process.execPath, [
      fileURLToPath(new URL('./remote_dependency_bootstrap.mjs', import.meta.url)),
      `--repo-dir=${repoDir}`, '--validation-kind=source-test', '--component-relative-dir=apps/server',
      ...placement,
    ], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const bootstrap = () => bootstrapRemoteDependencies({ repoDir,
    validationKind: policy === 'refresh' ? 'runtime' : policy === 'disabled' ? 'typecheck' : 'source-test',
    componentRelativeDir: 'apps/server', executionPlacement: 'local', env });
  if (policy === 'service' || policy === 'refresh') {
    await bootstrap();
    const args = JSON.parse(await readFile(installTrace, 'utf8'));
    assert.ok(args.includes('--frozen-lockfile'), 'every host preserves the source-owned lockfile');
    assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, false);
    const freshBytes = await readFile(markerPath, 'utf8');
    assert.notEqual(freshBytes, admittedBytes);
    await rm(installTrace);
    await bootstrap();
    await assert.rejects(stat(installTrace), { code: 'ENOENT' }, 'a warm second starter does not reinstall');
    assert.equal(await readFile(markerPath, 'utf8'), freshBytes);
    return;
  }
  await assert.rejects(bootstrap(), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  await assert.rejects(stat(installTrace), { code: 'ENOENT' }, 'validation must not invoke installation');
  assert.equal(await readFile(markerPath, 'utf8'), admittedBytes, 'validation must not rewrite admission');
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, true);
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# original inputs\n');
  await bootstrapRemoteDependencies({ repoDir, validationKind: 'source-test',
    componentRelativeDir: 'apps/server', executionPlacement: 'local', env });
  assert.equal(await readFile(markerPath, 'utf8'), admittedBytes, 'warm validation must be read-only too');
  await assert.rejects(stat(installTrace), { code: 'ENOENT' });
});


test('runtime worker bootstrap emits package prerequisites by default while explicit publication checks remain strict', async t => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-runtime-bootstrap-default-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['cli', 'ui', 'server', 'stack']) {
    await mkdir(join(repoDir, 'apps', name), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`,
      ...(name === 'stack' ? { dependencies: { '@fixture/emitted': '1.0.0' } } : {}) }));
  }
  const packageDir = join(repoDir, 'packages/emitted');
  await mkdir(join(packageDir, 'src'), { recursive: true });
  const builder = new URL('../../../../../scripts/workspaces/buildTypeScriptPackageDist.mjs', import.meta.url).href;
  await writeFile(join(packageDir, 'compile.mjs'), `import { buildTypeScriptPackageDist } from ${JSON.stringify(builder)}; await buildTypeScriptPackageDist({ args: ['-p', 'tsconfig.json'] });\n`);
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@fixture/emitted', version: '1.0.0', type: 'module',
    main: './dist/index.js', types: './dist/index.d.ts', scripts: { build: 'node compile.mjs' } }));
  await writeFile(join(packageDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src', declaration: true, strict: true, types: [],
  }, include: ['src/**/*.ts'] }));
  await writeFile(join(packageDir, 'src/index.ts'), 'export const value: string = 1;\n');
  for (const domain of ['workspaces', 'process']) {
    await mkdir(join(repoDir, 'packages/cli-common/dist', domain), { recursive: true });
    await writeFile(join(repoDir, 'packages/cli-common/dist', domain, 'index.js'), 'export {};\n');
  }
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  // The tiny real compiler fixture runs on a hosted-CI executor; its resource
  // boundary is external to the runtime/bootstrap behavior under test.
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  delete env[WORKSPACE_BUILD_MODE_ENV];
  delete env.npm_lifecycle_event;
  const bootstrap = extra => bootstrapRemoteDependencies({ repoDir, componentRelativeDir: 'apps/stack', env: { ...env, ...extra } });
  await bootstrap();
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /value = 1/);
  await writeFile(join(packageDir, 'src/index.ts'), 'export const value: string = 2;\n');
  await prepareRemoteValidationWorkspace({ repoDir, componentRelativeDir: 'apps/stack', env });
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /value = 2/);
  const reader = await prepareRemoteValidationWorkspace({ repoDir, componentRelativeDir: 'apps/stack',
    validationKind: 'typecheck', env });
  assert.deepEqual(reader.built, []);
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /value = 2/);
  await assert.rejects(bootstrap({ [WORKSPACE_BUILD_MODE_ENV]: 'strict' }), { code: 'EEXIT' });
  await assert.rejects(bootstrap({ npm_lifecycle_event: 'prepack' }), { code: 'EEXIT' });
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /value = 2/);
});

async function copyColdPreparationSourceGraph(repoDir) {
  const sourceRepoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
  for (const relativeDir of ['apps/stack/scripts/utils', 'scripts/workspaces']) {
    await cp(join(sourceRepoDir, relativeDir), join(repoDir, relativeDir), {
      recursive: true,
      filter: (sourcePath) => !sourcePath.endsWith('.test.mjs'),
    });
  }
  const sourceCommonDir = join(sourceRepoDir, 'packages', 'cli-common');
  const commonDir = join(repoDir, 'packages', 'cli-common');
  await mkdir(commonDir, { recursive: true });
  for (const entry of await readdir(sourceCommonDir, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'package.json'
      || (/\.(mjs|cjs)$/u.test(entry.name) && !entry.name.endsWith('.test.mjs')))) {
      await cp(join(sourceCommonDir, entry.name), join(commonDir, entry.name));
    }
  }
  return sourceRepoDir;
}

test('runtime worker bootstrap retains coherent last-green output in explicit QA mode while release stays strict', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-runtime-bootstrap-qa-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const native = await installWorkspaceAdmissionProcessFixture(t, repoDir);
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['cli', 'ui', 'server', 'stack']) {
    await mkdir(join(repoDir, 'apps', name), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({
      name: `@fixture/${name}`, ...(name === 'stack' ? { dependencies: { '@fixture/emitted': '1.0.0' } } : {}),
    }));
  }
  const packageDir = join(repoDir, 'packages/emitted');
  await mkdir(join(packageDir, 'src'), { recursive: true });
  const source = join(packageDir, 'src/index.ts');
  await writeFile(source, 'export const value: string = "green";\n');
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@fixture/emitted', version: '1.0.0', type: 'module', main: './dist/index.js', types: './dist/index.d.ts',
    scripts: { build: 'node compile.mjs' },
  }));
  await writeFile(join(packageDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: 'src', declaration: true, strict: true, types: [],
  }, include: ['src/**/*.ts'] }));
  // Bound the external compiler fixture to ordinary hosted-CI invocation.
  // Bootstrap/output admission stays real; native memory admission has its own fixture.
  const compiler = resolveTypeScriptCliInvocation({ env: { CI: '1' } });
  await writeFile(join(packageDir, 'compile.mjs'), `import { spawnSync } from 'node:child_process';
const result = spawnSync(${JSON.stringify(compiler.command)}, [...${JSON.stringify(compiler.argsPrefix)}, '-p', 'tsconfig.json', '--outDir', process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR], { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`);
  await ensureWorkspacePackagesBuiltForComponent(join(repoDir, 'apps/stack'), { quiet: true, env: { ...native.env, [WORKSPACE_BUILD_MODE_ENV]: 'strict' } });
  const recordPath = join(packageDir, 'dist/.happier-build-inputs.json');
  const greenRecord = JSON.parse(await readFile(recordPath, 'utf8'));
  for (const domain of ['workspaces', 'process']) {
    await mkdir(join(repoDir, 'packages/cli-common/dist', domain), { recursive: true });
    await writeFile(join(repoDir, 'packages/cli-common/dist', domain, 'index.js'), 'export {};\n');
  }
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(source, 'export const value: string = 1;\n');
  // Installed dependency admission is separate from package compilation. The
  // real bootstrap, Stack package-manager adapter and compiler all run below it.
  const env = { ...native.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' };
  delete env[WORKSPACE_BUILD_MODE_ENV];
  const bootstrap = (extraEnv = {}) => bootstrapRemoteDependencies({ repoDir, componentRelativeDir: 'apps/stack', defaultBuildMode: 'qa-runtime', env: { ...env, ...extraEnv } });
  await bootstrap();
  const stale = await inspectWorkspaceQaStalePackages(repoDir, ['@fixture/emitted']);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].lastGreenBuildRecord.fingerprint, greenRecord.fingerprint);
  assert.match(stale[0].diagnosticSummary, /TS2322/);
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /green/);
  await ensureWorkspacePackagesBuiltForComponent(join(repoDir, 'apps/stack'), { env: { ...env, [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' }, quiet: false });
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /green/,
    'the default package-manager adapter applies the same verbose QA contract');
  await assert.rejects(bootstrap({ [WORKSPACE_BUILD_MODE_ENV]: 'strict' }));
  await assert.rejects(bootstrap({ npm_lifecycle_event: 'prepack' }));
  await writeFile(source, 'export const value: string = "fixed";\n');
  await bootstrap();
  assert.deepEqual(await inspectWorkspaceQaStalePackages(repoDir, ['@fixture/emitted']), []);
  assert.match(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), /fixed/);
});

for (const owner of ['proc/pm.mjs', 'dev/expo_dev.mjs']) test(`${owner} imports from installed source without compiled workspace outputs`, async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-ui-preparation-cold-import-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  // Relocate the real authored import graph, not a stub of the preparation
  // owner. No first-party dist or caller node_modules can satisfy the child.
  await copyColdPreparationSourceGraph(repoDir);
  const commonDir = join(repoDir, 'packages', 'cli-common');
  if (owner === 'dev/expo_dev.mjs') {
    const sourceRepoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
    await cp(join(sourceRepoDir, 'packages', 'cli-common', 'src'), join(commonDir, 'src'), { recursive: true });
    // The real Tailscale source export now consumes this Protocol runtime
    // contract. Retain its actual source export map without publishing dist.
    for (const relativePath of ['packages/protocol/package.json',
      'packages/protocol/src/system/tasks/tailscaleSecureAccessTaskContract.ts']) {
      const destination = join(repoDir, relativePath);
      await mkdir(join(destination, '..'), { recursive: true });
      await cp(join(sourceRepoDir, relativePath), destination);
    }
    await mkdir(join(repoDir, 'node_modules/@happier-dev'), { recursive: true });
    await symlink(join(repoDir, 'packages/protocol'), join(repoDir, 'node_modules/@happier-dev/protocol'),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const installedCommonDir = join(repoDir, 'node_modules', '@happier-dev', 'cli-common');
  await cp(commonDir, installedCommonDir, { recursive: true });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({
    private: true, type: 'module', workspaces: ['apps/*', 'packages/*'],
  }));
  await assert.rejects(stat(join(commonDir, 'dist')), { code: 'ENOENT' });
  await assert.rejects(stat(join(installedCommonDir, 'dist')), { code: 'ENOENT' });
  const ownerUrl = pathToFileURL(join(repoDir, 'apps', 'stack', 'scripts', 'utils', owner)).href;

  // Real Node resolution sees the real cli-common export map and its authored
  // source files. A transitive emitted-package import must fail this admission.
  try {
    execFileSync(process.execPath, [...(owner === 'dev/expo_dev.mjs' ? ['--conditions=happier-source', '--import', import.meta.resolve('tsx')] : []),
      '--input-type=module', '-e', `await import(${JSON.stringify(ownerUrl)});`], {
      cwd: repoDir,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      stdio: 'pipe',
    });
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    assert.match(stderr, /ERR_MODULE_NOT_FOUND/u);
    assert.ok(stderr.includes(join(installedCommonDir, 'dist', 'workspaces', 'index.js')),
      `Cold-import RED must identify the emitted workspaces dependency, not a missing fixture source file:\n${stderr}`);
    throw error;
  }
});

test('cold UI source-test bootstrap prepares real postinstall outputs without publishing workspace packages', {
  skip: process.platform === 'win32' ? 'This fixture exercises the POSIX worker package-manager executable boundary' : false,
}, async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-test-ui-patch-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  for (const component of ['stack', 'ui', 'cli', 'server']) {
    await mkdir(join(repoDir, 'apps', component), { recursive: true });
    await writeFile(join(repoDir, 'apps', component, 'package.json'), JSON.stringify({
      name: component === 'ui' ? '@happier-dev/app' : `@happier-dev/${component}`,
      ...(component === 'ui' ? {
        scripts: { 'postinstall:real': 'node tools/postinstall.mjs' },
        happier: { installFreshnessInputs: ['patches'] },
      } : {}),
    }));
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({
    private: true, workspaces: ['apps/*', 'packages/*'], packageManager: 'pnpm@12.14.0',
  }));
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n");
  const uiDir = join(repoDir, 'apps', 'ui');
  const sourceRepoDir = await copyColdPreparationSourceGraph(repoDir);
  for (const relativePath of [
    'apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs',
    'apps/ui/scripts/generateBundledPluginUiArtifacts.mjs',
    'apps/ui/tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs',
    'apps/ui/tools/postinstall/installedPackageDirs.mjs',
    'apps/ui/tools/postinstall/pnpmPatches.mjs',
  ]) {
    const destination = join(repoDir, relativePath);
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(join(sourceRepoDir, relativePath), destination);
  }
  const protocolDir = join(repoDir, 'packages', 'protocol');
  await cp(join(sourceRepoDir, 'packages', 'protocol', 'src'), join(protocolDir, 'src'), { recursive: true });
  // Keep Protocol's public package unavailable until publication. The real
  // postinstall readiness/source-tool import closure must not consume its dist.
  await writeFile(join(protocolDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/protocol', version: '0.0.0', type: 'module',
    main: './dist/plugins/ui/index.js', types: './dist/plugins/ui/index.d.ts',
    exports: { './plugins/ui': './dist/plugins/ui/index.js' },
    scripts: { build: 'node compile.mjs' },
  }));
  // The compiler process is an external boundary. Make unnecessary publication
  // fail deliberately rather than relying on unrelated Protocol diagnostics.
  await writeFile(join(protocolDir, 'compile.mjs'), "throw new Error('UI source tests do not consume Protocol dist; publication must not gate postinstall readiness');\n");
  const installedDependenciesDir = join(repoDir, 'installed-dependencies');
  await mkdir(join(installedDependenciesDir, '@happier-dev'), { recursive: true });
  for (const entry of await readdir(join(sourceRepoDir, 'node_modules'))) {
    if (['@happier-dev', '.bin', '.modules.yaml', '.yarn-integrity', '.happier-stack-dependencies-ready', 'react-native-enriched-markdown'].includes(entry)) continue;
    await symlink(join(sourceRepoDir, 'node_modules', entry), join(installedDependenciesDir, entry));
  }
  await symlink(protocolDir, join(installedDependenciesDir, '@happier-dev', 'protocol'));
  await symlink(join(repoDir, 'packages', 'cli-common'), join(installedDependenciesDir, '@happier-dev', 'cli-common'));
  await writeFile(join(installedDependenciesDir, '.modules.yaml'), 'packageManager: pnpm@12.14.0\nnodeLinker: hoisted\n');
  const protocolDependencyDir = join(sourceRepoDir, 'packages', 'protocol', 'node_modules');
  if (await stat(protocolDependencyDir).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) await symlink(protocolDependencyDir, join(protocolDir, 'node_modules'));
  await assert.rejects(stat(join(protocolDir, 'dist')), { code: 'ENOENT' });
  await mkdir(join(uiDir, 'patches'));
  const patchPath = join(uiDir, 'patches', 'markdown.patch');
  const markersByFile = new Map();
  for (const [relativePath, marker, count = 1] of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_MARKERS) {
    const markers = markersByFile.get(relativePath) ?? [];
    markers.push(...Array.from({ length: count }, () => marker));
    markersByFile.set(relativePath, markers);
  }
  const patchInputDir = join(uiDir, 'patches', 'installed-markdown');
  for (const relativePath of REACT_NATIVE_ENRICHED_MARKDOWN_STREAMING_PATCH_REQUIRED_FILES) {
    const output = join(patchInputDir, relativePath);
    await mkdir(join(output, '..'), { recursive: true });
    await writeFile(output, (markersByFile.get(relativePath) ?? []).join('\n'));
  }
  // The package-manager boundary must produce an installed package, not only
  // loose patch outputs: canonical discovery requires its on-disk manifest.
  await writeFile(join(patchInputDir, 'package.json'), JSON.stringify({ name: 'react-native-enriched-markdown' }));
  const preparedModule = await readFile(join(patchInputDir, 'lib/module/web/streamingReveal.js'), 'utf8');
  await writeFile(patchPath, preparedModule);
  const requiredOutputPath = join(uiDir, 'node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js');
  const binDir = join(repoDir, 'bin');
  await mkdir(binDir);
  // Pnpm is the OS boundary. A scriptless install creates only the
  // dependency tree; the UI package-manager task produces its patched module,
  // and rejects unnecessary publication. Bootstrap, source import resolution
  // and postinstall readiness stay real.
  const packageManagerFixture = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('12.14.0');
} else if (args[0] === 'install') {
  fs.cpSync(${JSON.stringify(installedDependenciesDir)}, path.join(process.cwd(), 'node_modules'), { recursive: true });
} else if (args.join(' ') === '-s build' && process.cwd() === ${JSON.stringify(protocolDir)}) {
  throw new Error('UI source tests do not consume Protocol dist; publication must not gate postinstall readiness');
} else if (args.join(' ') === '--filter @happier-dev/app run --silent postinstall:real'
  || (args.join(' ') === 'run --silent postinstall:real' && process.cwd() === ${JSON.stringify(uiDir)})) {
  fs.cpSync(process.env.HAPPIER_TEST_UI_PATCH_INPUT, path.dirname(path.dirname(path.dirname(path.dirname(process.env.HAPPIER_TEST_UI_PATCH_OUTPUT)))), { recursive: true });
} else {
  throw new Error('Unexpected package-manager command: ' + JSON.stringify(args));
}
`;
  for (const command of ['pnpm']) {
    const executablePath = join(binDir, command);
    await writeFile(executablePath, packageManagerFixture);
    await chmod(executablePath, 0o755);
  }
  const uiUnitPolicy = resolveRemoteCommandPolicy(['hstack-exec', '--heavyweight-admission',
    '--class=targeted-validation', '--', 'pnpm', '--dir', 'apps/ui', 'run', '--silent', 'test:unit']);
  const bootstrapOptions = {
    repoDir,
    validationKind: uiUnitPolicy.kind,
    componentRelativeDir: uiUnitPolicy.component,
    env: {
      ...process.env,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '',
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      npm_execpath: '',
      HAPPIER_DEV_TARGET_EXECUTION: '1',
      HAPPIER_STACK_HOME_DIR: join(repoDir, 'home'),
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_TEST_UI_PATCH_INPUT: patchInputDir,
      HAPPIER_TEST_UI_PATCH_OUTPUT: requiredOutputPath,
    },
  };
  assert.equal(bootstrapOptions.validationKind, 'source-test', 'the public UI unit owner must reach source preparation');
  await bootstrapRemoteDependencies(bootstrapOptions);

  // This is the payload's dependency read after bootstrap returns, not a
  // postinstall call-count assertion or a separately repaired fixture.
  assert.equal(await readFile(requiredOutputPath, 'utf8'), preparedModule);
  await assert.rejects(stat(join(protocolDir, 'dist')), { code: 'ENOENT' });
  await bootstrapRemoteDependencies({
    repoDir,
    validationKind: 'typecheck',
    componentRelativeDir: 'apps/ui',
    env: {
      ...process.env,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '',
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      npm_execpath: '',
      HAPPIER_STACK_HOME_DIR: join(repoDir, 'home'),
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_TEST_UI_PATCH_INPUT: patchInputDir,
      HAPPIER_TEST_UI_PATCH_OUTPUT: requiredOutputPath,
    },
  });
  await assert.rejects(stat(join(protocolDir, 'dist')), { code: 'ENOENT' },
    'typecheck bootstrap leaves declaration consumption to the compiler');
  assert.equal((await inspectDependencyRefresh({
    installDir: repoDir,
  })).required, false);
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, false,
    'source preparation publishes the same canonical install identity as runtime preparation');
  // A subsequent package-manager link can remove installed patch output while
  // the authored inputs and existing dependency admission remain unchanged.
  await rm(requiredOutputPath);
  assert.equal((await inspectDependencyRefresh({
    installDir: repoDir,
  })).required, false);
  await bootstrapRemoteDependencies(bootstrapOptions);
  assert.equal(await readFile(requiredOutputPath, 'utf8'), preparedModule,
    'warm preparation must verify and repair the actual module the UI loads');
  await assert.rejects(stat(join(repoDir, 'packages', 'cli-common', 'dist')), { code: 'ENOENT' },
    'source-test preparation must not compile the Stack dependency-owner closure');
});

test('source-test bootstrap admits installed tools without requiring a compiled Stack owner', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-test-bootstrap-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const native = await installWorkspaceAdmissionProcessFixture(t, repoDir);
  const { binDir } = writeFakeBin({ root: repoDir, name: 'pnpm', content: `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('12.14.0');
else if (args[0] === 'install') fs.mkdirSync('node_modules', { recursive: true });
else if (args.join(' ') === 'run --silent build') {
  const result = spawnSync(process.execPath, ['compile.mjs'], { env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else throw new Error('Unexpected package-manager command: ' + JSON.stringify(args));
` });
  const env = { ...native.env, PATH: `${binDir}${delimiter}${native.env.PATH ?? ''}`, npm_execpath: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' };
  await mkdir(join(repoDir, 'apps/stack'), { recursive: true });
  for (const name of ['ui', 'cli', 'server']) {
    await mkdir(join(repoDir, 'apps', name), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, version: '1.0.0' }));
  }
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, 'apps/stack/package.json'), '{"name":"@fixture/stack","version":"1.0.0","dependencies":{"@fixture/emitted":"1.0.0"}}');
  await mkdir(join(repoDir, 'packages/emitted/src'), { recursive: true });
  await writeFile(join(repoDir, 'packages/emitted/package.json'), JSON.stringify({ name: '@fixture/emitted', version: '1.0.0', main: './dist/index.js', scripts: { build: 'node compile.mjs' } }));
  await writeFile(join(repoDir, 'packages/emitted/compile.mjs'), 'import { mkdirSync, writeFileSync } from "node:fs"; const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR; mkdirSync(out, { recursive: true }); writeFileSync(out + "/index.js", "export {};\\n");');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# first\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n");
  let installs = 0;
  const options = {
    repoDir, validationKind: 'source-test', env,
    // Package installation is the OS boundary; freshness/locking remains real.
    installInitialDependencies: async () => {
      installs += 1;
      await mkdir(join(repoDir, 'node_modules'), { recursive: true });
      await writeFile(join(repoDir, 'node_modules/.modules.yaml'), '{}');
    },
  };
  await bootstrapRemoteDependencies(options);
  await assert.rejects(stat(join(repoDir, 'packages/emitted/dist/index.js')), { code: 'ENOENT' });
  await bootstrapRemoteDependencies(options);
  assert.equal(installs, 1);
  await bootstrapRemoteDependencies({ ...options, validationKind: 'typecheck', toolsOnly: true });
  assert.equal(installs, 1, 'sibling typechecks reuse their own dependency freshness without a compiled Stack');
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, false,
    'tools-only bootstrap publishes canonical dependency readiness without compiling runtime artifacts');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# second\n');
  await bootstrapRemoteDependencies(options);
  assert.equal(installs, 2);
  await assert.rejects(stat(join(repoDir, 'packages/cli-common/dist')), { code: 'ENOENT' });
  for (const domain of ['workspaces', 'process']) {
    await mkdir(join(repoDir, 'packages/cli-common/dist', domain), { recursive: true });
    await writeFile(join(repoDir, 'packages/cli-common/dist', domain, 'index.js'), 'export {};\n');
  }
  await bootstrapRemoteDependencies({ ...options, validationKind: 'runtime', componentRelativeDir: 'apps/ui' });
  await assert.rejects(stat(join(repoDir, 'packages/emitted/dist/index.js')), { code: 'ENOENT' },
    'non-Stack validation must not publish the Stack closure');
  await bootstrapRemoteDependencies({ ...options, validationKind: 'runtime', componentRelativeDir: 'apps/stack' });
  assert.equal((await stat(join(repoDir, 'packages/emitted/dist/index.js'))).isFile(), true,
    'Stack-native validation keeps its emitted-package contract');
});

test('a provisioner-installed tree is adopted once and honors no-refresh validation afterward', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-adopt-installed-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));
  const native = await installWorkspaceAdmissionProcessFixture(t, repoDir);
  await mkdir(join(repoDir, 'apps/stack'), { recursive: true });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(join(repoDir, 'apps/stack/package.json'), '{"name":"@fixture/stack","version":"1.0.0"}');
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# installed by CI\n');
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), "packages:\n  - \"apps/*\"\n");
  // CI ran a plain frozen install: node_modules exists, no admission record.
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules/.modules.yaml'), '{}');
  const local = { repoDir, validationKind: 'runtime', executionPlacement: 'local', componentRelativeDir: 'apps/ui',
    env: { ...native.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' } };
  const markerPath = join(repoDir, 'node_modules/.happier-stack-dependencies-ready');
  await bootstrapDependencies(local);
  await assert.rejects(stat(markerPath), { code: 'ENOENT' }, 'no-refresh use of an unadmitted tree cannot publish admission');
  await adoptInstalledDependencies({ repoDir, env: native.env });
  const admitted = await readFile(markerPath, 'utf8');
  await bootstrapDependencies(local);
  await bootstrapDependencies({ ...local, validationKind: 'source-test', toolsOnly: true });
  await writeFile(join(repoDir, 'pnpm-lock.yaml'), '# changed after adoption\n');
  await assert.rejects(adoptInstalledDependencies({ repoDir, env: native.env }), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' },
    'explicit adoption cannot recertify an installation after its inputs change');
  await bootstrapDependencies(local);
  assert.equal(await readFile(markerPath, 'utf8'), admitted, 'no-refresh use must not recertify mismatched installed bytes');
  assert.equal((await inspectDependencyRefresh({ installDir: repoDir })).required, true);
});

test('remote stage-zero dependency install materializes dependencies without workspace lifecycle scripts', () => {
  assert.deepEqual(REMOTE_INITIAL_DEPENDENCY_INSTALL_ARGS, [
    'install',
    '--prod=false',
    '--ignore-scripts',
    '--frozen-lockfile',
  ]);
});

test('remote dependency bootstrap joins nine same-input waiters through the canonical dependency owner', async (t) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-remote-dependency-bootstrap-'));
  t.after(async () => rm(repoDir, { recursive: true, force: true }));

  await Promise.all([
    mkdir(join(repoDir, 'apps', 'stack'), { recursive: true }),
    mkdir(join(repoDir, 'apps', 'ui'), { recursive: true }),
    mkdir(join(repoDir, 'apps', 'cli'), { recursive: true }),
    mkdir(join(repoDir, 'apps', 'server'), { recursive: true }),
    mkdir(join(repoDir, 'packages', 'cli-common', 'dist', 'workspaces'), { recursive: true }),
    mkdir(join(repoDir, 'packages', 'cli-common', 'dist', 'process'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(repoDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
    }) + '\n', 'utf-8'),
    writeFile(join(repoDir, 'pnpm-lock.yaml'), '# fixture\n', 'utf-8'),
    writeFile(join(repoDir, 'pnpm-workspace.yaml'), "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n"),
    writeFile(join(repoDir, 'apps', 'stack', 'package.json'), '{"name":"@happier-dev/stack"}\n', 'utf-8'),
    writeFile(join(repoDir, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/app"}\n', 'utf-8'),
    writeFile(join(repoDir, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8'),
    writeFile(join(repoDir, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8'),
    writeFile(join(repoDir, 'packages', 'cli-common', 'package.json'), '{"name":"@happier-dev/cli-common"}\n', 'utf-8'),
    writeFile(join(repoDir, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js'), 'export {};\n', 'utf-8'),
    writeFile(join(repoDir, 'packages', 'cli-common', 'dist', 'process', 'index.js'), 'export {};\n', 'utf-8'),
  ]);

  let installCalls = 0;
  let releaseFirstInstall;
  const firstInstallRelease = new Promise((resolve) => {
    releaseFirstInstall = resolve;
  });
  let markFirstInstallStarted;
  const firstInstallStarted = new Promise((resolve) => {
    markFirstInstallStarted = resolve;
  });
  const installInitialDependencies = async () => {
    installCalls += 1;
    assert.equal((await stat(join(repoDir, '.project', 'tmp', 'dependency-install.lock'))).isFile(), true);
    await assert.rejects(
      () => stat(join(repoDir, '.project', 'tmp', 'cli-dist-build.lock')),
      { code: 'ENOENT' },
      'dependency installation must not hold the final CLI publication lock',
    );
    if (installCalls === 1) {
      markFirstInstallStarted();
      await firstInstallRelease;
    }
    await mkdir(join(repoDir, 'node_modules'), { recursive: true });
    await writeFile(join(repoDir, 'node_modules', '.modules.yaml'), 'fixture\n', 'utf-8');
  };
  const options = {
    repoDir,
    validationKind: 'source-test',
    env: { ...process.env, CI: '1', HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' },
    installInitialDependencies,
  };

  const firstBootstrap = bootstrapRemoteDependencies(options);
  await firstInstallStarted;
  const waiters = Array.from({ length: 9 }, () => bootstrapRemoteDependencies(options));
  await delay(100);
  assert.equal(installCalls, 1, 'a second controller must wait instead of mutating shared node_modules');

  releaseFirstInstall();
  await Promise.all([firstBootstrap, ...waiters]);
  assert.equal(installCalls, 1);
});

test('remote dependency bootstrap builds the dependency-owner closure before loading that owner', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/stack',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    packageExists: () => false,
    installInitialDependencies: async (options) => calls.push(['initial', options]),
    withDependencyRefresh: runDependencyRefreshImmediately,
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltByName: async (...args) => calls.push(['build-owner', ...args]),
    }),
    loadDependencyOwner: async () => {
      calls.push(['load-owner']);
      return {
        ensureDepsInstalled: async (dir, label, options) => {
          calls.push(['ensure', dir, label, {
            env: options.env,
            hasDependencyReadyAction: typeof options.onDependenciesReady === 'function',
          }]);
        },
        ensureWorkspacePackagesBuiltForComponent: async (componentDir, options) => {
          calls.push(['--filter', componentDir, 'run', options]);
        },
      };
    },
  });

  assert.deepEqual(calls, [
    ['initial', {
      repoDir: '/remote/happier',
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1', HAPPIER_DEV_TARGET_EXECUTION: '1' },
    }],
    ['build-owner', '/remote/happier', ['@happier-dev/cli-common'], {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1', HAPPIER_DEV_TARGET_EXECUTION: '1' },
      includeDevDependencies: false,
    }],
    ['load-owner'],
    ['ensure', '/remote/happier/apps/stack', 'remote Happier workspace', {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1', HAPPIER_DEV_TARGET_EXECUTION: '1' },
      hasDependencyReadyAction: false,
    }],
    ['--filter', '/remote/happier/apps/stack', 'run', {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1', HAPPIER_DEV_TARGET_EXECUTION: '1' },
    }],
  ]);
});

test('remote dependency bootstrap leaves unrelated workspace publication to component preparation', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    packageExists: () => false,
    installInitialDependencies: async (options) => calls.push(['initial', options]),
    withDependencyRefresh: runDependencyRefreshImmediately,
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltByName: async (...args) => calls.push(['build-owner', ...args]),
    }),
    loadDependencyOwner: async () => ({
      ensureDepsInstalled: async (_dir, _label, options) => {
        calls.push(['ensure:begin']);
        assert.equal(options.onDependenciesReady, undefined);
        calls.push(['ensure:end']);
      },
      ensureWorkspacePackagesBuiltForComponent: async (componentDir, options) => {
        calls.push(['--filter', componentDir, 'run', options]);
      },
    }),
  });

  assert.deepEqual(calls, [
    ['initial', {
      repoDir: '/remote/happier',
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1', HAPPIER_DEV_TARGET_EXECUTION: '1' },
    }],
    ['build-owner', '/remote/happier', ['@happier-dev/cli-common'], {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1', HAPPIER_DEV_TARGET_EXECUTION: '1' },
      includeDevDependencies: false,
    }],
    ['ensure:begin'],
    ['ensure:end'],
  ]);
});

test('remote dependency bootstrap propagates stage-zero failures before loading later owners', async () => {
  const stageZeroFailure = new Error('stage-zero failed');
  let workspaceBuildOwnerLoaded = false;
  let dependencyOwnerLoaded = false;

  await assert.rejects(
    () => bootstrapRemoteDependencies({
      repoDir: '/remote/happier',
      installInitialDependencies: async () => {
        throw stageZeroFailure;
      },
      withDependencyRefresh: runDependencyRefreshImmediately,
      loadWorkspaceBuildOwner: async () => {
        workspaceBuildOwnerLoaded = true;
        return { ensureWorkspacePackagesBuiltByName: async () => {} };
      },
      loadDependencyOwner: async () => {
        dependencyOwnerLoaded = true;
        return { ensureDepsInstalled: async () => {} };
      },
    }),
    (error) => error === stageZeroFailure,
  );

  assert.equal(workspaceBuildOwnerLoaded, false);
  assert.equal(dependencyOwnerLoaded, false);
});

test('remote dependency bootstrap skips stage zero when the canonical dependency owner already exists', async () => {
  let initialInstallCalled = false;
  let workspaceBuildOwnerLoaded = false;
  let ensured = false;
  let workspacePrepared = false;

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    packageExists: (path) => new Set([
      '/remote/happier/node_modules/.modules.yaml',
      '/remote/happier/packages/cli-common/dist/workspaces/index.js',
      '/remote/happier/packages/cli-common/dist/process/index.js',
    ]).has(path),
    installInitialDependencies: async () => {
      initialInstallCalled = true;
    },
    withDependencyRefresh: async () => {
      throw new Error('warm targets must not enter stage-zero dependency refresh');
    },
    loadWorkspaceBuildOwner: async () => {
      workspaceBuildOwnerLoaded = true;
      return {
        ensureWorkspacePackagesBuiltByName: async () => {},
      };
    },
    loadDependencyOwner: async () => ({
      ensureDepsInstalled: async () => {
        ensured = true;
      },
      ensureWorkspacePackagesBuiltForComponent: async () => {
        workspacePrepared = true;
      },
    }),
  });

  assert.equal(initialInstallCalled, false);
  assert.equal(workspaceBuildOwnerLoaded, false);
  assert.equal(ensured, true);
  assert.equal(workspacePrepared, false);
});

test('remote dependency bootstrap refreshes the Stack component workspace closure before returning', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    componentRelativeDir: 'apps/stack',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    packageExists: () => true,
    loadDependencyOwner: async () => ({
      ensureDepsInstalled: async () => calls.push('dependencies'),
      ensureWorkspacePackagesBuiltForComponent: async (componentDir, options) => {
        calls.push(['--filter', componentDir, 'run', options]);
      },
    }),
  });

  assert.deepEqual(calls, [
    'dependencies',
    ['--filter', '/remote/happier/apps/stack', 'run', {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1', HAPPIER_DEV_TARGET_EXECUTION: '1' },
    }],
  ]);
});

test('remote dependency bootstrap repairs a scriptless install whose dependency owner was not built', async () => {
  const calls = [];

  await bootstrapRemoteDependencies({
    repoDir: '/remote/happier',
    env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict' },
    packageExists: (path) => path === '/remote/happier/node_modules/.modules.yaml',
    installInitialDependencies: async () => calls.push(['initial']),
    withDependencyRefresh: async () => ({ refreshed: false, reason: 'up-to-date' }),
    loadWorkspaceBuildOwner: async () => ({
      ensureWorkspacePackagesBuiltByName: async (...args) => calls.push(['build-owner', ...args]),
    }),
    loadDependencyOwner: async () => ({
      ensureDepsInstalled: async () => {
        calls.push(['ensure']);
      },
      ensureWorkspacePackagesBuiltForComponent: async (componentDir, options) => {
        calls.push(['--filter', componentDir, 'run', options]);
      },
    }),
  });

  assert.deepEqual(calls, [
    ['build-owner', '/remote/happier', ['@happier-dev/cli-common'], {
      env: { HAPPIER_STACK_PM_CACHE_BASE_DIR: '/remote/cache', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1', HAPPIER_DEV_TARGET_EXECUTION: '1' },
      includeDevDependencies: false,
    }],
    ['ensure'],
  ]);
});

test('local Yarn predecessor validation uses its own freshness owner without rewriting admission', async t => {
  const predecessorOwner = new URL('../../../../../../0.2/apps/stack/scripts/utils/proc/dependency_refresh.mjs', import.meta.url);
  try { await stat(predecessorOwner); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('the supported 0.2 predecessor checkout is unavailable');
    return;
  }
  const { withDependencyRefresh: admitPredecessor } = await import(predecessorOwner.href);
  const fixture = await createTempFixture(t, { prefix: 'happier-yarn-predecessor-' });
  await mkdir(fixture.path('node_modules'));
  await mkdir(fixture.path('apps/stack/scripts/utils/proc'), { recursive: true });
  await symlink(fileURLToPath(predecessorOwner), fixture.path('apps/stack/scripts/utils/proc/dependency_refresh.mjs'));
  await writeFile(fixture.path('package.json'), JSON.stringify({ packageManager: 'yarn@1.22.22', workspaces: [] }));
  await writeFile(fixture.path('yarn.lock'), '# predecessor inputs\n');
  await admitPredecessor({ installDir: fixture.root, componentDir: fixture.path('apps/stack') }, async () => {});
  const marker = fixture.path('node_modules/.happier-stack-dependencies-ready');
  const before = await readFile(marker, 'utf8');
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' };
  const installInitialDependencies = async () => assert.fail('Yarn predecessor validation must not invoke the pnpm installer');

  await bootstrapDependencies({ repoDir: fixture.root, validationKind: 'source-test', executionPlacement: 'local', env, installInitialDependencies });
  assert.equal(await readFile(marker, 'utf8'), before);
  await writeFile(fixture.path('yarn.lock'), '# changed predecessor inputs\n');
  await assert.rejects(bootstrapDependencies({ repoDir: fixture.root,
    validationKind: 'source-test', executionPlacement: 'local', env, installInitialDependencies }), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  assert.equal(await readFile(marker, 'utf8'), before);
});

test('remote Yarn predecessor bootstrap executes the source-owned bootstrap entrypoint', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-yarn-bootstrap-owner-' });
  const sourceBootstrap = fixture.path('apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs');
  await mkdir(fixture.path('apps/stack/scripts/utils/dev_targets'), { recursive: true });
  await writeFile(fixture.path('package.json'), JSON.stringify({ packageManager: 'yarn@1.22.22' }));
  // This executable is the other checkout's process boundary. Its sentinel
  // proves which owner ran; the executor's real dispatch logic stays intact.
  await writeFile(sourceBootstrap, 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})); process.exit(17);\n');
  assert.throws(() => execFileSync(process.execPath, [
    fileURLToPath(new URL('./remote_dependency_bootstrap.mjs', import.meta.url)),
    `--repo-dir=${fixture.root}`, '--execution-placement=remote', '--validation-kind=source-test',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => {
    assert.equal(error.status, 17);
    const output = JSON.parse(error.stdout);
    assert.equal(output.cwd, fixture.root);
    assert.ok(output.args.includes('--execution-placement=remote'));
    assert.ok(output.args.includes('--validation-kind=source-test'));
    return true;
  });
});
