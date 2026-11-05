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

function launch(t, { copy, env }, mode, args) {
  const source = `
    import { registerHooks } from 'node:module';
    let vitestLoads = 0;
    const copy = ${JSON.stringify(pathToFileURL(copy).href)};
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.endsWith('/compiler_test_suites.mjs')) return next(copy, context);
      if (context.parentURL === copy && specifier.startsWith('.')) {
        return next(new URL(specifier, ${JSON.stringify(owner.href)}).href, context);
      }
      if (specifier === 'vitest/node') vitestLoads++;
      return next(specifier, context);
    } });
    const { runRemoteCommandPolicyCli } = await import(${JSON.stringify(policyOwner)});
    const code = await runRemoteCommandPolicyCli([${JSON.stringify(mode)}, ${JSON.stringify(repo)},
      ${JSON.stringify(join(repo, 'packages/plugin-sdk'))}, ...${JSON.stringify(args)}]);
    process.send({ code, vitestLoads });
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
