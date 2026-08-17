import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  inspectDevTargetSync,
  runDevTargetDependencyBootstrap,
  runDevTargetCommand,
  syncDevTarget,
} from './executor.mjs';

const target = {
  name: 'linux',
  platform: 'posix',
  ssh: 'linux-ssh',
  repoDir: '/home/dev/happier',
  cliHomeDir: '/home/dev/.happier/linux',
};

function readyListResult() {
  return {
    ok: true,
    exitCode: 0,
    out: JSON.stringify([{
      name: 'happier-linux', paused: false, status: 'watching', successfulCycles: 3,
    }]),
    err: '',
  };
}

test('dependency bootstrap delegates to the cancellable remote command owner', async () => {
  const calls = [];
  const result = await runDevTargetDependencyBootstrap({
    target,
    stackBaseDir: '/tmp/stack',
    syncAlreadyVerified: true,
    env: { TEST_ENV: 'project' },
  }, {
    runCommand: async (options) => {
      calls.push(options);
      return { code: 0, signal: null };
    },
  });

  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(calls, [{
    target,
    stackBaseDir: '/tmp/stack',
    commandArgs: [
      'corepack',
      'yarn',
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: '/home/dev/.happier/linux/cache',
    },
    dependencyAdmission: 'skip',
    syncAlreadyVerified: true,
    env: { TEST_ENV: 'project' },
  }]);
});

test('dependency-consuming commands bootstrap a synchronized target before dispatch while raw searches stay bootstrap-free', async () => {
  const calls = [];
  const dependencies = {
    runCaptureResult: async () => readyListResult(),
    runDependencyBootstrap: async (options) => {
      calls.push({ kind: 'bootstrap', options });
      return { code: 0, signal: null };
    },
    spawnProcess: ({ args }) => {
      calls.push({ kind: 'command', args });
      return { completion: Promise.resolve({ code: 0, signal: null }) };
    },
  };

  await runDevTargetCommand({
    target,
    stackBaseDir: '/tmp/stack',
    commandArgs: ['corepack', 'yarn', '-s', 'typecheck'],
    env: {},
  }, dependencies);

  assert.equal(calls[0].kind, 'bootstrap');
  assert.deepEqual(calls[0].options, {
    target,
    stackBaseDir: '/tmp/stack',
    syncAlreadyVerified: true,
    env: {},
  });
  assert.equal(calls[1].kind, 'command');

  calls.length = 0;
  await runDevTargetCommand({
    target,
    stackBaseDir: '/tmp/stack',
    commandArgs: ['rg', '-n', 'needle'],
    env: {},
  }, dependencies);

  assert.deepEqual(calls.map((call) => call.kind), ['command']);
});

test('remote exec checks sync health but launches without an implicit flush', async () => {
  const calls = [];
  const result = await runDevTargetCommand(
    {
      target,
      stackBaseDir: '/tmp/stack',
      commandArgs: ['rg', '-n', 'needle'],
      env: { PATH: '/test/bin' },
    },
    {
      runCaptureResult: async ({ command, args }) => {
        calls.push([command, ...args]);
        return readyListResult();
      },
      spawnProcess: ({ command, args }) => {
        calls.push([command, ...args]);
        return { completion: Promise.resolve({ code: 0, signal: null }) };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(calls.filter((call) => call.includes('flush')).length, 0);
  const sshCall = calls.find((call) => call[0] === 'ssh');
  assert.ok(sshCall);
  assert.ok(sshCall.includes('BatchMode=yes'));
  assert.ok(sshCall.includes('ConnectTimeout=10'));
});

test('remote exec flushes only when explicitly requested and before SSH launch', async () => {
  const calls = [];
  await runDevTargetCommand(
    {
      target,
      stackBaseDir: '/tmp/stack',
      commandArgs: ['yarn', 'typecheck'],
      flush: true,
      env: {},
    },
    {
      runCaptureResult: async ({ command, args }) => {
        calls.push([command, ...args]);
        if (args.includes('list')) return readyListResult();
        return { ok: true, exitCode: 0, out: '', err: '' };
      },
      spawnProcess: ({ command, args }) => {
        calls.push([command, ...args]);
        return { completion: Promise.resolve({ code: 0, signal: null }) };
      },
      runDependencyBootstrap: async () => ({ code: 0, signal: null }),
    },
  );

  assert.deepEqual(calls.map((call) => call[0]), ['mutagen', 'mutagen', 'ssh']);
  assert.ok(calls[1].includes('flush'));
});

test('independent remote commands launch concurrently without an executor queue', async () => {
  const releases = [];
  let launches = 0;
  const deps = {
    runCaptureResult: async () => readyListResult(),
    spawnProcess: () => {
      launches += 1;
      let release;
      const completion = new Promise((resolve) => {
        release = () => resolve({ code: 0, signal: null });
      });
      releases.push(release);
      return { completion };
    },
  };

  const first = runDevTargetCommand({
    target, stackBaseDir: '/tmp/stack', commandArgs: ['test-a'], env: {},
  }, deps);
  const second = runDevTargetCommand({
    target, stackBaseDir: '/tmp/stack', commandArgs: ['test-b'], env: {},
  }, deps);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches, 2, 'the second command must launch while the first command is still running');
  releases.forEach((release) => release());
  await Promise.all([first, second]);
});

test('sync status and explicit sync use the target session in the stack Mutagen daemon', async () => {
  const calls = [];
  const deps = {
    runCaptureResult: async ({ command, args, env }) => {
      calls.push({ command, args, env });
      if (args.includes('list')) return readyListResult();
      return { ok: true, exitCode: 0, out: '', err: '' };
    },
  };
  const inspected = await inspectDevTargetSync({
    target, stackBaseDir: '/tmp/stack', env: { PATH: '/test/bin' },
  }, deps);
  assert.equal(inspected.state, 'ready');

  const synced = await syncDevTarget({
    target, stackBaseDir: '/tmp/stack', env: { PATH: '/test/bin' },
  }, deps);
  assert.equal(synced.state, 'ready');
  assert.ok(calls.some((call) => call.args.includes('flush')));
  assert.ok(calls.every((call) => call.env.MUTAGEN_DATA_DIRECTORY === '/tmp/stack/mutagen/data'));
});

test('sync inspection accepts a bounded timeout for automatic health probes', async () => {
  let receivedTimeoutMs = null;
  const result = await inspectDevTargetSync({
    target,
    stackBaseDir: '/tmp/stack',
    env: {},
    timeoutMs: 5_000,
  }, {
    runCaptureResult: async ({ timeoutMs }) => {
      receivedTimeoutMs = timeoutMs;
      return readyListResult();
    },
  });
  assert.equal(result.state, 'ready');
  assert.equal(receivedTimeoutMs, 5_000);
});

test('explicit sync applies its bounded timeout to both status and flush operations', async () => {
  const timeouts = [];
  await syncDevTarget({
    target,
    stackBaseDir: '/tmp/stack',
    env: {},
    timeoutMs: 120_000,
  }, {
    runCaptureResult: async ({ args, timeoutMs }) => {
      timeouts.push({ operation: args[1], timeoutMs });
      return args.includes('list')
        ? readyListResult()
        : { ok: true, exitCode: 0, out: '', err: '' };
    },
  });
  assert.deepEqual(timeouts, [
    { operation: 'list', timeoutMs: 120_000 },
    { operation: 'flush', timeoutMs: 120_000 },
  ]);
});

test('explicit sync waits through an active first synchronization while ordinary exec stays closed', async () => {
  const calls = [];
  const synchronizingResult = {
    ok: true,
    exitCode: 0,
    out: JSON.stringify([{
      name: 'happier-linux', paused: false, status: 'scanning', successfulCycles: 0,
    }]),
    err: '',
  };
  const deps = {
    runCaptureResult: async ({ args }) => {
      calls.push(args);
      return args.includes('list')
        ? synchronizingResult
        : { ok: true, exitCode: 0, out: '', err: '' };
    },
  };

  await syncDevTarget({ target, stackBaseDir: '/tmp/stack', env: {} }, deps);
  assert.equal(calls.some((args) => args.includes('flush')), true);
  await assert.rejects(
    () => runDevTargetCommand(
      { target, stackBaseDir: '/tmp/stack', commandArgs: ['pwd'], env: {} },
      { ...deps, spawnProcess: () => { throw new Error('must not launch'); } },
    ),
    /synchronizing/i,
  );
});

test('remote exec refuses paused, unhealthy, and missing synchronization sessions', async () => {
  for (const [state, session] of [
    ['paused', { name: 'happier-linux', paused: true, status: 0 }],
    ['unhealthy', { name: 'happier-linux', paused: false, status: 5, lastError: 'broken' }],
    ['missing', null],
  ]) {
    await assert.rejects(
      () => runDevTargetCommand(
        { target, stackBaseDir: '/tmp/stack', commandArgs: ['pwd'], env: {} },
        {
          runCaptureResult: async () => ({
            ok: true, exitCode: 0, out: JSON.stringify(session ? [session] : []), err: '',
          }),
          spawnProcess: () => {
            throw new Error('SSH must not launch');
          },
        },
      ),
      new RegExp(state, 'i'),
    );
  }

  await assert.rejects(
    () => runDevTargetCommand(
      { target, stackBaseDir: '/tmp/stack', commandArgs: ['pwd'], env: {} },
      {
        runCaptureResult: async () => ({
          ok: false, exitCode: 1, out: '', err: 'daemon unavailable',
        }),
      },
    ),
    /unavailable: daemon unavailable/i,
  );
});

test('remote exec cancels the exact remote process tree before stopping SSH and removes signal listeners', async () => {
  const signalSource = new EventEmitter();
  let releaseCompletion;
  let stopped = null;
  const calls = [];
  const child = {
    completion: new Promise((resolve) => {
      releaseCompletion = resolve;
    }),
  };
  const execution = runDevTargetCommand(
    { target, stackBaseDir: '/tmp/stack', commandArgs: ['long-test'], env: {} },
    {
      runCaptureResult: async ({ command, args }) => {
        calls.push([command, ...args]);
        if (command === 'mutagen') return readyListResult();
        return { ok: true, exitCode: 0, out: '', err: '' };
      },
      spawnProcess: () => child,
      signalSource,
      createExecutionId: () => '018f0f52-5fe8-7a9f-8ef5-f81f20572791',
      stopProcess: async (ownedChild, signal) => {
        calls.push(['stop-local-ssh']);
        stopped = { ownedChild, signal };
        releaseCompletion({ code: null, signal });
      },
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  signalSource.emit('SIGINT');
  assert.equal(signalSource.listenerCount('SIGINT'), 1, 'repeated interrupts stay owned during cleanup');
  signalSource.emit('SIGINT');
  const result = await execution;
  assert.deepEqual(stopped, { ownedChild: child, signal: 'SIGINT' });
  assert.deepEqual(calls.map((call) => call[0]), ['mutagen', 'ssh', 'stop-local-ssh']);
  assert.match(calls[1].at(-1), /018f0f52-5fe8-7a9f-8ef5-f81f20572791/);
  assert.equal(result.signal, 'SIGINT');
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});

test('remote cancellation failure still stops local SSH and reports unconfirmed cleanup', async () => {
  const signalSource = new EventEmitter();
  let releaseCompletion;
  let stopped = false;
  const child = {
    completion: new Promise((resolve) => {
      releaseCompletion = resolve;
    }),
  };
  const execution = runDevTargetCommand(
    { target, stackBaseDir: '/tmp/stack', commandArgs: ['long-test'], env: {} },
    {
      runCaptureResult: async ({ command }) => (
        command === 'mutagen'
          ? readyListResult()
          : { ok: false, exitCode: 255, out: '', err: 'connection lost' }
      ),
      spawnProcess: () => child,
      signalSource,
      createExecutionId: () => '018f0f52-5fe8-7a9f-8ef5-f81f20572791',
      stopProcess: async (_ownedChild, signal) => {
        stopped = true;
        releaseCompletion({ code: null, signal });
      },
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  signalSource.emit('SIGTERM');
  await assert.rejects(execution, /remote cancellation was not confirmed: connection lost/i);
  assert.equal(stopped, true);
});

test('remote exec passes explicit TTY ownership to the process launcher', async () => {
  let launchedWithTty = null;
  await runDevTargetCommand(
    { target, stackBaseDir: '/tmp/stack', commandArgs: ['interactive'], tty: true, env: {} },
    {
      runCaptureResult: async () => readyListResult(),
      spawnProcess: ({ tty }) => {
        launchedWithTty = tty;
        return { completion: Promise.resolve({ code: 0, signal: null }) };
      },
    },
  );
  assert.equal(launchedWithTty, true);
});
