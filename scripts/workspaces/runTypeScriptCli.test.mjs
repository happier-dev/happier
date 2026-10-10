import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { resolveYarnCommandInvocation } from './execYarnCommand.mjs';
import { installNativeAdmissionFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

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
        ${windows ? `if (args.join(' ').includes('hstack-exec')) {
          return original(process.execPath, ['-e', 'process.exit(7)'], options);
        }` : ''}
        ${route ? `if (command === ${JSON.stringify(fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url)))} && args[0] !== '--heavyweight-admission') {
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
    pidFile,
    workerPidFile,
    root,
    fakeCompiler,
    start(args, options = {}) {
      const { command = process.execPath, ...childOptions } = options;
      const env = { ...process.env,
        // This OS-boundary fixture is an independent admitted machine, not
        // the AUTO test runner's worker cache or parent reservation.
        HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
        HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
        HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
        ...options.env, PATH: `${join(root, 'bin')}:${options.env?.PATH ?? process.env.PATH}`,
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, COMPILER_PID_FILE: pidFile };
      if (route || windows) {
        delete env.HAPPIER_HSTACK_EXECUTION;
        delete env.HAPPIER_DEV_TARGET_EXECUTION;
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

test('Windows compiler noEmit uses the local native compiler instead of the POSIX router', async (t) => {
  const setup = await fixture(t, { windows: true, exitCode: 0 });
  const { child, stderr } = setup.start([runner, '--noEmit']);
  assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
  assert.ok(Number(await readFile(setup.pidFile, 'utf8')) > 0);
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
    assert.match(stderr(), /run `yarn typecheck` \(routed\) instead of `typecheck:(?:source:)?finite`/);
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

test('actual CLI and Plugin SDK direct finite Yarn entries refuse before compilation', () => {
  for (const [workspace, task] of [['apps/cli', 'typecheck:source:finite'], ['packages/plugin-sdk', 'typecheck:finite']]) {
    const yarn = resolveYarnCommandInvocation(['--cwd', fileURLToPath(new URL(`../../${workspace}/`, import.meta.url)), '-s', task]);
    const result = spawnSync(yarn.command, yarn.args, {
      encoding: 'utf8',
      env: { ...process.env, HAPPIER_TYPECHECK_DISPATCHED: '', TURBO_TASK_ID: '' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`run \`yarn typecheck\` (routed) instead of \`${task}\``), result.stderr);
  }
});

for (const explicitLocal of [false, true]) {
  test(`public Yarn typecheck reaches its finite compiler (${explicitLocal ? '--local' : 'already routed'})`, { skip: process.platform === 'win32' }, async (t) => {
    const setup = await fixture(t, { exitCode: 0 });
    const launcher = fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url));
    const cliPackage = JSON.parse(await readFile(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'));
    const binDir = join(setup.root, 'bin');
    await mkdir(binDir, { recursive: true });
    // The compiler is substituted; avoid admitting its tiny OS-boundary fixture
    // as a full compilation on a worker below the real compiler memory floor.
    await writeFile(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
    await chmod(join(binDir, 'uname'), 0o755);
    await writeFile(join(setup.root, 'package.json'), JSON.stringify({
      name: 'finite-dispatch-fixture',
      packageManager: 'yarn@1.22.22',
      scripts: {
        typecheck: cliPackage.scripts.typecheck.replace('../stack/bin/hstack-exec', `${JSON.stringify(launcher)}${explicitLocal ? ' --local' : ''}`),
        'typecheck:local': cliPackage.scripts['typecheck:local'],
        'typecheck:source:finite': cliPackage.scripts['typecheck:source:finite'].replace('../../scripts/workspaces/runTypeScriptCli.mjs', JSON.stringify(runner)),
      },
    }));
    const yarn = resolveYarnCommandInvocation(['-s', 'typecheck']);
    const { child, stderr } = setup.start(yarn.args, { command: yarn.command, env: {
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
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await waitUntil(() => !alive(pid), `package build compiler ${pid} survived cancellation`);
  assert.deepEqual(await exited, [null, 'SIGTERM']);
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
  test(`root Yarn suite distinguishes SIGTERM of ${target} from an aggregate failure`, { skip: process.platform === 'win32' }, async (t) => {
    const setup = await fixture(t, { tree: target === 'outer heartbeat' });
    const sentinelFile = join(setup.root, 'sentinel');
    const suiteStartedFile = join(setup.root, 'suite-started.json');
    const suiteScript = join(setup.root, 'suite.mjs');
    await writeFile(suiteScript, `
      import { writeFile } from 'node:fs/promises';
      import { runRootTypecheck } from ${JSON.stringify(rootTypecheckModule)};
      await writeFile(${JSON.stringify(suiteStartedFile)}, JSON.stringify({ yarn: process.env.npm_config_user_agent }));
      try {
        await runRootTypecheck({ commands: [
          { id: 'compiler-leaf', args: ['-s', 'compiler'] },
          { id: 'subsequent-sentinel', args: ['-s', 'sentinel'] },
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
      packageManager: 'yarn@1.22.22',
      scripts: {
        'root-suite': `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(suiteScript)}`,
        compiler: nodeScript(runner),
        sentinel: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(sentinelScript)}`,
      },
    }));
    const yarn = resolveYarnCommandInvocation(['-s', 'root-suite']);
    const { child, stderr } = setup.start([heartbeatRunner, '--', yarn.command, ...yarn.args]);
    // The marker belongs only to the substituted compiler, before any signal is sent.
    await waitUntil(() => readFile(setup.pidFile).then(() => true, () => false), () => `fake compiler did not start: ${stderr()}`);
    assert.match(JSON.parse(await readFile(suiteStartedFile, 'utf8')).yarn, /^yarn\/1\.22\.22\b/);
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
      assert.deepEqual(await exited, [1, null], stderr());
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
  const setup = await fixture(t, { compilerBody: recordingCompiler });
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
    const { child, stderr } = setup.start(entryArgs);
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
