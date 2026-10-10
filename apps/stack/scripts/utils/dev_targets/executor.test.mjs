import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';

import {
  inspectDevTargetSync,
  runDevTargetDependencyBootstrap,
  runDevTargetWorkspacePreparation,
  runDevTargetCommand as runDevTargetCommandImpl,
  syncDevTarget,
} from './executor.mjs';

const emptySourceDir = mkdtempSync(join(tmpdir(), 'happier-explicit-executor-tests-'));
writeFileSync(join(emptySourceDir, 'package.json'), JSON.stringify({ workspaces: [] }));
test.after(() => rmSync(emptySourceDir, { recursive: true, force: true }));

function runDevTargetCommand(options, dependencies) {
  return runDevTargetCommandImpl({ sourceDir: emptySourceDir, ...options }, dependencies);
}

const target = {
  name: 'linux',
  platform: 'posix',
  ssh: 'linux-ssh',
  repoDir: '/home/dev/happier',
  cliHomeDir: '/home/dev/.happier/linux',
};

test('remote preparation retries refused multiplex admission but never an ambiguous command disconnect', async () => {
  for (const refused of [true, false]) {
    const calls = [];
    const result = await runDevTargetCommand({ target, stackBaseDir: '/tmp/stack', syncAlreadyVerified: true,
      commandArgs: ['node', './apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs'], provenance: 'skip' }, {
      spawnProcess: input => {
        calls.push(input);
        if (calls.length === 1) {
          input.onLine?.({ stream: 'stderr', line: refused
            ? 'mux_client_request_session: session request failed: Session open refused by peer' : 'Connection closed by remote host' });
        }
        return { completion: Promise.resolve({ code: calls.length === 1 ? 255 : 0, signal: null }) };
      },
    });
    assert.equal(result.code, refused ? 0 : 255);
    assert.equal(calls.length, refused ? 2 : 1);
    if (refused) {
      assert.ok(calls[1].args.includes('ControlPath=none'));
      assert.equal(calls[1].args.at(-1), calls[0].args.at(-1), 'recovery retains the original command custody');
    }
  }
});

test('dependency bootstrap preserves streamed ownership refusal across process completion', async () => {
  for (const scenario of [{ code: 1, stream: 'stderr', refused: true }, { code: 0, stream: 'stderr', refused: false }, { code: 1, stream: 'stdout', refused: false }]) {
    const result = await runDevTargetDependencyBootstrap({ target, stackBaseDir: '/tmp/stack', syncAlreadyVerified: true }, {
      runCommand: options => runDevTargetCommand(options, {
        spawnProcess: ({ onLine }) => {
          onLine({ stream: scenario.stream, line: 'Error: Expo pid=123 has no verified dependency-safe restart owner. Stop the owning Stack once on this target.' });
          onLine({ stream: scenario.stream, line: "  code: 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED'" });
          return { completion: Promise.resolve({ code: scenario.code, signal: null }) };
        },
      }),
    });
    assert.equal(result.error?.code === 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED', scenario.refused);
    if (scenario.refused) assert.match(result.error.message, /Stop the owning Stack once/);
  }
});

test('try admission reports owner denial only when exit 75 and its stderr sentinel agree', async () => {
  const sentinel = 'HSTACK_ADMISSION_BUSY:admission-test-id';
  for (const scenario of [
    { code: 75, stream: 'stderr', line: sentinel, declined: true },
    { code: 75, stream: 'stderr', line: 'HSTACK_ADMISSION_DISK:admission-test-id', declined: true },
    { code: 75, stream: 'stderr', line: 'HSTACK_ADMISSION_DISK:another-execution-id', declined: false },
    { code: 75, stream: 'stderr', line: 'HSTACK_ADMISSION_BUSY:another-execution-id', declined: false },
    { code: 75, stream: 'stderr', line: '[preferred-execution] heavyweight admission declined before dispatch (memory-available)', declined: false },
    { code: 75, stream: 'stderr', line: 'worker failed', declined: false },
    { code: 75, stream: 'stdout', line: sentinel, declined: false },
    { code: 0, stream: 'stderr', line: sentinel, declined: false },
  ]) {
    const result = await runDevTargetCommand({
      target, stackBaseDir: '/tmp/stack', syncAlreadyVerified: true,
      commandArgs: ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'],
      admissionMode: 'try', provenance: 'skip',
    }, {
      createExecutionId: () => 'admission-test-id',
      spawnProcess: ({ args, onLine }) => {
        assert.ok(args.at(-1).includes('--no-wait'), args.at(-1));
        assert.ok(args.at(-1).includes('--failure-id=admission-test-id'), args.at(-1));
        onLine?.({ stream: scenario.stream, line: scenario.line });
        return { completion: Promise.resolve({ code: scenario.code, signal: null }) };
      },
    });
    assert.equal(result.admissionUnavailable === true, scenario.declined);
    assert.equal(result.code, scenario.code);
  }
});

function readyListResult(sessionName = 'happier-linux') {
  return {
    ok: true,
    exitCode: 0,
    out: JSON.stringify([{
      name: sessionName, paused: false, status: 'watching', successfulCycles: 3,
      alpha: { connected: true, scanned: true },
      beta: { connected: true, scanned: true },
    }]),
    err: '',
  };
}

test('explicit sync rescans scan-only problems through the existing flush before admission', async () => {
  const initial = readyListResult();
  const sessions = JSON.parse(initial.out);
  sessions[0].alpha.scanProblems = [{ path: 'apps/ui/sources/text/translations/es.ts', error: 'hashed size mismatch: 847308 != 28672' }];
  initial.out = JSON.stringify(sessions);
  let flushed = false;
  const result = await syncDevTarget({ target, stackBaseDir: '/tmp/stack', env: {} }, {
    runCaptureResult: async ({ args }) => {
      if (args.includes('flush')) { flushed = true; return { ok: true, exitCode: 0, out: '', err: '' }; }
      return flushed ? readyListResult() : initial;
    },
  });
  assert.equal(flushed, true);
  assert.equal(result.state, 'ready');
});

function transitionProblemListResult() {
  return {
    ok: true,
    exitCode: 0,
    out: JSON.stringify([{
      name: 'happier-linux', paused: false, status: 'watching', successfulCycles: 7,
      alpha: {
        connected: true,
        scanned: true,
        transitionProblems: [{ path: 'src/index.ts', error: 'apply failed' }],
        excludedTransitionProblems: 0,
      },
      beta: { connected: true, scanned: true },
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
  assert.equal(typeof calls[0].onLine, 'function');
  const { onLine, ...invocation } = calls[0];
  assert.deepEqual(invocation, {
    target,
    stackBaseDir: '/tmp/stack',
    commandArgs: [
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
      '--validation-kind=runtime',
      '--component-relative-dir=.',
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: '/home/dev/.happier/linux/cache',
    },
    dependencyAdmission: 'skip',
    provenance: 'skip',
    syncAlreadyVerified: true,
    env: { TEST_ENV: 'project' },
  });
});

test('workspace preparation delegates the component path to the cancellable remote command owner', async () => {
  const calls = [];
  const result = await runDevTargetWorkspacePreparation({
    target,
    stackBaseDir: '/tmp/stack',
    cwd: 'apps/cli',
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
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs',
      '--component-relative-dir=apps/cli',
      '--validation-kind=runtime',
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: '/home/dev/.happier/linux/cache',
    },
    dependencyAdmission: 'skip',
    workspacePreparation: 'skip',
    provenance: 'skip',
    syncAlreadyVerified: true,
    env: { TEST_ENV: 'project' },
  }]);
});

test('explicit remote execution rejects Git commands before sync or SSH', async () => {
  let boundaryCalls = 0;
  await assert.rejects(
    runDevTargetCommand({
      target,
      stackBaseDir: '/tmp/stack',
      commandArgs: ['git', 'status'],
      env: {},
    }, {
      runCaptureResult: async () => {
        boundaryCalls += 1;
        return readyListResult();
      },
      spawnProcess: () => {
        boundaryCalls += 1;
        return { completion: Promise.resolve({ code: 0, signal: null }) };
      },
    }),
    /Git.*authoritative|primary.*Git/i,
  );
  assert.equal(boundaryCalls, 0);
});

test('POSIX dependency-consuming commands prepare inside their SSH operation while source-only commands stay bootstrap-free', async () => {
  const calls = [];
  const dependencies = {
    runCaptureResult: async () => readyListResult(),
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

  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(-1), /remote_dependency_bootstrap\.mjs/);
  assert.doesNotMatch(calls[0].args.at(-1), /remote_validation_preparation\.mjs/, 'root scripts own their preparation');

  calls.length = 0;
  await runDevTargetCommand({
    target,
    stackBaseDir: '/tmp/stack',
    cwd: 'apps/cli',
    commandArgs: ['corepack', 'yarn', '-s', 'vitest', 'run', 'owner.test.ts'],
    env: {},
  }, dependencies);

  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(-1), /remote_dependency_bootstrap\.mjs[\s\S]*remote_validation_preparation\.mjs[\s\S]*--component-relative-dir=apps\/cli/);
  assert.match(calls[0].args.at(-1), /--validation-kind=source-test/);

  for (const commandArgs of [
    ['node', '-e', 'console.log("source-only")'],
    ['nodejs', 'source-script.mjs'],
    ['rg', '-n', 'needle'],
    ['find', '.', '-name', '*.mjs'],
  ]) {
    for (const commandTarget of [target, { ...target, platform: 'windows' }]) {
      calls.length = 0;
      await runDevTargetCommand({
        target: commandTarget,
        stackBaseDir: '/tmp/stack',
        commandArgs,
        env: {},
      }, dependencies);
      assert.deepEqual(calls.map((call) => call.kind), ['command'], commandArgs.join(' '));
    }
  }

  for (const commandArgs of [
    ['node', '--test', 'owner.test.mjs'],
    ['node', '--test', 'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs'],
    ['yarn', '-s', 'custom:script'],
    ['vitest', 'run', 'owner.test.ts'],
    ['tsc', '--noEmit'],
    ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'],
    ['node', 'node_modules/vitest/vitest.mjs', 'run', 'owner.test.ts'],
    ['nodejs', 'node_modules/vitest/vitest.mjs', 'run', 'owner.test.ts'],
  ]) {
    calls.length = 0;
    await runDevTargetCommand({ target, stackBaseDir: '/tmp/stack', commandArgs, env: {} }, dependencies);
    assert.equal(calls.length, 1, commandArgs.join(' '));
    assert.match(calls[0].args.at(-1), /remote_dependency_bootstrap\.mjs/);
  }
});

test('JavaScript dispatch keeps preparation before admission within one cancellable target operation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-executor-whole-operation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // SSH is the system boundary. Preparations must remain inside the final
  // cancellable SSH request; an earlier request is the regression.
  writeFileSync(join(root, 'ssh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'ssh'), 0o755);
  let request = '';
  await runDevTargetCommand({ target, stackBaseDir: root, cwd: 'apps/ui',
    commandArgs: ['vitest', 'run', 'arbitrary.test.ts'],
    env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
  }, {
    runCaptureResult: async () => readyListResult(),
    spawnProcess: ({ args }) => {
      request = args.at(-1);
      return { completion: Promise.resolve({ code: 0, signal: null }) };
    },
  });
  assert.match(request, /remote_dependency_bootstrap\.mjs[\s\S]*remote_validation_preparation\.mjs[\s\S]*--heavyweight-admission[\s\S]*vitest/);
});

test('Windows source-test dispatch preserves its source preparation contract through both existing transports', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-executor-windows-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trace = join(root, 'ssh-requests');
  // Only SSH is replaced. The executor and both preparation helpers are real.
  writeFileSync(join(root, 'ssh'), '#!/bin/sh\nfor arg in "$@"; do last=$arg; done\nprintf "%s\\n" "$last" >> "$TRACE"\n');
  chmodSync(join(root, 'ssh'), 0o755);
  await runDevTargetCommand({
    target: { ...target, platform: 'windows', repoDir: 'C:/repo', cliHomeDir: 'C:/home' },
    stackBaseDir: root, cwd: 'apps/cli', syncAlreadyVerified: true,
    commandArgs: ['vitest', 'run', 'arbitrary.test.ts'],
    env: { ...process.env, TRACE: trace, PATH: `${root}:${process.env.PATH}` },
  });
  const requests = readFileSync(trace, 'utf8').trim().split('\n')
    .map(request => Buffer.from(request.split(' ').at(-1), 'base64').toString('utf16le'));
  assert.equal(requests.length, 3);
  assert.match(requests[0], /remote_dependency_bootstrap\.mjs.*--validation-kind=source-test/);
  assert.match(requests[1], /remote_validation_preparation\.mjs.*--validation-kind=source-test/);
  assert.doesNotMatch(requests.join('\n'), /--heavyweight-admission/);
});

for (const { commandArgs, admissionClass } of [
  { commandArgs: ['corepack', 'yarn', '-s', 'typecheck'], admissionClass: 'compilation' },
  { commandArgs: ['corepack', 'yarn', '--cwd', 'packages/cli-common', '-s', 'build'], admissionClass: 'package-dist' },
  { commandArgs: ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'], admissionClass: 'runtime-build' },
]) {
test(`direct POSIX ${admissionClass} execution enters the target machine admission owner`, async () => {
  let remoteCommand = '';
  await runDevTargetCommand({
    target,
    stackBaseDir: '/tmp/stack',
    commandArgs,
    env: {},
  }, {
    runCaptureResult: async () => readyListResult(),
    runDependencyBootstrap: async () => ({ code: 0, signal: null }),
    spawnProcess: ({ args }) => {
      remoteCommand = args.at(-1);
      return { completion: Promise.resolve({ code: 0, signal: null }) };
    },
    createExecutionId: () => 'exec-12345678',
  });

  assert.match(remoteCommand, /apps\/stack\/bin\/hstack-exec/);
  assert.match(remoteCommand, /--heavyweight-admission/);
  assert.match(remoteCommand, new RegExp('--class=' + admissionClass));
  assert.match(remoteCommand, /--machine=linux/);
});
}

test('remote exec flushes the live replica after health inspection and before SSH launch', async () => {
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
        if (args.includes('list')) return readyListResult();
        return { ok: true, exitCode: 0, out: '', err: '' };
      },
      spawnProcess: ({ command, args }) => {
        calls.push([command, ...args]);
        return { completion: Promise.resolve({ code: 0, signal: null }) };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(calls.filter((call) => call.includes('flush')).length, 1);
  assert.match(calls[0][0], /hstack-dev-target-control$/);
  assert.ok(calls[0].includes('list'));
  const flushIndex = calls.findIndex((call) => call.includes('flush'));
  const sshIndex = calls.findIndex((call) => call[0] === 'ssh');
  assert.ok(flushIndex > 0 && flushIndex < sshIndex);
  assert.match(calls[flushIndex][0], /hstack-dev-target-control$/);
  assert.deepEqual(calls[flushIndex].slice(1, 4), [
    '--sync-flush',
    'happier-linux',
    '--',
  ]);
  const sshCall = calls.find((call) => call[0] === 'ssh');
  assert.ok(sshCall);
  assert.ok(sshCall.includes('BatchMode=yes'));
  assert.ok(sshCall.includes('ConnectTimeout=10'));
});


test('explicit remote execution records one schema-safe admitted/completed provenance pair', async () => {
  const records = [];
  const result = await runDevTargetCommand({
    target,
    stackBaseDir: '/tmp/stack',
    cwd: 'apps/cli',
    commandArgs: ['corepack', 'yarn', '-s', 'typecheck:local', '--token=secret'],
    env: {},
  }, {
    runCaptureResult: async () => readyListResult(),
    runDependencyBootstrap: async () => ({ code: 0, signal: null }),
    runWorkspacePreparation: async () => ({ code: 0, signal: null }),
    spawnProcess: () => ({ completion: Promise.resolve({ code: 2, signal: null }) }),
    createExecutionId: () => 'exec-12345678',
    now: (() => {
      const values = [1_000, 4_500];
      return () => values.shift();
    })(),
    recordExecutionProvenance: async (_stackBaseDir, record) => records.push(record),
  });

  assert.deepEqual(result, { code: 2, signal: null });
  assert.deepEqual(records, [
    {
      phase: 'admitted',
      executionId: 'exec-12345678',
      timestamp: 1_000,
      target: 'linux',
      commandClass: 'targeted-validation',
      syncStatus: 'ready',
      syncSuccessfulCycles: 3,
    },
    {
      phase: 'completed',
      executionId: 'exec-12345678',
      timestamp: 4_500,
      target: 'linux',
      commandClass: 'targeted-validation',
      exitCode: 2,
      signal: null,
      durationMs: 3_500,
    },
  ]);
  assert.equal(JSON.stringify(records).includes('secret'), false);
});

test('a POSIX explicit flush leaves post-flush admission to the native owner', async () => {
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

  assert.match(calls[0][0], /hstack-dev-target-control$/);
  assert.ok(calls[0].includes('list'));
  assert.match(calls[1][0], /hstack-dev-target-control$/);
  assert.ok(calls[1].includes('flush'));
  assert.equal(calls[2][0], 'ssh');
  assert.equal(calls.filter((call) => call.includes('list')).length, 1);
});

test('the Windows adapter inspects fresh post-flush state and blocks a transition problem', async (t) => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
  t.after(() => {
    if (originalPlatformDescriptor) Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  });
  let sshLaunched = false;
  let listCalls = 0;
  await assert.rejects(
    () => runDevTargetCommand(
      { target, stackBaseDir: '/tmp/stack', commandArgs: ['rg', '-n', 'needle'], env: {} },
      {
        runCaptureResult: async ({ args }) => {
          if (args.includes('list')) {
            listCalls += 1;
            return listCalls === 1 ? readyListResult() : transitionProblemListResult();
          }
          return { ok: true, exitCode: 0, out: '', err: '' };
        },
        spawnProcess: () => {
          sshLaunched = true;
          return { completion: Promise.resolve({ code: 0, signal: null }) };
        },
      },
    ),
    /transition|synchronization is unhealthy/i,
  );
  assert.equal(sshLaunched, false, 'no SSH dispatch after a problem-bearing post-flush inspection');
  assert.equal(listCalls, 2, 'the Windows adapter performs the fresh post-flush inspection');
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
  const flushCall = calls.find((call) => call.args.includes('flush'));
  assert.ok(flushCall);
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir: '/tmp/stack', env: { PATH: '/test/bin' } });
  assert.ok(calls.every((call) => call.env.MUTAGEN_DATA_DIRECTORY === runtime.dataDir));
});

test('sync inspection reports a missing named session as missing rather than unavailable', async () => {
  const inspected = await inspectDevTargetSync({
    target,
    stackBaseDir: '/tmp/stack',
    env: {},
  }, {
    runCaptureResult: async () => ({
      ok: false,
      exitCode: 1,
      out: '',
      err: 'Error: unable to locate requested sessions: specification "happier-linux" did not match any sessions',
    }),
  });

  assert.deepEqual(inspected, {
    state: 'missing',
    sessionName: 'happier-linux',
  });
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
      timeouts.push({ operation: args.includes('list') ? 'list' : 'flush', timeoutMs });
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
      alpha: { connected: true, scanned: false },
      beta: { connected: true, scanned: false },
    }]),
    err: '',
  };
  let listCalls = 0;
  const deps = {
    runCaptureResult: async ({ args }) => {
      calls.push(args);
      if (!args.includes('list')) return { ok: true, exitCode: 0, out: '', err: '' };
      listCalls += 1;
      return listCalls === 1 ? synchronizingResult : readyListResult();
    },
  };

  await syncDevTarget({ target, stackBaseDir: '/tmp/stack', env: {} }, deps);
  assert.equal(calls.some((args) => args.includes('flush')), true);
  await assert.rejects(
    () => runDevTargetCommand(
      { target, stackBaseDir: '/tmp/stack', commandArgs: ['pwd'], env: {} },
      {
        runCaptureResult: async () => synchronizingResult,
        spawnProcess: () => { throw new Error('must not launch'); },
      },
    ),
    /synchronizing/i,
  );
});

test('explicit exec admits a no-watch first cycle only through its mandatory flush', async () => {
  const unseeded = { ...readyListResult(), out: JSON.stringify([{
    name: 'happier-linux', paused: false, status: 'watching',
    alpha: { connected: true, scanned: false, watch: { mode: 'no-watch' } },
    beta: { connected: true, scanned: false, watch: { mode: 'no-watch' } },
  }]) };
  let flushed = false;
  const deps = {
    runCaptureResult: async ({ args }) => {
      if (args.includes('list')) return unseeded;
      flushed = true;
      return { ok: true, exitCode: 0, out: '', err: '' };
    },
    spawnProcess: () => {
      assert.equal(flushed, true, 'payload must follow the causal flush');
      return { completion: Promise.resolve({ code: 0, signal: null }) };
    },
  };
  const options = { target, stackBaseDir: '/tmp/stack', commandArgs: ['pwd'], provenance: 'skip', env: {} };
  assert.equal((await runDevTargetCommand(options, deps)).code, 0);
  flushed = false;
  await assert.rejects(runDevTargetCommand({ ...options, flush: false }, deps), /needs-flush/);
  assert.equal(flushed, false);
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

for (const signal of ['SIGINT', 'SIGHUP']) {
test(`remote exec ${signal} awaits cancellation without a subordinate deadline before stopping SSH and removes signal listeners`, async () => {
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
      runCaptureResult: async ({ command, args, timeoutMs }) => {
        calls.push([command, ...args]);
        if (args.includes('list')) return readyListResult();
        // Process/transport boundary: a healthy cancellation may outlast any
        // imposed local deadline; the containing execution still owns it.
        if (command === 'ssh' && Number.isFinite(timeoutMs)) {
          return { ok: false, exitCode: null, out: '', err: 'local cancellation deadline expired' };
        }
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
  assert.equal(signalSource.listenerCount(signal), 1, 'cancellation must be owned before a signal arrives');
  signalSource.emit(signal);
  assert.equal(signalSource.listenerCount(signal), 1, 'repeated interrupts stay owned during cleanup');
  signalSource.emit(signal);
  const result = await execution;
  assert.deepEqual(stopped, { ownedChild: child, signal });
  assert.match(calls[0][0], /hstack-dev-target-control$/);
  assert.ok(calls[0].includes('list'));
  assert.match(calls[1][0], /hstack-dev-target-control$/);
  assert.ok(calls[1].includes('flush'));
  assert.deepEqual(calls.slice(2).map((call) => call[0]), ['ssh', 'stop-local-ssh']);
  assert.match(calls[2].at(-1), /018f0f52-5fe8-7a9f-8ef5-f81f20572791/);
  assert.equal(result.signal, signal);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  assert.equal(signalSource.listenerCount('SIGHUP'), 0);
});
}

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
      runCaptureResult: async ({ args }) => {
        if (args.includes('list')) return readyListResult();
        if (args.includes('flush')) return { ok: true, exitCode: 0, out: '', err: '' };
        return { ok: false, exitCode: 255, out: '', err: 'connection lost' };
      },
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
