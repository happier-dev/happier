// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMinimalMonorepoFixture } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { allocateAvailableLocalhostPort } from '../../testkit/core/ephemeral_port.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { ensureDevExpoServer } from './expo_dev.mjs';
import { createDevDependencyReload, startDevReloadCoordinator } from './devReloadCoordinator.mjs';
import { moveInPlaceInstallationIntoGeneration } from '../proc/dependency_generations.mjs';
import { resolveDependencyRefreshMarkerPath, withDependencyRefresh, withDependencyRefreshLock, markDependencyMutation } from '../proc/dependency_refresh.mjs';
import { killProcessTree } from '../proc/proc.mjs';
import { watchDebounced } from '../proc/watch.mjs';

test('completed generation publications replace the owned Expo while output-only repairs preserve it',
  { timeout: 120000, skip: process.platform === 'win32' }, async t => {
  const fixture = await createMinimalMonorepoFixture(t, { prefix: 'metro-live-generation-' });
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n - apps/*\n');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
    HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0',
    HAPPIER_STACK_EXPO_DEV_PORT: String(await allocateAvailableLocalhostPort()),
    HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable' };
  const publicationEnv = { ...env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const executable = join(fixture.uiDir, 'node_modules/.bin/expo');
  await mkdir(join(executable, '..'), { recursive: true });
  // Only the Expo executable substitutes for the external process boundary.
  await writeFile(executable, `#!${process.execPath}\nrequire('node:http').createServer((req,res)=>res.end('packager-status:running')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');\n`);
  await chmod(executable, 0o755);
  await mkdir(fixture.path('node_modules'), { recursive: true });
  await withDependencyRefresh({ installDir: fixture.root, env: publicationEnv }, async () => {});
  await moveInPlaceInstallationIntoGeneration(fixture.root);
  const children = [];
  const options = { startUi: true, uiDir: fixture.uiDir, autostart: { baseDir: fixture.root }, baseEnv: env,
    stackMode: true, stackName: 'metro-generation', envPath: fixture.path('env'), children,
    quiet: true, spawnOptions: { silent: true } };
  let serving, coordinator, observer, published;
  t.after(async () => {
    await coordinator?.close();
    await serving?.close?.();
    for (const child of children) await killProcessTree(child, 'SIGKILL');
    await Promise.all(children.map(child => child.completion));
  });
  serving = await ensureDevExpoServer(options);
  const reload = await createDevDependencyReload({ repoDir: fixture.root, env,
    reloadExpo: async () => {
      await serving.close?.();
      serving = await ensureDevExpoServer(options);
    } });
  coordinator = startDevReloadCoordinator({
    descriptors: [reload.descriptor, ...(reload.expo ? [reload.expo.descriptor] : [])],
    executors: [reload.executor, ...(reload.expo ? [reload.expo.executor] : [])],
    debounceMs: 0, pollIntervalMs: 0, logger: { log() {}, warn() {}, error() {} } },
    { watchDebouncedImpl(options) {
      observer = options;
      return watchDebounced({ ...options, onChange: async event => {
        await options.onChange(event);
        published?.();
        published = null;
      } });
    } });
  await observer.readSignature();
  const notify = () => observer.onChange({ eventType: 'change',
    watchPath: resolveDependencyRefreshMarkerPath(fixture.root), filename: '.happier-stack-dependencies-ready' });
  for (let index = 0; index < 3; index++) {
    const before = serving.pid;
    const publicationObserved = new Promise(resolve => { published = resolve; });
    await withDependencyRefresh({ installDir: fixture.root, env: publicationEnv, force: true, generationInstall: true },
      async ({ installCwd }) => {
        const nextExecutable = join(installCwd, 'apps/ui/node_modules/.bin/expo');
        await mkdir(join(nextExecutable, '..'), { recursive: true });
        await writeFile(nextExecutable, await readFile(executable));
        await chmod(nextExecutable, 0o755);
      });
    // Join the real native publication event and the complete owner replacement.
    await publicationObserved;
    assert.notEqual(serving.pid, before, 'a newly published physical generation must replace the old Metro');
    assert.equal(children.at(-2).exitCode !== null || children.at(-2).signalCode !== null, true);
    await notify();
    assert.equal(children.length, index + 2, 'duplicate publication events must not restart Expo again');
  }
  for (const output of ['ui-dependency-outputs', 'server-generated-client:prisma']) {
    await withDependencyRefreshLock({ installDir: fixture.root, env: publicationEnv },
      () => markDependencyMutation({ installDir: fixture.root, env: publicationEnv, output }));
    await notify();
    assert.equal(children.length, 4, 'output-only publication preserves the serving Metro');
  }
});
