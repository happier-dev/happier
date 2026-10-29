import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { resolvePnpmCommandInvocation } from './execPnpmCommand.mjs';
import { callerHoldsWorkspaceBundleLock, withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import { WORKSPACE_BUILD_MODE_ENV } from './workspaceChildBuildEnv.mjs';
import { ensureWorkspacePackagesBuiltByName, isWorkspacePackageOutputCurrent } from './ensureWorkspacePackagesBuilt.mjs';
import { parseWorkspaceBuildArgs } from './ensureWorkspacePackagesBuiltCli.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
const serverRunner = fileURLToPath(new URL('../../apps/server/scripts/runTypeScriptCli.mjs', import.meta.url));
const bootstrapRunner = fileURLToPath(new URL('../../apps/bootstrap/scripts/runTsc.mjs', import.meta.url));
const buildRunner = fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url));
const cliBuildRunner = fileURLToPath(new URL('../../apps/cli/scripts/build.mjs', import.meta.url));
const heartbeatRunner = fileURLToPath(new URL('../runWithHeartbeat.mjs', import.meta.url));
const procModule = new URL('../../apps/stack/scripts/utils/proc/proc.mjs', import.meta.url).href;
const rootTypecheckModule = new URL('../testing/runTypecheck.ts', import.meta.url).href;
const measurementLeaf = fileURLToPath(new URL('./measureTypeScriptCompiler.py', import.meta.url));
const measuredEnv = { CI: 'true', HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS: '1' };
const repositoryPackageManager = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).packageManager;

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function fixture(t, { tree = false, route = false, windows = false, platform = null, withoutWorkspaceDist = false, exitCode = null, compilerBody = '', spawnError = false, pauseMeasurementSetup = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-cancel-'));
  const pidFile = join(root, 'compiler.pid');
  const fakeCompiler = join(root, 'compiler.cjs');
  const preload = join(root, 'preload.cjs');
  const workerPidFile = join(root, 'worker.pid');
  const routedArgsFile = join(root, 'routed-args.json');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cancellation-fixture', type: 'module', main: './dist/index.js' }));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'index.js'), 'last-green');
  await writeFile(fakeCompiler, `
    require('node:fs').writeFileSync(process.env.COMPILER_PID_FILE, String(process.pid));
    ${compilerBody}
    ${exitCode == null ? '' : `process.exit(${exitCode});`}
    ${tree ? `
      const worker = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
      let interrupted = null;
      const handlers = new Map();
      function finish() {
        for (const [signal, handler] of handlers) process.off(signal, handler);
        process.kill(process.pid, interrupted);
      }
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const handler = () => { interrupted = signal; if (worker.exitCode != null || worker.signalCode != null) finish(); };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
      worker.once('exit', () => { if (interrupted) finish(); });
    ` : ''}
    setInterval(() => {}, 1000);
  `);
  const invocation = resolveTypeScriptCliInvocation({});
  const admission = await installNativeAdmissionFixture({ root });
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '67108864 100663296\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  await writeFile(join(root, 'bin', 'systemctl'), '#!/bin/sh\nexit 1\n');
  await chmod(join(root, 'bin', 'awk'), 0o755);
  await chmod(join(root, 'bin', 'systemctl'), 0o755);
  // The compiler process is the OS boundary. Keep the runner and selection owner real.
  await writeFile(preload, `
    ${windows || platform ? `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(windows ? 'win32' : platform)} });` : ''}
    ${withoutWorkspaceDist ? `require('node:module').registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@happier-dev/cli-common/process') throw new Error('workspace dist has not been compiled yet');
      return nextResolve(specifier, context);
    }});` : ''}
    ${pauseMeasurementSetup ? `
      // Hold only the OS filesystem boundary; the wrapper's cancellation path stays real.
      const fsPromises = require('node:fs/promises');
      const mkdtemp = fsPromises.mkdtemp;
      fsPromises.mkdtemp = async (...args) => {
        const directory = await mkdtemp(...args);
        await new Promise((resolve) => {
          process.stdin.resume();
          process.once('SIGTERM', () => { process.stdin.pause(); resolve(); });
          require('node:fs').writeFileSync('measurement-setup-ready', 'yes');
        });
        return directory;
      };
    ` : ''}
    const cp = require('node:child_process');
    for (const name of ['spawn', 'spawnSync']) {
      const original = cp[name];
      cp[name] = function(command, args, options) {
        // Package publication now reaches native admission through a shell
        // worker. Keep that genuine OS boundary on this fixture's machine.
        if (command === '/bin/sh' && args[0] === ${JSON.stringify(fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url)))}
          && args[1] === '--heavyweight-admission') {
          args = [${JSON.stringify(admission.launcher)}, ...args.slice(1)];
        }
        ${windows ? `if (args.join(' ').includes('hstack-exec')) {
          return original(process.execPath, ['-e', 'process.exit(7)'], options);
        }` : ''}
        ${route ? `if (command === ${JSON.stringify(fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url)))} && args[0] !== '--heavyweight-admission') {
          require('node:fs').writeFileSync(${JSON.stringify(routedArgsFile)}, JSON.stringify({ args, cwd: options.cwd ?? process.cwd() }));
          command = process.execPath;
          args = [${JSON.stringify(fakeCompiler)}];
        }` : ''}
        if (args[0] === '--heavyweight-admission' && args.includes(${JSON.stringify(invocation.compilerPath)})) {
          // Remap only host state and the native compiler process boundary.
          // The selector and actual admission decision remain exercised.
          command = ${JSON.stringify(admission.launcher)};
          args = args.map(arg => arg === ${JSON.stringify(invocation.compilerPath)} ? ${JSON.stringify(fakeCompiler)} : arg);
          ${spawnError ? `if (args.includes('missing.json')) command = ${JSON.stringify(join(root, 'missing-native'))};` : ''}
        }
        if (command === process.execPath && args[0] === ${JSON.stringify(invocation.compilerPath)}) {
          ${spawnError ? `if (args.includes('missing.json')) command = ${JSON.stringify(join(root, 'missing-native'))};` : ''}
          args = [${JSON.stringify(fakeCompiler)}, ...args.slice(1)];
        }
        // Python is an OS adapter: substitute only its canonical compiler argv, not its wait4 logic.
        if (command === 'python3' && args[0] === ${JSON.stringify(measurementLeaf)} && args.includes(${JSON.stringify(invocation.compilerPath)})) {
          args = [...args];
          if (args[3] === '--heavyweight-admission') args[2] = ${JSON.stringify(admission.launcher)};
          ${spawnError ? `if (args.includes('missing.json')) args[2] = ${JSON.stringify(join(root, 'missing-native'))};` : ''}
          args = args.map(arg => arg === ${JSON.stringify(invocation.compilerPath)} ? ${JSON.stringify(fakeCompiler)} : arg);
        }
        return original(command, args, options);
      };
    }
    require('node:module').syncBuiltinESMExports();
  `);
  let child;
  t.after(async () => {
    // Kill only processes this test started, including the RED reproduction's orphan.
    const workerPid = Number(await readFile(workerPidFile, 'utf8').catch(() => '0'));
    if (workerPid && alive(workerPid)) {
      try { process.kill(workerPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (pid && alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    child?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  return {
    admission,
    pidFile,
    workerPidFile,
    root,
    fakeCompiler,
    routedArgsFile,
    start(args, options = {}) {
      const { command = process.execPath, ...childOptions } = options;
      const env = { ...buildNativeAdmissionFixtureEnv(),
        // This OS-boundary fixture is an independent admitted machine, not
        // the AUTO test runner's worker cache or parent reservation.
        HAPPIER_HSTACK_EXECUTION: '1', HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
        HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
        HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
        // These fixtures exercise Microsoft's process boundary; tsrs selection
        // and its real incremental recovery are covered by the selector suite.
        HAPPIER_TYPESCRIPT_COMPILER: 'microsoft',
        ...options.env, PATH: `${join(root, 'bin')}:${options.env?.PATH ?? process.env.PATH}`,
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, COMPILER_PID_FILE: pidFile };
      if (route || windows) {
        delete env.HAPPIER_HSTACK_EXECUTION;
        delete env.HAPPIER_DEV_TARGET_EXECUTION;
        delete env.HAPPIER_TYPECHECK_DISPATCHED;
      }
      child = spawn(command, args, {
        ...childOptions,
        stdio: options.stdio ?? ['ignore', 'ignore', 'pipe'],
        cwd: root,
        env,
      });
      let stderr = '';
      const stdout = [];
      child.stdout?.on('data', (chunk) => { stdout.push(chunk); });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      return { child, stderr: () => stderr, stdout: () => Buffer.concat(stdout) };
    },
  };
}

for (const scenario of ['stale', 'current', 'pass']) {
  test(`failed emitting compiler declaration hint: ${scenario}`, async t => {
    const setup = await fixture(t, {
      exitCode: scenario === 'pass' ? 0 : 7,
      compilerBody: "process.stderr.write('fixture compiler diagnostic\\n');",
    });
    await writeFile(join(setup.root, 'package.json'), JSON.stringify({
      private: true, packageManager: repositoryPackageManager,
      dependencies: { '@fixture/consumer': 'workspace:*', '@fixture/unvisited': 'workspace:*' },
    }));
    await writeFile(join(setup.root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(join(setup.root, 'pnpm-lock.yaml'), '# fixture\n');
    for (const app of ['ui', 'cli', 'server']) {
      await mkdir(join(setup.root, 'apps', app), { recursive: true });
      await writeFile(join(setup.root, 'apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
    }
    for (const name of ['consumer', 'producer', 'unvisited']) {
      const dir = join(setup.root, 'packages', name);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'index.ts'), 'export const value = true;\n');
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: `@fixture/${name}`, type: 'module', types: './dist/index.d.ts', main: './dist/index.js',
        scripts: { build: 'fixture-build' },
        ...(name === 'consumer' ? { dependencies: { '@fixture/producer': 'workspace:*' } } : {}),
      }));
    }
    const buildOptions = {
      quiet: true, buildMode: 'strict', env: { ...buildNativeAdmissionFixtureEnv(), HAPPIER_WORKSPACE_CAPTURE_INPUTS: '0' },
      workspaceBuildBoundary: {
        workerLauncherPath: setup.admission.launcher,
        async prepareEnv(_dir, env) { return env; },
        // The package compiler is the external process boundary; publication,
        // graph ordering, fingerprints and record verification remain real.
        async runPackageBuild(_dir, { env }) {
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const value = true;\n');
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.d.ts'), 'export declare const value: true;\n');
        },
      },
    };
    await ensureWorkspacePackagesBuiltByName(setup.root, ['@fixture/consumer', '@fixture/unvisited'], buildOptions);
    const producerDir = join(setup.root, 'packages', 'producer');
    assert.equal(isWorkspacePackageOutputCurrent(producerDir, { buildMode: 'strict' }), true);
    if (scenario !== 'current') {
      await writeFile(join(producerDir, 'src', 'index.ts'), 'export const value = false;\n');
    }
    // A real filesystem-boundary probe proves that passing checks never load
    // the diagnostic, and stale checks stop before a later producer's sources.
    const probePath = join(setup.root, 'diagnostic-reads.jsonl');
    const readProbe = join(setup.root, 'read-probe.cjs');
    await writeFile(readProbe, `
      const fs = require('node:fs');
      const original = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (String(path).includes('/packages/') && String(path).includes('/src/')) {
          fs.appendFileSync(${JSON.stringify(probePath)}, JSON.stringify(String(path)) + '\\n');
        }
        return original.call(this, path, ...args);
      };
      require('node:module').syncBuiltinESMExports();
    `);
    const { child, stderr } = setup.start(['--require', readProbe, runner, '--noEmit', 'false']);
    assert.deepEqual(await once(child, 'exit'), [scenario === 'pass' ? 0 : 7, null], stderr());
    assert.match(stderr(), /(?:^|\n)fixture compiler diagnostic\n/);
    const hints = stderr().split('\n').filter(line => line.includes('declarations are older than its source; rebuild:'));
    const reads = await readFile(probePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (scenario === 'stale') {
      assert.equal(hints.length, 1, stderr());
      assert.match(hints[0], /^@fixture\/producer declarations are older than its source; rebuild: /);
      assert.ok(reads.includes('/producer/src/'), reads);
      assert.ok(!reads.includes('/consumer/src/') && !reads.includes('/unvisited/src/'), reads);
      const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
      const buildArgs = parseWorkspaceBuildArgs([...manifest.scripts['build:packages'].split(/\s+/).slice(2), '@fixture/producer']);
      assert.ok(hints[0].endsWith('./apps/stack/bin/hstack-exec -- pnpm run build:packages @fixture/producer'));
      const rebuilt = await ensureWorkspacePackagesBuiltByName(setup.root, buildArgs.packageNames, buildOptions);
      assert.ok(rebuilt.built.includes('@fixture/producer'));
      assert.equal(isWorkspacePackageOutputCurrent(producerDir), true, 'the named producer can be rebuilt by the canonical publisher');
    } else {
      assert.deepEqual(hints, []);
      if (scenario === 'pass') assert.equal(reads, '', 'passing checks do not inspect producer sources');
      else assert.ok(reads.includes('/unvisited/src/'), reads);
    }
  });
}

test('Windows compiler noEmit uses the local native compiler instead of the POSIX router', async (t) => {
  const setup = await fixture(t, { windows: true, exitCode: 0 });
  const { child, stderr } = setup.start([runner, '--noEmit']);
  assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
  assert.ok(Number(await readFile(setup.pidFile, 'utf8')) > 0);
});

for (const args of [[], ['-p', 'apps/ui/tsconfig.json'], ['--build', 'apps/ui/tsconfig.json'], ['--noEmit', 'true']]) {
  test(`direct compiler dispatches through AUTO before project preparation: ${args.join(' ') || 'default project'}`, { skip: process.platform === 'win32' }, async t => {
    const setup = await fixture(t, { route: true, exitCode: 7 });
    const { child, stderr } = setup.start([runner, ...args], { env: { CODEX_CI: '1', CI: 'true' } });
    assert.deepEqual(await once(child, 'exit'), [7, null], stderr());
    const routed = JSON.parse(await readFile(setup.routedArgsFile, 'utf8'));
    assert.deepEqual(routed.args.slice(0, 2), ['--', 'node']);
    assert.equal(fileURLToPath(new URL(routed.args[2], `file://${setup.root}/`)), runner);
    assert.deepEqual(routed.args.slice(3), args);
    assert.equal(routed.cwd, setup.root);
  });
}

for (const marker of ['HAPPIER_HSTACK_EXECUTION', 'HAPPIER_DEV_TARGET_EXECUTION', 'HAPPIER_TYPECHECK_DISPATCHED']) {
  test(`executor-internal compiler retains placement: ${marker}`, async t => {
    const setup = await fixture(t, { exitCode: 7 });
    const { child, stderr } = setup.start([runner], { env: {
      HAPPIER_HSTACK_EXECUTION: '', HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_TYPECHECK_DISPATCHED: '', [marker]: '1',
    } });
    assert.deepEqual(await once(child, 'exit'), [7, null], stderr());
    await assert.rejects(readFile(setup.routedArgsFile), { code: 'ENOENT' });
    assert.ok(Number(await readFile(setup.pidFile, 'utf8')) > 0);
  });
}

test('direct compiler --local delegates the explicit escape to executor policy', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t, { route: true, exitCode: 0 });
  const { child, stderr } = setup.start([runner, '--local', '--allow-local-compilation', '-p', 'tsconfig.json']);
  assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
  const routed = JSON.parse(await readFile(setup.routedArgsFile, 'utf8'));
  assert.deepEqual(routed.args.slice(0, 4), ['--local', '--allow-local-compilation', '--', 'node']);
  assert.deepEqual(routed.args.slice(5), ['-p', 'tsconfig.json']);
});

test('compiler --local executes on its current worker without forwarding executor flags to TypeScript', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t, { exitCode: 0, compilerBody: `
    if (process.argv.includes('--local') || process.argv.includes('--allow-local-compilation')) process.exit(9);
  ` });
  const { child, stderr } = setup.start([runner, '--local'], { env: { HAPPIER_DEV_TARGET_EXECUTION: '1' } });
  assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
  assert.ok(Number(await readFile(setup.pidFile, 'utf8')) > 0);
});

test('root pnpm tsc delegates direct project compilation to the same AUTO owner', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t, { route: true, exitCode: 7 });
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  await writeFile(join(setup.root, 'package.json'), JSON.stringify({
    private: true, scripts: { tsc: manifest.scripts.tsc.replace('scripts/workspaces/runTypeScriptCli.mjs', JSON.stringify(runner)) },
  }));
  const pnpm = resolvePnpmCommandInvocation(['-s', 'tsc', '-p', 'apps/ui/tsconfig.json']);
  const { child, stderr } = setup.start(pnpm.args, { command: pnpm.command });
  assert.deepEqual(await once(child, 'exit'), [7, null], stderr());
  const routed = JSON.parse(await readFile(setup.routedArgsFile, 'utf8'));
  assert.deepEqual(routed.args.slice(0, 2), ['--', 'node']);
  assert.deepEqual(routed.args.slice(3), ['-p', 'apps/ui/tsconfig.json']);
});

for (const env of [
  { npm_lifecycle_event: 'typecheck:source:finite' },
  { npm_lifecycle_event: 'typecheck:finite', CI: 'true' },
  { npm_lifecycle_event: 'typecheck:tests:prepared' },
  { npm_lifecycle_event: 'typecheck:tests:prepared', TURBO_TASK_ID: '@happier-dev/plugin-sdk#typecheck:finite' },
  { npm_lifecycle_event: 'typecheck:source:finite', TURBO_TASK_ID: '@happier-dev/cli#test:finite' },
]) {
  test(`finite compiler refuses undispatched ${env.TURBO_TASK_ID ?? env.npm_lifecycle_event}`, async (t) => {
    const setup = await fixture(t, { exitCode: 0 });
    const { child, stderr } = setup.start([runner], { env: { ...env, HAPPIER_TYPECHECK_DISPATCHED: '' } });
    assert.deepEqual(await once(child, 'exit'), [1, null], stderr());
    assert.match(stderr(), /run `pnpm run typecheck` \(routed\) instead of `typecheck:(?:source:)?finite`/);
    await assert.rejects(readFile(setup.pidFile), { code: 'ENOENT' });
  });
}

test('finite compiler accepts explicit public-owner dispatch without changing compiler failure status', async (t) => {
  const setup = await fixture(t, { exitCode: 7 });
  const { child, stderr } = setup.start([runner], { env: {
    npm_lifecycle_event: 'typecheck:source:finite', HAPPIER_TYPECHECK_DISPATCHED: '1',
  } });
  assert.deepEqual(await once(child, 'exit'), [7, null], stderr());
  assert.ok(Number(await readFile(setup.pidFile, 'utf8')) > 0);
});

test('public CLI compiler checks its selected roots and admits concurrent additions on the next invocation', async t => {
  const setup = await fixture(t, { exitCode: 0, compilerBody: `
    const fs = require('node:fs');
    const path = require('node:path');
    const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--project') + 1], 'utf8'));
    fs.appendFileSync(path.join(process.cwd(), 'checked-inputs.jsonl'), JSON.stringify(config.files) + '\\n');
  ` });
  await mkdir(join(setup.root, 'src'));
  await writeFile(join(setup.root, 'src/kept.ts'), 'export const kept = 1;');
  await writeFile(join(setup.root, 'src/globals.d.ts'), 'declare const shared: string;');
  await writeFile(join(setup.root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { noEmit: true, types: [] }, include: ['src/**/*.ts'],
  }));
  const manifest = JSON.parse(await readFile(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'));
  const names = [...manifest.scripts['typecheck:source:finite'].matchAll(/--project tsconfig\.([^ ]+)\.json/g)].map(([, name]) => name);
  for (const name of names) await writeFile(join(setup.root, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', files: ['src/globals.d.ts'], include: [],
  }));
  // The filesystem boundary creates a real root after the last finite project
  // is published. Derivation, coverage, and runner wiring all remain real.
  const preloadPath = join(setup.root, 'preload.cjs');
  await writeFile(preloadPath, await readFile(preloadPath, 'utf8') + `
    const fsPromises = require('node:fs/promises');
    const originalRename = fsPromises.rename;
    fsPromises.rename = async (from, to) => {
      await originalRename(from, to);
      if (require('node:path').basename(to) === 'tsconfig.test-ui.json') {
        require('node:fs').writeFileSync('src/late.ts', 'export const late = 1;');
      }
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const run = () => setup.start([runner, '--verifyProjectCoverage', 'tsconfig.json',
    ...names.flatMap(name => ['--project', `tsconfig.${name}.json`])]);
  const first = run();
  assert.deepEqual(await once(first.child, 'exit'), [0, null], first.stderr());
  const inputs = async () => (await readFile(join(setup.root, 'checked-inputs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).flat();
  assert.ok(!(await inputs()).includes(join(setup.root, 'src/late.ts')));
  const next = run();
  assert.deepEqual(await once(next.child, 'exit'), [0, null], next.stderr());
  assert.equal((await inputs()).filter(path => path === join(setup.root, 'src/late.ts')).length, 1);
});

for (const windows of [false, true]) {
  for (const outcome of ['success', 'failure', 'diagnostics-fresh', 'diagnostics-stale', 'diagnostics-missing', 'diagnostics-partial', 'diagnostics-transitive-partial', 'diagnostics-stale-inventory', 'crash', 'signal']) {
    const failPreparation = outcome === 'failure';
    const producerDiagnostics = outcome.startsWith('diagnostics-');
    const continues = outcome === 'success' || outcome === 'diagnostics-fresh';
    test(`referenced UI declarations prepare cold CLI compilation (${windows ? 'Windows' : 'POSIX'}, ${outcome})`, async (t) => {
      const setup = await fixture(t, { windows, exitCode: 0, compilerBody: `
        const fs = require('node:fs');
        const path = require('node:path');
        const root = process.env.DECLARATION_FIXTURE_ROOT;
        const project = path.resolve(process.argv[process.argv.indexOf('--project') + 1]);
        const uiDir = path.join(root, 'apps', 'ui');
        fs.appendFileSync(path.join(root, 'compiler-projects.jsonl'), JSON.stringify(project) + '\\n');
        if (project.startsWith(uiDir + path.sep)) {
          if (process.env.FAIL_DECLARATION_PREPARATION === '1') process.exit(23);
          if (path.basename(project) === 'tsconfig.source.json') {
            const outcome = process.env.PRODUCER_OUTCOME ?? 'success';
            if (outcome === 'crash') { process.stdout.write('compiler crashed\\n'); process.exit(1); }
            if (outcome === 'signal') { process.kill(process.pid, 'SIGTERM'); return; }
            fs.mkdirSync(path.join(uiDir, 'declarations'), { recursive: true });
            if (outcome === 'diagnostics-transitive-partial') {
              // A source change after finite derivation reaches the compiler
              // but is absent from the configured root membership.
              fs.writeFileSync(path.join(uiDir, 'late.ts'), 'export interface Late { value: true; }\\n');
              fs.appendFileSync(path.join(uiDir, 'source.ts'), 'export type { Late } from "./late";\\n');
              fs.writeFileSync(path.join(uiDir, 'declarations', 'late.d.ts'), 'export interface Late { value: false; }\\n');
            }
            if (!['diagnostics-stale', 'diagnostics-missing'].includes(outcome)) {
              fs.writeFileSync(path.join(uiDir, 'declarations', 'source.d.ts'), fs.readFileSync(path.join(uiDir, 'source.ts')));
              if (process.argv.includes('--listEmittedFiles')) process.stdout.write('TSFILE: ' + path.join(uiDir, 'declarations', 'source.d.ts') + '\\n');
              if (outcome !== 'diagnostics-partial') {
                fs.writeFileSync(path.join(uiDir, 'declarations', 'extra.d.ts'), 'export declare const extra: true;\\n');
                if (process.argv.includes('--listEmittedFiles')) process.stdout.write('TSFILE: ' + path.join(uiDir, 'declarations', 'extra.d.ts') + '\\n');
              }
            }
            const buildInfo = path.join(uiDir, 'fixture.typecheck.tsbuildinfo');
            if (outcome !== 'diagnostics-stale-inventory') {
              fs.writeFileSync(buildInfo, JSON.stringify({ fileNames: ['source.ts', 'extra.ts',
                ...(outcome === 'diagnostics-transitive-partial' ? ['late.ts'] : [])] }));
              if (process.argv.includes('--listEmittedFiles')) process.stdout.write('TSFILE: ' + buildInfo + '\\n');
            }
            if (outcome.startsWith('diagnostics-')) {
              process.stdout.write(path.join(uiDir, 'source.ts') + '(1,7): error TS2322: captured producer diagnostic\\n');
              process.exit(2);
            }
          }
        } else if (path.basename(project) === 'tsconfig.test.json'
          && !fs.existsSync(path.join(uiDir, 'declarations', 'source.d.ts'))) process.exit(24);
        else if (path.basename(project) === 'tsconfig.test.json'
          && fs.readFileSync(path.join(uiDir, 'declarations', 'source.d.ts'), 'utf8') !== fs.readFileSync(path.join(uiDir, 'source.ts'), 'utf8')) process.exit(25);
      ` });
      const cliDir = join(setup.root, 'apps', 'cli');
      const uiDir = join(setup.root, 'apps', 'ui');
      await mkdir(cliDir, { recursive: true });
      await mkdir(uiDir, { recursive: true });
      // Expo is the real installed configuration boundary used by UI preparation.
      await mkdir(join(uiDir, 'node_modules'));
      const uiRequire = createRequire(new URL('../../apps/ui/package.json', import.meta.url));
      await symlink(dirname(uiRequire.resolve('expo/package.json')), join(uiDir, 'node_modules/expo'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'ui-declaration-fixture' }));
      await writeFile(join(uiDir, 'app.json'), JSON.stringify({ expo: { name: 'UI declaration fixture', slug: 'ui-declaration-fixture', experiments: { typedRoutes: false } } }));
      await writeFile(join(uiDir, 'source.ts'), 'export declare const value: true;\n');
      await writeFile(join(uiDir, 'extra.ts'), 'export declare const extra: true;\n');
      await writeFile(join(uiDir, 'source.test.ts'), 'export const testValue = true;\n');
      await writeFile(join(uiDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2020' },
        files: ['source.ts', 'extra.ts', 'source.test.ts'],
      }));
      for (const name of ['foundation', 'core', 'source', 'test']) {
        await writeFile(join(uiDir, `tsconfig.${name}.json`), JSON.stringify({
          extends: './tsconfig.json', files: name === 'test' ? ['source.test.ts'] : ['source.ts', 'extra.ts'], include: [],
          compilerOptions: name === 'test' ? { noEmit: true } : {
            composite: true, noEmit: false, emitDeclarationOnly: true, rootDir: '.', outDir: './declarations',
            tsBuildInfoFile: './fixture.typecheck.tsbuildinfo',
          },
        }));
      }
      for (const name of ['test-components', 'test-other']) await writeFile(join(uiDir, `tsconfig.${name}.json`), JSON.stringify({
        extends: './tsconfig.test.json', include: [],
      }));
      await writeFile(join(cliDir, 'source.ts'), 'export const cliValue = true;\n');
      await writeFile(join(cliDir, 'source.test.ts'), 'export const cliTestValue = true;\n');
      await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: 'cli-declaration-fixture' }));
      await writeFile(join(cliDir, 'tsconfig.source.json'), JSON.stringify({ files: ['source.ts'] }));
      await writeFile(join(cliDir, 'tsconfig.test.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, disableSourceOfProjectReferenceRedirect: true },
        files: ['source.test.ts'], references: [
          { path: './tsconfig.source.json' }, { path: '../ui/tsconfig.source.json' },
        ],
      }));
      await assert.rejects(readFile(join(uiDir, 'declarations', 'source.d.ts')), { code: 'ENOENT' });
      if (outcome === 'diagnostics-stale' || outcome === 'diagnostics-partial') {
        await mkdir(join(uiDir, 'declarations'));
        await writeFile(join(uiDir, 'declarations', 'source.d.ts'), 'export declare const value: false;\n');
        await writeFile(join(uiDir, 'declarations', 'extra.d.ts'), 'export declare const extra: false;\n');
      }
      if (outcome === 'diagnostics-stale-inventory') await writeFile(join(uiDir, 'fixture.typecheck.tsbuildinfo'), JSON.stringify({ fileNames: ['source.ts', 'extra.ts'] }));
      await writeFile(join(setup.root, '.gitignore'), 'node_modules/\ndeclarations/\n');
      const git = (...args) => spawnSync('git', args, { cwd: setup.root, encoding: 'utf8' });
      assert.equal(git('init', '-q').status, 0);
      assert.equal(git('add', '.').status, 0);
      assert.equal(git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture').status, 0);
      const snapshot = join(cliDir, 'node_modules/.cache/typecheck/diagnostics.json');
      await mkdir(dirname(snapshot), { recursive: true });
      const previous = JSON.stringify({ projects: ['apps/cli/tsconfig.test.json'], diagnosticsByPath: {}, globalDiagnostics: 0 });
      await writeFile(snapshot, previous);
      const { child, stderr } = setup.start([runner, '--singleThreaded',
        '--project', join(cliDir, 'tsconfig.source.json'), '--project', join(cliDir, 'tsconfig.test.json')], {
        env: { DECLARATION_FIXTURE_ROOT: setup.root, FAIL_DECLARATION_PREPARATION: failPreparation ? '1' : '', PRODUCER_OUTCOME: outcome },
      });
      assert.deepEqual(await once(child, 'exit'), outcome === 'signal' ? (windows ? [143, null] : [null, 'SIGTERM'])
        : [failPreparation ? 23 : producerDiagnostics ? 2 : outcome === 'crash' ? 1 : 0, null], stderr());
      const compiled = (await readFile(join(setup.root, 'compiler-projects.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(compiled, failPreparation ? [join(uiDir, 'node_modules/.cache/tsc/tsconfig.foundation.json')] : [
        ...['foundation', 'core', 'source'].map(name => join(uiDir, `node_modules/.cache/tsc/tsconfig.${name}.json`)),
        ...(continues ? [join(cliDir, 'tsconfig.source.json'), join(cliDir, 'node_modules/.cache/tsc/tsconfig.test.json')] : []),
      ]);
      if (outcome === 'diagnostics-fresh') {
        assert.match(stderr(), /complete with producer diagnostics/);
        assert.match(stderr(), /apps\/cli: 0 new in touched paths/);
        const saved = JSON.parse(await readFile(snapshot, 'utf8'));
        assert.deepEqual(saved.diagnosticsByPath['apps/ui/source.ts'], [{ line: 1, column: 7, code: 2322 }]);
      } else if (!continues) {
        assert.match(stderr(), /unavailable: no complete diagnostic result/);
        assert.equal(await readFile(snapshot, 'utf8'), previous);
      }
      if (outcome === 'success') {
        assert.equal(await readFile(join(uiDir, 'declarations', 'source.d.ts'), 'utf8'), 'export declare const value: true;\n');
        await writeFile(join(uiDir, 'source.ts'), 'export declare const value: false;\n');
        const changed = setup.start([runner, '--singleThreaded',
          '--project', join(cliDir, 'tsconfig.source.json'), '--project', join(cliDir, 'tsconfig.test.json')], {
          env: { DECLARATION_FIXTURE_ROOT: setup.root },
        });
        assert.deepEqual(await once(changed.child, 'exit'), [0, null], changed.stderr());
        assert.equal(await readFile(join(uiDir, 'declarations', 'source.d.ts'), 'utf8'), 'export declare const value: false;\n');
      }
    });
  }
}

test('actual CLI and Plugin SDK direct finite Pnpm entries refuse before compilation', () => {
  for (const [workspace, task] of [['apps/cli', 'typecheck:source:finite'], ['packages/plugin-sdk', 'typecheck:finite']]) {
    const pnpm = resolvePnpmCommandInvocation(['--dir', fileURLToPath(new URL(`../../${workspace}/`, import.meta.url)), '-s', 'run', task]);
    const result = spawnSync(pnpm.command, pnpm.args, {
      encoding: 'utf8',
      env: { ...process.env, HAPPIER_TYPECHECK_DISPATCHED: '', TURBO_TASK_ID: '' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`run \`pnpm run typecheck\` (routed) instead of \`${task}\``), result.stderr);
  }
});

for (const explicitLocal of [false, true]) {
  test(`public Pnpm typecheck reaches its finite compiler (${explicitLocal ? '--local' : 'already routed'})`, { skip: process.platform === 'win32' }, async (t) => {
    const setup = await fixture(t, { exitCode: 0 });
    const launcher = fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url));
    const cliPackage = JSON.parse(await readFile(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'));
    const compilerArgs = cliPackage.scripts['typecheck:source:finite'].trim().split(/\s+/u);
    const projects = compilerArgs.filter((arg, index) => compilerArgs[index - 1] === '--project');
    for (const [index, project] of projects.entries()) {
      const file = `fixture-${index}.ts`;
      await writeFile(join(setup.root, file), 'export const value = 1;\n');
      await writeFile(join(setup.root, project), JSON.stringify({ files: [file] }));
    }
    await writeFile(join(setup.root, 'tsconfig.json'), JSON.stringify({ include: ['fixture-*.ts'] }));
    const binDir = join(setup.root, 'bin');
    await mkdir(binDir, { recursive: true });
    // The compiler is substituted; avoid admitting its tiny OS-boundary fixture
    // as a full compilation on a worker below the real compiler memory floor.
    await writeFile(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
    await chmod(join(binDir, 'uname'), 0o755);
    await writeFile(join(setup.root, 'package.json'), JSON.stringify({
      name: 'finite-dispatch-fixture',
      packageManager: repositoryPackageManager,
      scripts: {
        typecheck: cliPackage.scripts.typecheck.replace('../stack/bin/hstack-exec', `${JSON.stringify(launcher)}${explicitLocal ? ' --local' : ''}`),
        'typecheck:local': cliPackage.scripts['typecheck:local'],
        'typecheck:source:finite': cliPackage.scripts['typecheck:source:finite'].replace('../../scripts/workspaces/runTypeScriptCli.mjs', JSON.stringify(runner)),
      },
    }));
    const pnpm = resolvePnpmCommandInvocation(['-s', 'typecheck']);
    const { child, stderr } = setup.start(pnpm.args, { command: pnpm.command, env: {
      HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_TYPECHECK_DISPATCHED: '',
      PATH: `${binDir}:${process.env.PATH}`,
    } });
    assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
    assert.ok(Number(await readFile(setup.pidFile, 'utf8')) > 0);
  });
}

for (const windows of [false, true]) {
  test(`compiler can bootstrap workspace dist (${windows ? 'Windows' : 'POSIX'} boundary)`, async (t) => {
    const setup = await fixture(t, { windows, withoutWorkspaceDist: true, exitCode: 0 });
    const { child, stderr } = setup.start([runner]);
    assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
  });
}

test('package build cancellation reaps the compiler, preserves dist, and exits with its signal', { skip: process.platform === 'win32' }, async (t) => {
  const setup = await fixture(t);
  // The build owner parses the real project before starting its OS compiler boundary.
  await writeFile(join(setup.root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'] }));
  await writeFile(join(setup.root, 'source.ts'), 'export const value = 1;\n');
  const { child, stderr } = setup.start([buildRunner]);
  await waitUntil(() => readFile(setup.pidFile).then(() => true, () => false), `compiler did not start: ${stderr()}`);
  const pid = Number(await readFile(setup.pidFile, 'utf8'));
  let parentResult = null;
  let compilerState = 'unobserved';
  const exited = once(child, 'exit').then(result => { parentResult = result; return result; });
  child.kill('SIGTERM');
  assert.equal(await readFile(join(setup.root, 'dist', 'index.js'), 'utf8'), 'last-green');
  await waitUntil(async () => {
    if (!alive(pid)) return true;
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
      compilerState = status.split('\n').filter(line => /^(State|PPid):/.test(line)).join(', ');
    }
    return false;
  }, () => `package build compiler ${pid} survived cancellation (${compilerState}; parent=${JSON.stringify(parentResult)})`);
  assert.deepEqual(await exited, [null, 'SIGTERM']);
  assert.equal(await readFile(join(setup.root, 'dist', 'index.js'), 'utf8'), 'last-green');
});

test('package build cancellation while queued releases its waiter and preserves the foreign publisher', { skip: process.platform !== 'linux' }, async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'] }));
  await writeFile(join(setup.root, 'source.ts'), 'export const value = 1;\n');
  const lockPath = resolveWorkspacePackageBuildLockPath(setup.root, { name: 'cancellation-fixture' });
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const code = `import { buildTypeScriptPackageDist } from ${JSON.stringify(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url).href)};
      import { exitWithCommandResult } from ${JSON.stringify(procModule)};
      try { await buildTypeScriptPackageDist(); } catch (error) {
        await new Promise(resolve => process.stdout.write(JSON.stringify({ status: error.exitCode, signal: error.signal }), resolve));
        exitWithCommandResult({ status: error.exitCode, signal: error.signal });
      }`;
    const { child, stderr, stdout } = setup.start(['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitUntil(() => stderr().includes('workspace-lease-busy'), () => `build did not queue: ${stderr()}`);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [null, 'SIGTERM']);
    assert.deepEqual(JSON.parse(stdout().toString()), { status: null, signal: 'SIGTERM' });
    assert.deepEqual(await readdir(join(setup.root, 'host-admission', 'waiters')), []);
    assert.equal(callerHoldsWorkspaceBundleLock(lockPath, heldLockValue), true);
    await assert.rejects(readFile(setup.pidFile), { code: 'ENOENT' });
    assert.equal(await readFile(join(setup.root, 'dist', 'index.js'), 'utf8'), 'last-green');
  }, { lockPath });
});

test('package build preserves numeric compiler exit 130 without inventing a caller signal', async t => {
  const setup = await fixture(t, { exitCode: 130 });
  await writeFile(join(setup.root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'] }));
  await writeFile(join(setup.root, 'source.ts'), 'export const value = 1;\n');
  const { child, stderr } = setup.start([buildRunner]);
  assert.deepEqual(await once(child, 'exit'), [130, null], stderr());
  assert.equal(await readFile(join(setup.root, 'dist', 'index.js'), 'utf8'), 'last-green');
});

test('CLI bundle wrapper owns its heavy child until cancellation is reaped', { skip: process.platform === 'win32' }, async (t) => {
  const setup = await fixture(t);
  const code = `import { runPkgrollBuild } from ${JSON.stringify(new URL('../../apps/cli/scripts/runPkgrollBuild.mjs', import.meta.url).href)}; import { exitWithCommandResult } from ${JSON.stringify(procModule)}; try { await runPkgrollBuild({ packageJsonPath: ${JSON.stringify(join(setup.root, 'package.json'))}, outputDir: 'dist.stage', pkgrollCliPath: ${JSON.stringify(setup.fakeCompiler)} }); } catch(error) { exitWithCommandResult({ status: 1, signal: error.signal }); }`;
  const { child, stderr } = setup.start(['--input-type=module', '-e', code]);
  await waitUntil(() => readFile(setup.pidFile).then(() => true, () => false), `bundler did not start: ${stderr()}`);
  const pid = Number(await readFile(setup.pidFile, 'utf8'));
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await waitUntil(() => !alive(pid), 'bundle child survived cancellation');
  assert.deepEqual(await exited, [null, 'SIGTERM']);
});

test('routed compiler wrapper forwards cancellation to its launcher', { skip: process.platform === 'win32' }, async (t) => {
  const setup = await fixture(t, { route: true });
  const { child, stderr } = setup.start([runner, '--noEmit']);
  await waitUntil(() => readFile(setup.pidFile).then(() => true, () => false), `launcher did not start: ${stderr()}`);
  const pid = Number(await readFile(setup.pidFile, 'utf8'));
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await waitUntil(() => !alive(pid), 'routed launcher survived cancellation');
  assert.deepEqual(await exited, [null, 'SIGTERM']);
});

for (const exitCode of [0, 7]) {
  test(`compiler runner preserves compiler exit code ${exitCode}`, async (t) => {
    const setup = await fixture(t, { exitCode });
    const { child, stderr } = setup.start([runner]);
    assert.deepEqual(await once(child, 'exit'), [exitCode, null], stderr());
  });
}

for (const status of [0, 1, 7]) {
  test(`baseline reporting records actual native result ${status} and preserves visible diagnostics`, async (t) => {
    const output = status === 0 ? '' : "source.ts(3,2): error TS2322: Type 'number' is not assignable to type 'string'.\\n  A nested diagnostic.\\n";
    const setup = await fixture(t, { exitCode: status, compilerBody: `process.stdout.write(${JSON.stringify(output.replaceAll('\\n', '\n'))});` });
    const reports = join(setup.root, 'compiler-results');
    await mkdir(reports);
    await writeFile(join(setup.root, 'tsconfig.json'), JSON.stringify({ files: [] }));
    const { child, stderr, stdout } = setup.start([runner, '--noEmit', '--project', 'tsconfig.json'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { HAPPIER_TYPECHECK_REPORT_DIR: reports },
    });
    assert.deepEqual(await once(child, 'exit'), [status, null], stderr());
    assert.equal(stdout().toString(), output.replaceAll('\\n', '\n'));
    const names = await readdir(reports);
    assert.equal(names.length, 1, 'each attempted compiler publishes its terminal result');
    const report = JSON.parse(await readFile(join(reports, names[0]), 'utf8'));
    assert.equal(report.status, status);
    assert.equal(report.signal, null);
    assert.equal(report.project, 'tsconfig.json');
    assert.equal(report.cwd, setup.root);
    assert.equal(report.stdout, stdout().toString());
  });
}

for (const reference of [false, true]) {
test(`package diagnostic delta reaches the runner without changing compiler output or failure status (reference=${reference})`, async t => {
  const diagnostic = "source.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  const setup = await fixture(t, { exitCode: 2, compilerBody: `process.stdout.write(${JSON.stringify(diagnostic)});` });
  await writeFile(join(setup.root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(setup.root, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}');
  await writeFile(join(setup.root, 'source.ts'), 'export const value = 1;\n');
  const git = (...args) => spawnSync('git', args, { cwd: setup.root, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture').status, 0);
  if (reference) {
    const directory = join(setup.root, '.project/plans/2026-10-17-coordination/qa/baselines');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'root.json'), JSON.stringify({
      projects: ['tsconfig.json'], diagnosticsByPath: {}, globalDiagnostics: 0,
    }));
  }
  for (const baseline of [false, true]) {
    const { child, stderr, stdout } = setup.start([runner, '--noEmit', '-p', 'tsconfig.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.deepEqual(await once(child, 'exit'), [2, null], stderr());
    assert.equal(stdout().toString(), diagnostic);
    assert.match(stderr(), baseline || reference ? /0 new in touched paths/ : /baseline unavailable/);
    if (baseline) assert.match(stderr(), /baseline local/);
    else if (reference) assert.match(stderr(), /baseline reference \.project\/plans\/2026-10-17-coordination\/qa\/baselines\/root\.json/);
  }
  const saved = JSON.parse(await readFile(join(setup.root, 'node_modules/.cache/typecheck/diagnostics.json'), 'utf8'));
  assert.deepEqual(saved.diagnosticsByPath['source.ts'], [{ line: 1, column: 7, code: 2322 }]);
});
}

test('snapshot failures report a safe step and code without changing the compiler verdict', async t => {
  const diagnostic = 'source.ts(1,7): error TS2322: captured diagnostic\n';
  const setup = await fixture(t, { exitCode: 2, compilerBody: `process.stdout.write(${JSON.stringify(diagnostic)});` });
  await writeFile(join(setup.root, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}');
  const git = (...args) => spawnSync('git', args, { cwd: setup.root, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  await mkdir(join(setup.root, 'node_modules/.cache/typecheck/diagnostics.json'), { recursive: true });
  const { child, stderr, stdout } = setup.start([runner, '--noEmit', '-p', 'tsconfig.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(await once(child, 'exit'), [2, null], stderr());
  assert.equal(stdout().toString(), diagnostic);
  const fallback = stderr().split('\n').find(line => line.startsWith('[typecheck-delta] unavailable:'));
  assert.match(fallback, /snapshot-read:EISDIR/);
  assert.ok(!fallback.includes(setup.root));
  assert.match(fallback, /compiler verdict unchanged/);
});

test('compiler cancellation reaches its native worker process group', { skip: process.platform === 'win32' }, async (t) => {
  const setup = await fixture(t, { tree: true });
  const { child } = setup.start([runner]);
  await waitUntil(() => readFile(setup.workerPidFile).then(() => true, () => false), 'native worker did not start');
  const pid = Number(await readFile(setup.pidFile, 'utf8'));
  const workerPid = Number(await readFile(setup.workerPidFile, 'utf8'));
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await waitUntil(() => !alive(pid) && !alive(workerPid), 'compiler or native worker survived cancellation');
  assert.deepEqual(await exited, [null, 'SIGTERM']);
});

for (const target of ['compiler leaf', 'outer heartbeat']) {
  test(`root Pnpm suite distinguishes SIGTERM of ${target} from an aggregate failure`, { skip: process.platform === 'win32' }, async (t) => {
    const setup = await fixture(t, { tree: target === 'outer heartbeat' });
    const sentinelFile = join(setup.root, 'sentinel');
    const suiteStartedFile = join(setup.root, 'suite-started.json');
    const suiteScript = join(setup.root, 'suite.mjs');
    await writeFile(suiteScript, `
      import { writeFile } from 'node:fs/promises';
      import { runRootTypecheck } from ${JSON.stringify(rootTypecheckModule)};
      await writeFile(${JSON.stringify(suiteStartedFile)}, JSON.stringify({ pnpm: process.env.npm_config_user_agent }));
      try {
        await runRootTypecheck({ commands: [
          { id: 'compiler-leaf', args: ['--silent', 'run', 'compiler'] },
          { id: 'subsequent-sentinel', args: ['--silent', 'run', 'sentinel'] },
        ] });
      } catch (error) {
        process.stderr.write(error.message + '\\n');
        process.exitCode = 1;
      }
    `);
    const nodeScript = (path) => `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
    const sentinelScript = `require('node:fs').writeFileSync(${JSON.stringify(sentinelFile)}, 'attempted');`;
    await writeFile(join(setup.root, 'package.json'), JSON.stringify({
      name: 'cancellation-fixture',
      type: 'module',
      packageManager: repositoryPackageManager,
      scripts: {
        'root-suite': `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(suiteScript)}`,
        compiler: nodeScript(runner),
        sentinel: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(sentinelScript)}`,
      },
    }));
    const pnpm = resolvePnpmCommandInvocation(['--silent', 'run', 'root-suite']);
    const { child, stderr } = setup.start([heartbeatRunner, '--', pnpm.command, ...pnpm.args]);
    // The marker belongs only to the substituted compiler, before any signal is sent.
    await waitUntil(() => readFile(setup.pidFile).then(() => true, () => false), () => `fake compiler did not start: ${stderr()}`);
    assert.equal(JSON.parse(await readFile(suiteStartedFile, 'utf8')).pnpm.split(' ')[0],
      repositoryPackageManager.replace('pnpm@', 'pnpm/').split('+')[0]);
    const compilerPid = Number(await readFile(setup.pidFile, 'utf8'));
    const exited = once(child, 'exit');
    if (target === 'compiler leaf') {
      process.kill(compilerPid, 'SIGTERM');
      assert.deepEqual(await exited, [1, null], stderr());
      await waitUntil(() => !alive(compilerPid), 'compiler leaf survived SIGTERM');
      assert.equal(await readFile(sentinelFile, 'utf8'), 'attempted');
      assert.match(stderr(), /^Root typecheck suite failures:\n- compiler-leaf: exited with status 143$/m);
    } else {
      await waitUntil(() => readFile(setup.workerPidFile).then(() => true, () => false), 'native worker did not start');
      const workerPid = Number(await readFile(setup.workerPidFile, 'utf8'));
      child.kill('SIGTERM');
      await waitUntil(() => !alive(compilerPid) && !alive(workerPid), 'compiler or native worker survived outer cancellation');
      assert.deepEqual(await exited, [null, 'SIGTERM'], stderr());
      assert.equal(await readFile(sentinelFile, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }), null);
      assert.doesNotMatch(stderr(), /Root typecheck suite failures:/);
    }
    t.diagnostic(stderr());
  });
}

function measurements(stderr) {
  return stderr.split('\n').filter((line) => line.startsWith('[typescript] {')).map((line) => JSON.parse(line.slice('[typescript] '.length)));
}

const recordingCompiler = `
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => arg === '-p' || arg === '--project');
  const project = index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith('--project='))?.slice('--project='.length);
  const config = JSON.parse(fs.readFileSync(project, 'utf8'));
  const allocation = Buffer.alloc((config.fixtureMemoryMiB ?? 1) * 1024 * 1024, 1);
  fs.appendFileSync('executions.jsonl', JSON.stringify({ project, args, pid: process.pid, noEmit: config.compilerOptions.noEmit, rss: process.memoryUsage().rss }) + '\\n');
  process.exit(config.fixtureStatus ?? 0);
`;

test('compiler partition coverage rejects new unassigned source before spawning and accepts the corrected partition', async (t) => {
  const setup = await fixture(t, { compilerBody: recordingCompiler });
  for (const file of ['owned.ts', 'new.ts', 'owned.test.ts']) {
    await writeFile(join(setup.root, file), 'export const value = 1;\n');
  }
  await writeFile(join(setup.root, 'tsconfig.json'), JSON.stringify({ files: ['owned.ts', 'new.ts', 'owned.test.ts'] }));
  await writeFile(join(setup.root, 'source.json'), JSON.stringify({ compilerOptions: { noEmit: false }, files: ['owned.ts'] }));
  await writeFile(join(setup.root, 'test.json'), JSON.stringify({ compilerOptions: { noEmit: true }, files: ['owned.test.ts'] }));
  const args = [runner, '--verifyProjectCoverage', 'tsconfig.json', '--project', 'source.json', '--project', 'test.json'];
  const missing = setup.start(args);
  assert.deepEqual(await once(missing.child, 'exit'), [1, null], missing.stderr());
  assert.match(missing.stderr(), /partition coverage.*new\.ts/s);
  await assert.rejects(readFile(setup.pidFile), { code: 'ENOENT' });
  await writeFile(join(setup.root, 'source.json'), JSON.stringify({ compilerOptions: { noEmit: false }, files: ['owned.ts', 'new.ts'] }));
  const corrected = setup.start(args);
  assert.deepEqual(await once(corrected.child, 'exit'), [0, null], corrected.stderr());
  const executions = (await readFile(join(setup.root, 'executions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(executions.map(({ project }) => project), ['source.json', 'test.json']);
  assert.ok(executions.every(({ args }) => !args.includes('--verifyProjectCoverage')));
  await writeFile(join(setup.root, 'test.json'), JSON.stringify({ compilerOptions: { noEmit: true }, files: ['owned.test.ts', 'owned.ts'] }));
  const duplicate = setup.start(args);
  assert.deepEqual(await once(duplicate.child, 'exit'), [1, null], duplicate.stderr());
  assert.match(duplicate.stderr(), /duplicate: owned\.ts.*source\.json.*test\.json/);
  assert.equal((await readFile(join(setup.root, 'executions.jsonl'), 'utf8')).trim().split('\n').length, 2);
});

test('compiler projects run serially with their own emission modes and retain all diagnostic failures', async (t) => {
  const setup = await fixture(t, { compilerBody: recordingCompiler });
  for (const [name, noEmit, fixtureStatus] of [['source', false, 7], ['test', true, 2], ['last', true, 0]]) {
    await writeFile(join(setup.root, `${name}.json`), JSON.stringify({ compilerOptions: { noEmit }, fixtureStatus }));
  }
  const { child, stderr } = setup.start([runner, '-p', 'source.json', '--pretty', 'false', '--project', 'test.json', '--project=last.json']);
  assert.deepEqual(await once(child, 'exit'), [2, null], stderr());
  const executions = (await readFile(join(setup.root, 'executions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(executions.map(({ project, noEmit }) => ({ project, noEmit })), [
    { project: 'source.json', noEmit: false }, { project: 'test.json', noEmit: true }, { project: 'last.json', noEmit: true },
  ]);
  assert.equal(new Set(executions.map(({ pid }) => pid)).size, 3, 'each program gets a fresh compiler process');
  for (const execution of executions) {
    assert.deepEqual(execution.args, ['--pretty', 'false', '--project', execution.project]);
  }
});

test('compiler single-project argv keeps original spelling and ordering', async (t) => {
  const setup = await fixture(t, { compilerBody: recordingCompiler });
  await writeFile(join(setup.root, 'one.json'), JSON.stringify({ compilerOptions: { noEmit: true } }));
  const args = ['--project=one.json', '--pretty', 'false'];
  const { child, stderr } = setup.start([runner, ...args]);
  assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
  assert.deepEqual(JSON.parse((await readFile(join(setup.root, 'executions.jsonl'), 'utf8')).trim()).args, args);
});

for (const env of [{}, measuredEnv]) {
  test(`compiler projects stop after graceful outer cancellation (${env.CI ? 'measured' : 'unmeasured'})`, async (t) => {
    const setup = await fixture(t, { compilerBody: `
      const fs = require('node:fs');
      if (process.argv.includes('never.json')) { fs.writeFileSync('unexpected-project', 'started'); process.exit(0); }
      process.on('SIGTERM', () => process.exit(0));
      fs.writeFileSync('ready', 'yes');
    ` });
    const { child, stderr } = setup.start([runner, '-p', 'first.json', '-p', 'never.json'], { env });
    await waitUntil(() => readFile(join(setup.root, 'ready')).then(() => true, () => false), () => `fake compiler did not start: ${stderr()}`);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null], stderr());
    assert.equal(await readFile(join(setup.root, 'unexpected-project'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }), null);
  });
}

test('compiler measurement cancellation during filesystem setup never starts a compiler', { skip: process.platform !== 'linux' }, async (t) => {
  const setup = await fixture(t, { pauseMeasurementSetup: true, exitCode: 0 });
  const { child, stderr } = setup.start([runner, '-p', 'first.json', '-p', 'never.json'], { env: measuredEnv, stdio: ['pipe', 'ignore', 'pipe'] });
  await waitUntil(() => readFile(join(setup.root, 'measurement-setup-ready')).then(() => true, () => false), () => `measurement setup did not start: ${stderr()}`);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null], stderr());
  assert.equal(await readFile(setup.pidFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }), null);
  assert.deepEqual(measurements(stderr()), []);
});

test('compiler measurement reports distinct per-project peaks after a diagnostic failure', { skip: process.platform !== 'linux' }, async (t) => {
  const setup = await fixture(t, { compilerBody: recordingCompiler.replace('process.exit(config.fixtureStatus ?? 0);',
    'setTimeout(() => process.exit(config.fixtureStatus ?? 0), 150);') });
  await writeFile(join(setup.root, 'small.json'), JSON.stringify({ compilerOptions: { noEmit: false }, fixtureMemoryMiB: 1, fixtureStatus: 7 }));
  await writeFile(join(setup.root, 'large.json'), JSON.stringify({ compilerOptions: { noEmit: true }, fixtureMemoryMiB: 64 }));
  const { child, stderr } = setup.start([runner, '--project', 'small.json', '--project', 'large.json'], { env: measuredEnv });
  assert.deepEqual(await once(child, 'exit'), [7, null], stderr());
  const reports = measurements(stderr());
  assert.deepEqual(reports.map(({ project, metric, status, signal }) => ({ project, metric, status, signal })), [
    { project: 'small.json', metric: 'wait4-child-max-rss', status: 7, signal: null },
    { project: 'large.json', metric: 'wait4-child-max-rss', status: 0, signal: null },
  ]);
  assert.ok(reports[0].maxRssKiB > 0);
  assert.ok(reports[1].maxRssKiB > reports[0].maxRssKiB, 'separate child peaks must reflect materially different resident allocations');
  assert.ok(reports.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs > 0),
    'each native compiler measurement must report its elapsed duration beside its resident peak');
  assert.ok(reports.every(({ aggregateMaxRssKiB, ancestorMaxRssKiB, maxRssKiB }) =>
    aggregateMaxRssKiB > maxRssKiB && ancestorMaxRssKiB > 0),
  'the memory witness must include the admitted ancestor processes as well as the native compiler');
  t.diagnostic(JSON.stringify(reports));
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`compiler measurement preserves native ${signal} and stops subsequent projects`, { skip: process.platform !== 'linux' }, async (t) => {
    const setup = await fixture(t, { compilerBody: `require('node:fs').appendFileSync('executions.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');` });
    const { child, stderr } = setup.start([runner, '-p', 'first.json', '-p', 'never.json'], { env: measuredEnv });
    await waitUntil(() => readFile(join(setup.root, 'executions.jsonl')).then(() => true, () => false), () => `fake compiler did not start: ${stderr()}`);
    const pid = Number(await readFile(setup.pidFile, 'utf8'));
    const exited = once(child, 'exit');
    process.kill(pid, signal);
    assert.deepEqual(await exited, [null, signal], stderr());
    assert.equal((await readFile(join(setup.root, 'executions.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.deepEqual(measurements(stderr()).map(({ status, signal: nativeSignal }) => ({ status, signal: nativeSignal })), [{ status: null, signal }]);
  });
}

test('compiler measurement preserves numeric 143 without turning it into SIGTERM', { skip: process.platform !== 'linux' }, async (t) => {
  const setup = await fixture(t, { exitCode: 143 });
  const { child, stderr } = setup.start([runner], { env: measuredEnv });
  assert.deepEqual(await once(child, 'exit'), [143, null], stderr());
  assert.deepEqual(measurements(stderr()).map(({ status, signal }) => ({ status, signal })), [{ status: 143, signal: null }]);
});

for (const delayed of [false, true]) {
  test(`compiler measurement retains custody through ${delayed ? 'delayed' : 'graceful'} TERM completion`, { skip: process.platform !== 'linux' }, async (t) => {
    const setup = await fixture(t, { compilerBody: `
      const fs = require('node:fs');
      process.on('SIGTERM', () => { fs.writeFileSync('term-received', 'yes'); ${delayed ? '' : "fs.writeFileSync('completed', 'yes'); process.exit(0);"} });
      ${delayed ? "process.on('SIGUSR1', () => { fs.writeFileSync('completed', 'yes'); process.exit(0); });" : ''}
      fs.writeFileSync('ready', 'yes');
    ` });
    const { child, stderr } = setup.start([runner], { env: measuredEnv });
    await waitUntil(() => readFile(join(setup.root, 'ready')).then(() => true, () => false), () => `fake compiler did not start: ${stderr()}`);
    const pid = Number(await readFile(setup.pidFile, 'utf8'));
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    if (delayed) {
      await waitUntil(() => readFile(join(setup.root, 'term-received')).then(() => true, () => false), 'TERM did not reach native leaf');
      assert.ok(alive(child.pid) && alive(pid), 'custody must remain until native completion');
      assert.equal(measurements(stderr()).length, 0, 'no premature terminal measurement');
      process.kill(pid, 'SIGUSR1');
    }
    assert.deepEqual(await exited, [0, null], stderr());
    assert.equal(await readFile(join(setup.root, 'completed'), 'utf8'), 'yes');
    assert.deepEqual(measurements(stderr()).map(({ status, signal }) => ({ status, signal })), [{ status: 0, signal: null }]);
  });
}

test('compiler measurement preserves inherited binary streams, cwd and environment', { skip: process.platform !== 'linux' }, async (t) => {
  const setup = await fixture(t, { compilerBody: `
    process.stderr.write('leaf-environment=' + process.env.FIXTURE_VALUE + ';cwd=' + process.cwd() + '\\n');
    process.stdin.pipe(process.stdout);
    process.stdin.on('end', () => process.exit(0));
  ` });
  const { child, stderr, stdout } = setup.start([runner], { env: { ...measuredEnv, FIXTURE_VALUE: 'inherited' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const input = Buffer.from([0, 255, 10, 65]);
  child.stdin.end(input);
  assert.deepEqual(await exited, [0, null], stderr());
  assert.deepEqual(stdout(), input);
  assert.ok(stderr().includes(`leaf-environment=inherited;cwd=${setup.root}\n`));
  assert.equal(measurements(stderr()).length, 1);
});

test('compiler measurement stops at native spawn error without starting another project', { skip: process.platform !== 'linux' }, async (t) => {
  const setup = await fixture(t, { spawnError: true, exitCode: 0 });
  const { child, stderr } = setup.start([runner, '-p', 'missing.json', '-p', 'never.json'], { env: measuredEnv });
  assert.deepEqual(await once(child, 'exit'), [1, null], stderr());
  assert.match(stderr(), /ENOENT/);
  assert.equal(await readFile(setup.pidFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }), null);
});

test('compiler measurement parent loss reaps a TERM-ignoring native descendant tree', { skip: process.platform !== 'linux' }, async (t) => {
  const setup = await fixture(t, { compilerBody: `
    const fs = require('node:fs');
    require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('worker.pid', String(process.pid)); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
    process.on('SIGTERM', () => fs.writeFileSync('term-received', 'yes'));
  ` });
  const { child, stderr } = setup.start([runner], { env: measuredEnv });
  await waitUntil(() => readFile(setup.workerPidFile).then(() => true, () => false), () => `fake worker did not start: ${stderr()}`);
  const pid = Number(await readFile(setup.pidFile, 'utf8'));
  const workerPid = Number(await readFile(setup.workerPidFile, 'utf8'));
  const nativeStatus = await readFile(`/proc/${pid}/status`, 'utf8');
  const adapterPid = Number(nativeStatus.match(/^PPid:\s+(\d+)$/m)?.[1]);
  const adapterStatus = await readFile(`/proc/${adapterPid}/status`, 'utf8');
  const custodyPid = Number(adapterStatus.match(/^PPid:\s+(\d+)$/m)?.[1]);
  const pids = [pid, workerPid, adapterPid, custodyPid];
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await waitUntil(() => readFile(join(setup.root, 'term-received')).then(() => true, () => false), 'TERM did not reach ignoring native leaf');
  assert.ok(pids.every(alive), 'ignoring leaf must remain under live adapter and custody');
  child.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL'], stderr());
  await waitUntil(async () => (await Promise.all(pids.map(async (ownedPid) => {
    const status = await readFile(`/proc/${ownedPid}/status`, 'utf8').catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return '';
      throw error;
    });
    return !status || /^State:\s+Z\b/m.test(status);
  }))).every(Boolean), 'native tree, adapter or custodian survived parent loss');
});

for (const { name, platform, env } of [
  { name: 'Windows', platform: 'win32', env: measuredEnv },
  { name: 'macOS', platform: 'darwin', env: measuredEnv },
  { name: 'local Linux', platform: null, env: { ...measuredEnv, CI: 'false' } },
  { name: 'unrequested CI', platform: null, env: { CI: 'true', HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS: '0' } },
]) {
  test(`compiler measurement leaves ${name} compilation unmeasured`, async (t) => {
    const setup = await fixture(t, { platform, exitCode: 0 });
    const { child, stderr } = setup.start([runner], { env });
    assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
    assert.ok(Number(await readFile(setup.pidFile, 'utf8')) > 0);
    assert.deepEqual(measurements(stderr()), []);
  });
}

test('supervisor group SIGKILL stops the compiler runner and its native worker', { skip: process.platform === 'win32' }, async (t) => {
  const setup = await fixture(t, { tree: true });
  const { child, stderr } = setup.start([runner], { detached: true });
  await waitUntil(() => readFile(setup.workerPidFile).then(() => true, () => false), `worker did not start: ${stderr()}`);
  const pids = [Number(await readFile(setup.pidFile, 'utf8')), Number(await readFile(setup.workerPidFile, 'utf8'))];
  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  await waitUntil(() => pids.every((pid) => {
    if (!alive(pid)) return true;
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    return !alive(pid) || (result.status === 0 && result.stdout.trim().startsWith('Z'));
  }), 'compiler or native worker survived supervisor group SIGKILL');
});

for (const [label, entry, signal] of [['compiler', runner, 'SIGTERM'], ['compiler', runner, 'SIGINT'], ['compiler', runner, 'SIGHUP'], ['server', serverRunner, 'SIGTERM'], ['bootstrap', bootstrapRunner, 'SIGTERM'], ['CLI build', cliBuildRunner, 'SIGTERM'], ['heartbeat', heartbeatRunner, 'SIGHUP']]) {
  test(`${label} runner forwards ${signal} and reaps its compiler`, { skip: process.platform === 'win32' }, async (t) => {
    const setup = await fixture(t);
    const entryArgs = entry === cliBuildRunner
      ? ['--input-type=module', '-e', `import { buildCliDist } from ${JSON.stringify(new URL('../../apps/cli/scripts/build.mjs', import.meta.url).href)}; import { exitWithCommandResult } from ${JSON.stringify(procModule)}; await buildCliDist({ packageRoot: process.cwd(), repoRoot: process.cwd(), skipLock: true }).catch(error => { console.error(error); exitWithCommandResult({ status: 1, signal: error.signal }); });`]
      : entry === heartbeatRunner
        ? (() => { const invocation = resolveTypeScriptCliInvocation({}); return [entry, '--', invocation.command, ...invocation.argsPrefix]; })()
        : [entry];
    // This case owns cancellation of the strict build's semantic compiler;
    // AUTO's source-test preparation may otherwise select runtime-only output.
    const { child, stderr } = setup.start(entryArgs, entry === cliBuildRunner
      ? { env: { [WORKSPACE_BUILD_MODE_ENV]: 'strict' } } : {});
    await waitUntil(() => readFile(setup.pidFile).then(() => true, () => false), () => `compiler did not start: ${stderr()}`);
    const pid = Number(await readFile(setup.pidFile, 'utf8'));
    const exited = once(child, 'exit');
    child.kill(signal);
    await waitUntil(() => !alive(pid), `compiler ${pid} survived ${signal} of runner`);
    assert.deepEqual(await exited, [null, signal]);
  });
}

for (const helper of ['run', 'runCapture', 'runCaptureResult']) {
  test(`${helper} owns child cancellation without a timeout`, { skip: process.platform === 'win32' }, async (t) => {
    const setup = await fixture(t);
    const invocation = resolveTypeScriptCliInvocation({});
    const code = `import { ${helper} } from ${JSON.stringify(procModule)}; await ${helper}(${JSON.stringify(invocation.command)}, ${JSON.stringify(invocation.argsPrefix)});`;
    const { child, stderr } = setup.start(['--input-type=module', '-e', code]);
    await waitUntil(() => readFile(setup.pidFile).then(() => true, () => false), `child did not start: ${stderr()}`);
    const pid = Number(await readFile(setup.pidFile, 'utf8'));
    child.kill('SIGTERM');
    await waitUntil(() => !alive(pid), `${helper} child ${pid} survived wrapper cancellation`);
  });
}
