import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { resolveYarnCommandInvocation } from './execYarnCommand.mjs';

const runner = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
const serverRunner = fileURLToPath(new URL('../../apps/server/scripts/runTypeScriptCli.mjs', import.meta.url));
const bootstrapRunner = fileURLToPath(new URL('../../apps/bootstrap/scripts/runTsc.mjs', import.meta.url));
const buildRunner = fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url));
const cliBuildRunner = fileURLToPath(new URL('../../apps/cli/scripts/build.mjs', import.meta.url));
const heartbeatRunner = fileURLToPath(new URL('../runWithHeartbeat.mjs', import.meta.url));
const procModule = new URL('../../apps/stack/scripts/utils/proc/proc.mjs', import.meta.url).href;
const rootTypecheckModule = new URL('../testing/runTypecheck.ts', import.meta.url).href;

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

async function fixture(t, { tree = false, route = false, windows = false, withoutWorkspaceDist = false, exitCode = null } = {}) {
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
  // The compiler process is the OS boundary. Keep the runner and selection owner real.
  await writeFile(preload, `
    ${windows ? "Object.defineProperty(process, 'platform', { value: 'win32' });" : ''}
    ${withoutWorkspaceDist ? `require('node:module').registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@happier-dev/cli-common/process') throw new Error('workspace dist has not been compiled yet');
      return nextResolve(specifier, context);
    }});` : ''}
    const cp = require('node:child_process');
    for (const name of ['spawn', 'spawnSync']) {
      const original = cp[name];
      cp[name] = function(command, args, options) {
        ${windows ? `if (args.join(' ').includes('hstack-exec')) {
          return original(process.execPath, ['-e', 'process.exit(7)'], options);
        }` : ''}
        ${route ? `if (command === ${JSON.stringify(fileURLToPath(new URL('../../apps/stack/bin/hstack-exec', import.meta.url)))}) {
          command = process.execPath;
          args = [${JSON.stringify(fakeCompiler)}];
        }` : ''}
        if (command === process.execPath && args[0] === ${JSON.stringify(invocation.argsPrefix[0])}) {
          args = [${JSON.stringify(fakeCompiler)}, ...args.slice(1)];
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
      const env = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, COMPILER_PID_FILE: pidFile };
      if (route || windows) {
        delete env.HAPPIER_HSTACK_EXECUTION;
        delete env.HAPPIER_DEV_TARGET_EXECUTION;
      }
      child = spawn(process.execPath, args, {
        ...options,
        stdio: ['ignore', 'ignore', 'pipe'],
        cwd: root,
        env,
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      return { child, stderr: () => stderr };
    },
  };
}

test('Windows compiler noEmit uses the local native compiler instead of the POSIX router', async (t) => {
  const setup = await fixture(t, { windows: true, exitCode: 0 });
  const { child, stderr } = setup.start([runner, '--noEmit']);
  assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
  assert.ok(Number(await readFile(setup.pidFile, 'utf8')) > 0);
});

for (const windows of [false, true]) {
  test(`compiler can bootstrap workspace dist (${windows ? 'Windows' : 'POSIX'} boundary)`, async (t) => {
    const setup = await fixture(t, { windows, withoutWorkspaceDist: true, exitCode: 0 });
    const { child, stderr } = setup.start([runner]);
    assert.deepEqual(await once(child, 'exit'), [0, null], stderr());
  });
}

test('package build cancellation reaps the compiler, preserves dist, and exits with its signal', { skip: process.platform === 'win32' }, async (t) => {
  const setup = await fixture(t);
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
        ? [entry, '--', process.execPath, ...resolveTypeScriptCliInvocation({}).argsPrefix]
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
