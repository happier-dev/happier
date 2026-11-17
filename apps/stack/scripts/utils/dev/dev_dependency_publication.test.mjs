// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { allocateAvailableLocalhostPort } from '../../testkit/core/ephemeral_port.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { moveInPlaceInstallationIntoGeneration } from '../proc/dependency_generations.mjs';
import { withDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { killProcessTree } from '../proc/proc.mjs';

test('noninteractive stack dev follows publications while external server startup is pending',
  { timeout: 120000, skip: process.platform === 'win32' }, async t => {
  const temporary = await createTempFixture(t, { prefix: 'hstack-dev-publication-', registerCleanup: false });
  const fixture = { ...temporary, ...await ensureMinimalMonorepoLayout(temporary.root) };
  let stopOwner = async () => {};
  t.after(async () => { await stopOwner(); await fixture.cleanup(); });
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  const launches = fixture.path('expo-launches');
  const executable = join(fixture.uiDir, 'node_modules/.bin/expo');
  await mkdir(join(executable, '..'), { recursive: true });
  // External process boundary only: a real listening child records each start.
  const expoScript = `#!${process.execPath}\nconst fs=require('node:fs');require('node:http').createServer((req,res)=>res.end('packager-status:running')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1',()=>fs.appendFileSync(${JSON.stringify(launches)},process.pid+'\\n'));\n`;
  await writeFile(executable, expoScript);
  await chmod(executable, 0o755);
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir: fixture.root }),
    HAPPIER_STACK_STACK: 'main', HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_TOOLING_PACKAGES: 'live',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
    HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '0', HAPPIER_STACK_EXPO_TAILSCALE: '0',
    HAPPIER_STACK_TAILSCALE_SERVE: '0', HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
    HAPPIER_STACK_EXPO_DEV_PORT: String(await allocateAvailableLocalhostPort()),
    HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable' };
  const publicationEnv = { ...env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await withDependencyRefresh({ installDir: fixture.root, env: publicationEnv },
    () => mkdir(fixture.path('node_modules'), { recursive: true }));
  await moveInPlaceInstallationIntoGeneration(fixture.root);
  const server = createServer((_req, res) => { res.writeHead(503); res.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const stackDir = join(env.HAPPIER_STACK_STORAGE_DIR, 'main');
  await mkdir(stackDir, { recursive: true });
  env.HAPPIER_STACK_ENV_FILE = join(stackDir, 'env');
  await writeFile(env.HAPPIER_STACK_ENV_FILE, Object.entries(env)
    .filter(([key]) => key.startsWith('HAPPIER_STACK_')).map(([key,value]) => `${key}=${value}`).join('\n'));
  const entry = fileURLToPath(new URL('../../../bin/hstack.mjs', import.meta.url));
  const loader = fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url));
  const owner = spawn(process.execPath, ['--conditions=happier-source', '--import', loader,
    entry, 'stack', 'dev', 'main', '--no-server', '--no-daemon', '--no-browser', '--no-dev-targets',
    `--server-url=${serverUrl}`], { cwd: fixture.root, env, detached: true, stdio: ['ignore','pipe','pipe'] });
  t.diagnostic(`fixture=${fixture.root} wrapper=${owner.pid}`);
  let output = '';
  owner.once('exit', (code, signal) => t.diagnostic(`dev wrapper exit ${code}/${signal}`));
  owner.stdout.on('data', chunk => { output += chunk; });
  owner.stderr.on('data', chunk => { output += chunk; });
  const completion = once(owner, 'exit');
  stopOwner = async () => {
    const state = JSON.parse(await readFile(join(stackDir, 'stack.runtime.json'), 'utf8').catch(() => '{}'));
    if (state.ownerPid) await killProcessTree({ pid: state.ownerPid }, 'SIGKILL');
    await killProcessTree(owner, 'SIGKILL');
    await completion;
    owner.stdout.destroy(); owner.stderr.destroy();
    const pids = (await readFile(launches, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
    for (const pid of pids) await killProcessTree({ pid }, 'SIGKILL');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  const readLaunches = async () => (await readFile(launches, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
  await t.waitFor(async () => {
    assert.equal(owner.exitCode, null, output);
    assert.equal((await readLaunches()).length, 1, output);
  }, { timeout: 90000 });
  await withDependencyRefresh({ installDir: fixture.root, env: publicationEnv, force: true, generationInstall: true },
    async ({ installCwd }) => {
      const next = join(installCwd, 'apps/ui/node_modules/.bin/expo');
      await mkdir(join(next, '..'), { recursive: true });
      await writeFile(next, expoScript); await chmod(next, 0o755);
    });
  await t.waitFor(async () => assert.equal((await readLaunches()).length, 2,
    `the real dev owner must replace Expo before external server readiness; output:\n${output}`), { timeout: 10000 });
  assert.equal(owner.exitCode, null, output);
  assert.match(output, /dependency publication.*Expo/);
});
