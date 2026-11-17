// @happier-test-preparation source
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { markDependencyMutation, resolveDependencyRefreshLockPath, withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';

const owner = new URL('./compiler_test_suites.mjs', import.meta.url);
const policyOwner = new URL('./remote_commands.mjs', import.meta.url).href;
const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const vitestPackage = dirname(createRequire(new URL('../../../../../apps/ui/package.json', import.meta.url)).resolve('vitest/package.json'));

async function fixtureFor(t) {
  const fixture = await createTempFixture(t, { prefix: 'compiler-suite-refresh-' });
  const copy = fixture.path('apps/stack/scripts/utils/dev_targets/compiler_test_suites.mjs');
  await mkdir(dirname(copy), { recursive: true });
  await copyFile(owner, copy);
  await mkdir(fixture.path('apps/ui/node_modules'), { recursive: true });
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_BUILD_DEPENDENCY_CUSTODY: '',
    HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0', HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS: '0' };
  delete env.NODE_OPTIONS;
  return { fixture, copy, env };
}

function launch(t, { fixture, copy, env }, mode, args) {
  const source = `
    import { registerHooks } from 'node:module';
    const { callerHoldsDependencyConsumption } = await import(${JSON.stringify(new URL('../proc/dependency_refresh.mjs', owner).href)});
    let vitestLoads = 0, vitestProtected = false;
    const copy = ${JSON.stringify(pathToFileURL(copy).href)};
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.endsWith('/compiler_test_suites.mjs')) return next(copy, context);
      if (context.parentURL === copy && specifier.startsWith('.')) {
        return next(new URL(specifier, ${JSON.stringify(owner.href)}).href, context);
      }
      if (specifier === 'vitest/node') { vitestLoads++; vitestProtected = callerHoldsDependencyConsumption({ installDir: ${JSON.stringify(fixture.root)}, env: process.env }); }
      return next(specifier, context);
    } });
    const { runRemoteCommandPolicyCli } = await import(${JSON.stringify(policyOwner)});
    const code = await runRemoteCommandPolicyCli([${JSON.stringify(mode)}, ${JSON.stringify(repo)},
      ${JSON.stringify(join(repo, 'packages/plugin-sdk'))}, ...${JSON.stringify(args)}]);
    process.send({ code, vitestLoads, vitestProtected });
    process.exitCode = code;
    process.disconnect();
  `;
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '--eval', source], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '', stderr = '';
  const waiting = Promise.withResolvers();
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => {
    stderr += value;
    if (stderr.includes('dependency refresh lock')) waiting.resolve('waiting');
  });
  let result;
  child.on('message', value => { result = value; });
  const closed = once(child, 'close').then(([code]) => ({ code, result, stdout, stderr }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return { closed, waiting: waiting.promise };
}

test('non-Vitest launcher policies load zero Vitest modules while dependencies are unavailable', async t => {
  const context = await fixtureFor(t);
  await withDependencyRefreshLock({ installDir: context.fixture.root, env: context.env }, async () => {
    const result = await launch(t, context, '--publisher-policy', ['node', 'plain.mjs']).closed;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.result.vitestLoads, 0);
  });
});

for (const mode of ['--vitest-policy', '--package-policy']) {
  test(`${mode} waits for dependency publication before resolving Vitest`, async t => {
    const context = await fixtureFor(t);
    let reader;
    await withDependencyRefreshLock({ installDir: context.fixture.root, env: context.env }, async () => {
      await markDependencyMutation({ installDir: context.fixture.root, env: context.env });
      reader = launch(t, context, mode, ['vitest', 'run', '--config', 'vitest.source.config.ts', 'src/plain.test.ts']);
      const first = await Promise.race([reader.waiting, reader.closed]);
      await symlink(vitestPackage, context.fixture.path('apps/ui/node_modules/vitest'), 'junction');
      assert.equal(first, 'waiting', typeof first === 'object' ? first.stderr : undefined);
    });
    const result = await reader.closed;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /policy_heavyClass='validation'/);
    assert.equal(result.result.vitestLoads, 1);
    assert.equal(result.result.vitestProtected, true, 'Vitest evaluation must exclude a new dependency writer');
  });
}

test('failed dependency publication keeps the installer reason at the launcher', async t => {
  const context = await fixtureFor(t);
  const generation = `${resolveDependencyRefreshLockPath(context.fixture.root, context.env)}.generation`;
  await mkdir(dirname(generation), { recursive: true });
  await writeFile(generation, JSON.stringify({ generation: 'unfinished', completedGeneration: null,
    installationFailure: { pnpmErrorCode: 'ERR_PNPM_PATCH_NOT_APPLIED' } }));
  const result = await launch(t, context, '--vitest-policy', ['vitest', 'run', '--config', 'vitest.source.config.ts', 'src/plain.test.ts']).closed;
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /ERR_PNPM_PATCH_NOT_APPLIED/);
  assert.equal(result.result.vitestLoads, 0);
});

// Owner ruling 2026-11-16 ("small suites local"): explicit selections of up to
// ten existing test files are focused in every package, apps/cli included.
test('explicit selections of up to ten existing test files take the focused class of their package', async t => {
  const { resolvePackageCommandPolicy, resolveHeavyweightMemoryFloorKiB } = await import(policyOwner);
  const ui = ['browseInputBehavior.test.ts', 'browseSegments.test.ts', 'isSafeWorkspaceRelativePath.test.ts',
    'machinePlatform.test.ts', 'normalizeRepoPathParts.test.ts', 'pathUtils.spec.ts', 'resolvePathRelativeToRoot.test.ts',
    'routeUtils.dispatch.test.ts', 'routeUtils.test.ts', 'terminalConnectUrl.scheme.test.ts', 'terminalConnectUrl.test.ts',
  ].map(name => `sources/utils/path/${name}`);
  for (const [component, tail, expected] of [
    ['apps/ui', ui.slice(0, 2), 'focused-validation-ui'],
    ['apps/ui', ui.slice(0, 10), 'focused-validation-ui'],
    ['apps/ui', ui, 'validation'],
    ['apps/ui', [ui[0], 'sources/utils/path/missing.test.ts'], 'validation'],
    ['apps/ui', [ui[0], 'sources/utils/path'], 'validation'],
    ['apps/cli', ['src/utils/path/expandHomeDirPath.test.ts'], 'focused-validation-cli'],
    ['apps/cli', ['src/utils/path/expandHomeDirPath.test.ts', 'src/api/artifacts/accountArtifactStore.test.ts', '-t', 'x'], 'focused-validation-cli'],
    ['apps/cli', ['src/utils/path/expandHomeDirPath.test.ts', 'scripts/build.test.ts'], 'compilation'],
    ['apps/server', ['sources/app/session/turns/parseSessionTurnState.test.ts'], 'focused-validation'],
  ]) await t.test(`${component} ${tail.join(" ")} -> ${expected}`, async () => {
    const policy = await resolvePackageCommandPolicy(['pnpm', '--dir', component, 'exec', 'vitest', 'run', ...tail], { repoRoot: repo, cwd: repo });
    assert.equal(policy.heavyClass, expected);
  });
  // Recorded single-file CLI peak (focused-vitest-reservation-1105: 1,783,032 KiB live HWM) rounds to 2 GiB.
  assert.equal(resolveHeavyweightMemoryFloorKiB('focused-validation-cli'), 2 * 1024 * 1024);
});

// P03-HOLDER-PREP: the Session target artifacts (three cross builds) are prepared
// only for CLI selections that include a placed-Session test.
test('a CLI selection without a placed-Session test prepares only this Machine\'s native artifacts', async t => {
  const { resolvePackageCommandPolicy } = await import(policyOwner);
  for (const [tail, expected] of [
    [['src/utils/path/expandHomeDirPath.test.ts'], 'host-native'],
    [['src/utils/path/expandHomeDirPath.test.ts', 'src/subprocess/supervision/sessionHolder.target.test.ts'], ''],
    [['sessionHolder'], ''],
    [['src/subprocess/supervision'], ''],
    [['-t', 'holder'], ''],
    [[], ''],
  ]) await t.test(`apps/cli ${tail.join(' ') || '(whole suite)'} -> ${expected || 'every artifact'}`, async () => {
    const policy = await resolvePackageCommandPolicy(['pnpm', '--dir', 'apps/cli', 'exec', 'vitest', 'run', ...tail], { repoRoot: repo, cwd: repo });
    assert.equal(policy.preparationScope, expected);
  });
});
