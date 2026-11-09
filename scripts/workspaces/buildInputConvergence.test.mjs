import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { captureBuildInputFiles } from './buildInputConvergence.mjs';
import * as convergence from './buildInputConvergence.mjs';
import { readDependencyPublicationState, resolveDependencyRefreshLockPath, withDependencyRefresh, withDependencyRefreshLock } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv } from '../../apps/stack/scripts/testkit/core/env_scope.mjs';
import { ensureWorkspacePackagesBuiltForComponent } from './ensureWorkspacePackagesBuilt.mjs';

for (const boundary of ['during', 'after']) test(`dependency publication preserves a finite consumer ${boundary} unchanged preparation`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-noop-consumer-' });
  const sourceDir = fixture.root;
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await withDependencyRefresh({ installDir: sourceDir, env }, async () => {});
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let start;
  const startPreparation = new Promise(resolve => { start = resolve; });
  // This independent asynchronous operation has no inherited consumer context.
  const preparation = (async () => {
    await startPreparation;
    await withDependencyRefresh({ installDir: sourceDir, env, onDependenciesReady: async () => {
      entered(); await held;
    } }, async () => assert.fail('unchanged preparation must not install'));
  })();
  const value = {};
  try {
    const result = await convergence.withBuildInputDependencies({ sourceDir, env }, async (_env, publication) => {
      start(); await ready;
      if (boundary === 'after') { release(); await preparation; }
      await publication.assertCurrent();
      return value;
    });
    assert.equal(result, value);
  } finally { release(); await preparation; }
  await assert.rejects(convergence.withBuildInputDependencies({ sourceDir, env }, async () => {
    await withDependencyRefresh({ installDir: sourceDir, env, force: true }, async () => {
      await writeFile(fixture.path('node_modules', 'installed.js'), 'changed dependency bytes');
    });
    return value;
  }), { code: 'BUILD_INPUTS_CHANGED' });
});

test('dependency publication writer generation changes before a failed installer mutates packages', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-publication-writer-' });
  const installDir = fixture.path('repo');
  await mkdir(join(installDir, 'node_modules'), { recursive: true });
  await writeFile(join(installDir, 'package.json'), '{"private":true}');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await withDependencyRefresh({ installDir, env }, async () => {});
  const before = await readDependencyPublicationState({ installDir, env });
  const failure = Object.assign(new Error('fixture pnpm rejected a moving lockfile'), { code: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' });
  let observed;
  await assert.rejects(withDependencyRefresh({ installDir, env, force: true }, async () => {
    observed = await readDependencyPublicationState({ installDir, env });
    assert.notEqual(observed.generation, before.generation,
      'the generation advances before the external installer can touch a package');
    assert.equal(observed.writerActive, true);
    throw failure;
  }), error => error.code === 'HAPPIER_DEPENDENCY_REFRESH_FAILED'
    && error.pnpmErrorCode === failure.code && error.cause === failure);
  const after = await readDependencyPublicationState({ installDir, env });
  assert.equal(after.generation, observed.generation, 'failed writers retain their observed generation');
  assert.equal(after.writerActive, false);
  assert.equal(after.identity, before.identity, 'failed installers do not publish a new ready marker');
});

test('dependency publication rejects a finite result spanning a failed writer generation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-publication-' });
  const sourceDir = fixture.path('repo');
  await mkdir(sourceDir);
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const generationPath = `${resolveDependencyRefreshLockPath(sourceDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'before' }));
  await assert.rejects(convergence.withBuildInputDependencies({ sourceDir, env }, async () => {
    // A failed install leaves the ready marker unchanged. Its actual writer
    // start still changes the canonical generation before touching packages.
    await writeFile(generationPath, JSON.stringify({ generation: 'after-failure' }));
    return 'spanned-artifact';
  }), { code: 'BUILD_INPUTS_CHANGED' });
});

test('dependency publication preserves the first loader failure when generation also changes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-original-failure-' });
  const sourceDir = fixture.root;
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const generationPath = `${resolveDependencyRefreshLockPath(sourceDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'before' }));
  let original;
  let attempts = 0;
  await assert.rejects(convergence.withSingleTrailingBuildPass({ run: () =>
    convergence.withBuildInputDependencies({ sourceDir, env }, async () => {
      attempts++;
      await writeFile(generationPath, JSON.stringify({ generation: 'changed' }));
      try { await import(pathToFileURL(fixture.path('missing-loader.mjs')).href); }
      catch (error) { original = error; throw error; }
    }) }), error => error === original && error.code === 'ERR_MODULE_NOT_FOUND');
  assert.equal(attempts, 1, 'a failed loader is not a successful product needing a trailing build');
});

test('dependency publication preserves unchanged finite results without rebuilding', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-publication-stable-' });
  const sourceDir = fixture.path('repo');
  await mkdir(sourceDir);
  const value = {};
  let builds = 0;
  const result = await convergence.withSingleTrailingBuildPass({ run: () =>
    convergence.withBuildInputDependencies({ sourceDir }, async () => { builds++; return value; }) });
  assert.equal(result, value);
  assert.equal(builds, 1, 'stable dependency facts do not duplicate compiler work');
});

test('dependency publication settles after one rebuild when writers span both attempts', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-publication-exhausted-' });
  const sourceDir = fixture.path('repo');
  await mkdir(sourceDir);
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const generationPath = `${resolveDependencyRefreshLockPath(sourceDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  let builds = 0;
  await assert.rejects(convergence.withSingleTrailingBuildPass({ run: () =>
    convergence.withBuildInputDependencies({ sourceDir, env }, async () => {
      await writeFile(generationPath, JSON.stringify({ generation: String(++builds) }));
      return 'unpublishable';
    }) }), { code: 'BUILD_INPUTS_CHANGED', trailingPassExhausted: true });
  assert.equal(builds, 2);
  let nestedBuilds = 0;
  const nested = new convergence.BuildInputDriftError('nested phase already exhausted its trailing pass', { trailingPassExhausted: true });
  await assert.rejects(convergence.withSingleTrailingBuildPass({ run: () =>
    convergence.withBuildInputDependencies({ sourceDir, env }, async () => {
      nestedBuilds++;
      await writeFile(generationPath, JSON.stringify({ generation: 'nested-writer' }));
      throw nested;
    }) }), error => error === nested);
  assert.equal(nestedBuilds, 1, 'dependency drift cannot reopen an already exhausted nested phase');
});

test('dependency publication preserves retryable drift across the private worker result contract', async () => {
  let attempts = 0;
  const result = await convergence.withSingleTrailingBuildPass({ run: async () => {
    if (++attempts > 1) return 'published-rebuild';
    const payload = convergence.serializeTerminalBuildFailure(new convergence.BuildInputDriftError('dependencies changed'),
      { includeRetryableDrift: true });
    const failure = convergence.readTerminalBuildFailure(JSON.parse(JSON.stringify(payload)));
    if (failure) throw failure;
    return 'incorrect-first-publication';
  } });
  assert.equal(result, 'published-rebuild');
  assert.equal(attempts, 2);
});

test('dependency publication rejects an unsafe captured package; the next demand rebuilds it', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-publication-package-' });
  const sourceDir = fixture.path('repo');
  const packageDir = join(sourceDir, 'packages/example');
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(join(sourceDir, 'apps', app), { recursive: true });
    await writeFile(join(sourceDir, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      ...(app === 'ui' ? { dependencies: { '@happier-dev/example': '0.0.0' } } : {}) }));
  }
  await mkdir(join(packageDir, 'src'), { recursive: true });
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  await writeFile(join(sourceDir, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(sourceDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - apps/*\n');
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/example',
    main: './dist/index.js', scripts: { build: 'fixture-build' } }));
  await writeFile(join(packageDir, 'src/index.ts'), 'export const ready = true;\n');
  const env = { ...process.env, HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1' };
  const generationPath = `${resolveDependencyRefreshLockPath(sourceDir, env)}.generation`;
  await mkdir(dirname(generationPath), { recursive: true });
  await writeFile(generationPath, JSON.stringify({ generation: 'before' }));
  let builds = 0;
  const build = () => ensureWorkspacePackagesBuiltForComponent(join(sourceDir, 'apps/ui'), { env, publicationMode: 'artifact',
    workspaceBuildBoundary: {
      prepareEnv: async (_dir, env) => env,
      runPackageBuild: async (_dir, { env }) => {
        builds++;
        await assert.rejects(lstat(join(packageDir, 'dist/index.js')), { code: 'ENOENT' },
          'the first spanned candidate must never replace the prior publication');
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), `export const pass = ${builds};\n`);
        if (builds === 1) await writeFile(generationPath, JSON.stringify({ generation: 'after-failed-writer' }));
      },
    } });
  await assert.rejects(build(), { code: 'BUILD_INPUTS_CHANGED', trailingPassExhausted: false });
  assert.equal(builds, 1, 'unsafe live dependency consumption does not reopen a compiler pass');
  await assert.rejects(lstat(join(packageDir, 'dist/index.js')), { code: 'ENOENT' });
  await build();
  assert.equal(builds, 2);
  assert.equal(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), 'export const pass = 2;\n');
});

test('captured package builds resolve tooling workspace imports outside the build closure', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-capture-tooling-imports-' });
  const sourceDir = fixture.path('repo');
  const packageDir = join(sourceDir, 'packages/example');
  const toolingDir = join(sourceDir, 'apps/stack/scripts/utils/managed_lima');
  const toolDependencyDir = join(sourceDir, 'packages/cli-common');
  for (const dir of [join(packageDir, 'src'), toolingDir, toolDependencyDir]) {
    await mkdir(dir, { recursive: true });
  }
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(join(sourceDir, 'apps', app), { recursive: true });
    await writeFile(join(sourceDir, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      ...(app === 'ui' ? { dependencies: { '@happier-dev/example': 'workspace:*' } } : {}) }));
  }
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  await writeFile(join(sourceDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - apps/*\n');
  await writeFile(join(sourceDir, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module',
    main: './dist/index.js', exports: { '.': './dist/index.js', './input': './src/input.mjs' },
    scripts: { build: 'fixture-build' } }));
  await writeFile(join(packageDir, 'src/index.ts'), 'export const ready = true;\n');
  await writeFile(join(packageDir, 'src/input.mjs'), 'export const input = "captured";\n');
  await writeFile(join(toolDependencyDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli-common', type: 'module',
    exports: { './machineLima': './machineLima.mjs' } }));
  await writeFile(join(toolDependencyDir, 'machineLima.mjs'), 'export const profile = "tooling-ready";\n');
  await writeFile(join(toolingDir, 'profiles.mjs'),
    'import { profile } from "@happier-dev/cli-common/machineLima";\n'
    + 'import { input } from "@happier-dev/example/input";\nexport const result = profile + ":" + input;\n');
  const result = await ensureWorkspacePackagesBuiltForComponent(join(sourceDir, 'apps/ui'), {
    env: { ...process.env }, publicationMode: 'artifact',
    workspaceBuildBoundary: {
      prepareEnv: async (_dir, env) => env,
      // Replace only the compiler process; import its copied tooling with real Node resolution.
      runPackageBuild: async (capturedPackageDir, { env }) => {
        await writeFile(join(packageDir, 'src/input.mjs'), 'export const input = "live";\n');
        const tooling = join(capturedPackageDir, '../../apps/stack/scripts/utils/managed_lima/profiles.mjs');
        const { result } = await import(pathToFileURL(tooling).href);
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), `export const profile = ${JSON.stringify(result)};\n`);
      },
    },
  });
  assert.deepEqual(result.built, ['@happier-dev/example']);
  assert.equal(await readFile(join(packageDir, 'dist/index.js'), 'utf8'), 'export const profile = "tooling-ready:captured";\n');
});

test('captured dependencies survive reusing a captured workspace through its source alias', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-captured-dependency-alias-' });
  const installed = fixture.path('installed');
  const sourceDir = fixture.path('repo');
  const workspace = 'packages/agents';
  const installedBin = join(installed, workspace, 'node_modules/.bin');
  await mkdir(installedBin, { recursive: true });
  await writeFile(join(installed, workspace, 'package.json'), '{"name":"@happier-dev/agents"}');
  await writeFile(join(installedBin, 'probe'), 'installed tool');
  await mkdir(sourceDir);
  const sourceAlias = join(sourceDir, 'packages');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(join(installed, 'packages'), sourceAlias, linkType);

  for (const name of ['first', 'second']) {
    const captureDir = fixture.path(name);
    await captureBuildInputFiles({ sourceDir, captureDir, readPaths: () => [`${workspace}/package.json`] });
    await convergence.mountCapturedWorkspaceDependencies({ sourceDir, captureDir, workspaceDirs: [workspace] });
    if (name === 'first') {
      // Source preparation reuses the captured package sources by replacing
      // this alias. Dependency links must still reach the installed tree.
      await rm(sourceAlias);
      await symlink(join(captureDir, 'packages'), sourceAlias, linkType);
    }
    const capturedBin = join(captureDir, workspace, 'node_modules/.bin');
    assert.equal(await readFile(join(capturedBin, 'probe'), 'utf8'), 'installed tool');
    assert.equal(await realpath(capturedBin), await realpath(installedBin));
    assert.equal((await lstat(capturedBin)).isSymbolicLink(), true, 'the installed tools are shared, not copied');
  }
});

test('finite captured dependency consumption lets writers proceed and rejects the spanned result', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-finite-dependency-reader-' });
  const sourceDir = fixture.path('repo');
  const captureDir = fixture.path('capture');
  const installed = join(sourceDir, 'node_modules/tool/index.js');
  await mkdir(dirname(installed), { recursive: true });
  await writeFile(join(sourceDir, 'package.json'), '{"private":true}');
  await writeFile(installed, 'patched');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home'), HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await withDependencyRefresh({ installDir: sourceDir, env }, async () => {});
  let notifyWaiting;
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  t.mock.method(process.stderr, 'write', chunk => {
    if (String(chunk).includes('dependency refresh lock')) notifyWaiting('waiting');
    return true;
  });
  let releaseWriter;
  const resume = new Promise(resolve => { releaseWriter = resolve; });
  let writer;
  const consume = convergence.withBuildInputDependencies;
  try {
    await assert.rejects(consume({ sourceDir, env }, async () => {
      await convergence.mountCapturedWorkspaceDependencies({ sourceDir, captureDir, workspaceDirs: [] });
      assert.equal(await readFile(join(captureDir, 'node_modules/tool/index.js'), 'utf8'), 'patched');
      let notifyReplaced;
      const replaced = new Promise(resolve => { notifyReplaced = resolve; });
      writer = withDependencyRefresh({ installDir: sourceDir, env, force: true }, async () => {
        await rm(join(sourceDir, 'node_modules'), { recursive: true });
        await mkdir(dirname(installed), { recursive: true });
        await writeFile(installed, 'pristine');
        notifyReplaced('replaced');
        await resume;
        await writeFile(installed, 'patched-again');
      });
      const phase = await Promise.race([waiting, replaced]);
      assert.equal(phase, 'replaced', 'finite consumption must not retain a dependency reader lock');
      assert.equal(await readFile(join(captureDir, 'node_modules/tool/index.js'), 'utf8'), 'pristine');
      releaseWriter();
      await writer;
      return 'spanned-artifact';
    }), { code: 'BUILD_INPUTS_CHANGED' });
  } finally {
    releaseWriter();
    await writer;
  }
  assert.equal(await readFile(installed, 'utf8'), 'patched-again');
});

test('finite dependency consumption waits behind refresh and cancels without consuming the tree', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-finite-dependency-cancel-' });
  const sourceDir = fixture.path('repo');
  const abort = new AbortController();
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const writer = withDependencyRefreshLock({ installDir: sourceDir }, async () => { entered(); await held; });
  await started;
  let consumed = false;
  const consume = convergence.withBuildInputDependencies;
  const reader = consume({ sourceDir, signal: abort.signal }, async () => { consumed = true; });
  const rejected = assert.rejects(reader, { name: 'AbortError' });
  abort.abort();
  try { await rejected; assert.equal(consumed, false); }
  finally { release(); await writer; }
  await consume({ sourceDir }, async () => { consumed = true; });
  assert.equal(consumed, true, 'cancellation must retire its waiter without stranding admission');
});

test('dependency consumption preserves parallel nested finite workers without reader custody', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-finite-dependency-parallel-' });
  const sourceDir = fixture.path('repo');
  await convergence.withBuildInputDependencies({ sourceDir }, async env => {
    const cancel = new AbortController();
    let started = 0;
    let bothStarted;
    let release;
    const ready = new Promise(resolve => { bothStarted = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    const workers = [1, 2].map(() => convergence.withBuildInputDependencies({ sourceDir, env, signal: cancel.signal }, async () => {
      if (++started === 2) bothStarted(true);
      await resume;
    }));
    let deadline;
    const completed = await Promise.race([ready, new Promise(resolve => { deadline = setTimeout(() => resolve(false), 1000); })]);
    clearTimeout(deadline);
    release();
    cancel.abort();
    await Promise.allSettled(workers);
    assert.equal(completed, true, 'independent finite workers must remain parallel');
  });
});

test('component dependency consumption waits for the writer before compiling or publishing', async t => {
  // This fixture owns an independent installed tree and has no inherited
  // publication custody from the admitted runner that launched the test.
  withPatchedProcessEnv(t, {
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: null,
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: null,
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: null,
  });
  const fixture = await createTempFixture(t, { prefix: 'happier-component-dependency-order-' });
  const sourceDir = fixture.path('repo');
  const packageDir = join(sourceDir, 'packages/example');
  const componentDir = join(sourceDir, 'apps/ui');
  await mkdir(join(packageDir, 'src'), { recursive: true });
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(join(sourceDir, 'apps', app), { recursive: true });
    await writeFile(join(sourceDir, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      ...(app === 'ui' ? { dependencies: { '@happier-dev/example': '0.0.0' } } : {}) }));
  }
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  await writeFile(join(sourceDir, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(sourceDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - apps/*\n');
  const manifest = { name: '@happier-dev/example', main: './dist/index.js', scripts: { build: 'fixture-build' } };
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(packageDir, 'src/index.ts'), 'export const ready = true;\n');
  let notice;
  const waiting = new Promise(resolve => { notice = resolve; });
  t.mock.method(process.stderr, 'write', chunk => {
    if (String(chunk).includes('dependency refresh lock')) notice();
    return true;
  });
  const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
  let build;
  let failure;
  let compiled = false;
  let releaseWriter;
  let writerEntered;
  const held = new Promise(resolve => { releaseWriter = resolve; });
  const started = new Promise(resolve => { writerEntered = resolve; });
  const writer = withDependencyRefreshLock({ installDir: sourceDir, env }, async () => {
    writerEntered();
    await held;
  });
  await started;
  try {
    build = ensureWorkspacePackagesBuiltForComponent(componentDir, { env, workspaceBuildBoundary: {
      prepareEnv: async (_dir, env) => env,
      // Replace only the external compiler process; the graph, capture,
      // dependency/publication locks and atomic publisher remain real.
      runPackageBuild: async (_dir, { env }) => {
        compiled = true;
        await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const ready = true;\n');
      },
    } });
    await Promise.race([waiting, build.then(() => {
      assert.fail('component build must wait for the dependency writer to finish');
    })]);
    try {
      assert.equal(compiled, false, 'an active dependency writer must finish before compilation begins');
      await assert.rejects(lstat(join(packageDir, 'dist/index.js')), { code: 'ENOENT' },
        'a component waiting for dependencies must not publish a package');
    } catch (error) { failure = error; }
  } finally { releaseWriter(); await writer; }
  const result = await build;
  assert.deepEqual(result.built, [manifest.name]);
  if (failure) throw failure;
});

async function filesystemRequests(run) {
  let requests = 0;
  // Measure real OS-boundary work, not elapsed time or internal helper calls.
  const hook = createHook({ init(_id, type) {
    if (type === 'FSREQPROMISE' || type === 'FSREQCALLBACK') requests++;
  } });
  hook.enable();
  try { await run(); return requests; }
  finally { hook.disable(); }
}

test('source capture records its own bytes and time despite later live edits', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-moving-source-capture-' });
  const sourceDir = fixture.path('source');
  const captureDir = fixture.path('capture');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'entry.js'), 'export const value = 1;');
  let observations = 0;
  const started = Date.now();
  const capture = await captureBuildInputFiles({ sourceDir, captureDir, readPaths: async () => {
    if (++observations === 2) await writeFile(join(sourceDir, 'entry.js'), 'export const value = 2;');
    return ['entry.js'];
  } });
  const finished = Date.now();
  assert.equal(await readFile(join(captureDir, 'entry.js'), 'utf8'), 'export const value = 2;');
  assert.ok(Date.parse(capture.capturedAt) >= started && Date.parse(capture.capturedAt) <= finished,
    'capture time describes the input copy, not a later compiler completion');
  const identity = await convergence.readBuildInputIdentity({ sourceDir: captureDir, files: capture.files });
  await writeFile(join(sourceDir, 'entry.js'), 'export const value = 3;');
  assert.equal(await convergence.readBuildInputIdentity({ sourceDir: captureDir, files: capture.files }), identity);
  assert.equal(await readFile(join(captureDir, 'entry.js'), 'utf8'), 'export const value = 2;');
  assert.equal(observations, 2, 'source movement does not reopen capture convergence');
});

test('capturing admitted regular files costs less filesystem work than generic copying once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-capture-cost-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const paths = Array.from({ length: 30 }, (_, i) => `packages/example/src/group-${i}/index.js`);
  for (const path of paths) {
    await mkdir(dirname(join(sourceDir, path)), { recursive: true });
    await writeFile(join(sourceDir, path), 'export const value = 1;');
  }
  // Calibrate against Node's generic copy on the same filesystem/platform.
  // Capture includes both metadata passes; per-file ancestor validation must
  // not amplify its work beyond even the generic single-copy baseline.
  const genericRequests = await filesystemRequests(async () => {
    for (const path of paths) {
      const target = join(root, 'generic', path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(sourceDir, path), target, { verbatimSymlinks: true });
    }
  });
  const captureDir = join(root, 'capture');
  const captureRequests = await filesystemRequests(() =>
    captureBuildInputFiles({ sourceDir, captureDir, readPaths: () => paths }));
  t.diagnostic(JSON.stringify({ captureRequests, genericRequests }));
  assert.ok(captureRequests < genericRequests,
    `capture used ${captureRequests} filesystem requests; generic copy used ${genericRequests}`);
  for (const path of paths) assert.equal(await readFile(join(captureDir, path), 'utf8'), 'export const value = 1;');
});

test('capture preserves executable modes, empty directories and verbatim dangling links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-capture-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const captureDir = join(root, 'capture');
  await mkdir(join(sourceDir, 'empty'), { recursive: true });
  await writeFile(join(sourceDir, 'tool'), 'executable');
  await chmod(join(sourceDir, 'tool'), 0o751);
  await symlink('missing-relative-target', join(sourceDir, 'link'));
  await captureBuildInputFiles({ sourceDir, captureDir, readPaths: () => ['empty', 'tool', 'link'] });
  assert.equal(await readFile(join(captureDir, 'tool'), 'utf8'), 'executable');
  if (process.platform !== 'win32') assert.equal((await lstat(join(captureDir, 'tool'))).mode & 0o777, 0o751);
  assert.ok((await lstat(join(captureDir, 'empty'))).isDirectory());
  assert.equal(await readlink(join(captureDir, 'link')), 'missing-relative-target');
});
