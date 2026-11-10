import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCaptureResult } from '../proc/proc.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import { readyDevTargetSyncResult as readyListResult } from '../../testkit/core/dev_target_sync.mjs';

import {
  inspectDevTargetSync,
  runDevTargetDependencyBootstrap,
  runDevTargetWorkspacePreparation,
  runDevTargetCommand as runDevTargetCommandImpl,
  syncDevTarget,
} from './executor.mjs';

const sourceFixtureDir = mkdtempSync(join(tmpdir(), 'happier-explicit-executor-tests-'));
writeFileSync(join(sourceFixtureDir, 'package.json'), JSON.stringify({ workspaces: [] }));
// Source-test classification follows the actual CLI resolver and setup policy.
// The fixture checkout has no remote dependencies, but retains those declarations.
mkdirSync(join(sourceFixtureDir, 'apps/cli/src'), { recursive: true });
mkdirSync(join(sourceFixtureDir, 'apps/cli/scripts'), { recursive: true });
writeFileSync(join(sourceFixtureDir, 'apps/cli/vitest.config.ts'),
  readFileSync(new URL('../../../../cli/vitest.config.ts', import.meta.url)));
writeFileSync(join(sourceFixtureDir, 'apps/cli/scripts/vitestWorkspacePackageResolution.ts'),
  readFileSync(new URL('../../../../cli/scripts/vitestWorkspacePackageResolution.ts', import.meta.url)));
writeFileSync(join(sourceFixtureDir, 'apps/cli/src/test-setup.unit.ts'),
  readFileSync(new URL('../../../../cli/src/test-setup.unit.ts', import.meta.url)));
test.after(() => rmSync(sourceFixtureDir, { recursive: true, force: true }));

function runDevTargetCommand(options, dependencies) {
  return runDevTargetCommandImpl({ sourceDir: sourceFixtureDir, ...options }, dependencies);
}

const target = {
  name: 'linux',
  platform: 'posix',
  ssh: 'linux-ssh',
  repoDir: '/home/dev/happier',
  cliHomeDir: '/home/dev/.happier/linux',
};

test('workspace aliases prepare their manifest component before remote payload admission', async t => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'happier-workspace-alias-executor-'));
  t.after(() => rmSync(sourceDir, { recursive: true, force: true }));
  mkdirSync(join(sourceDir, 'apps', 'viewer'), { recursive: true });
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ packageManager: 'yarn@1.22.22', workspaces: ['apps/*'] }));
  writeFileSync(join(sourceDir, 'apps', 'viewer', 'package.json'), JSON.stringify({
    name: '@fixture/viewer', scripts: { build: 'node compile.mjs' },
  }));
  let request;
  const result = await runDevTargetCommand({ target, sourceDir, stackBaseDir: '/tmp/stack',
    syncAlreadyVerified: true, provenance: 'skip', commandArgs: ['yarn', 'workspace', '@fixture/viewer', 'build'] }, {
    spawnProcess: input => { request = input; return { completion: Promise.resolve({ code: 0, signal: null }) }; },
  });
  assert.equal(result.code, 0);
  const command = request.args.at(-1);
  assert.match(command, /remote_validation_preparation\.mjs/);
  assert.match(command, /--component-relative-dir=apps\/viewer/);
  assert.ok(command.indexOf('remote_validation_preparation.mjs') < command.indexOf('--heavyweight-admission'));
});

for (const platform of ['posix', 'windows']) test(`entry graph preparation reaches the ${platform} worker before its payload`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-entry-preparation-transport-' });
  const sourceDir = fixture.path('repo');
  mkdirSync(join(sourceDir, 'apps/cli'), { recursive: true });
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  writeFileSync(join(sourceDir, 'apps/cli/package.json'), JSON.stringify({ name: '@fixture/cli' }));
  const trace = fixture.path('requests');
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'ssh', content:
    '#!/bin/sh\nfor arg in "$@"; do last=$arg; done\nprintf "%s\\n" "$last" >> "$TRACE"\n' });
  const result = await runDevTargetCommand({ target: { ...target, platform }, sourceDir,
    stackBaseDir: fixture.root, commandArgs: ['node', 'apps/stack/scripts/perf/entry-load.mjs'],
    dependencyAdmission: 'skip', syncAlreadyVerified: true, provenance: 'skip',
    env: { ...process.env, TRACE: trace, PATH: `${binDir}:${process.env.PATH}` },
  });
  assert.equal(result.code, 0);
  const requests = readFileSync(trace, 'utf8').trim().split('\n').map(request => platform === 'windows'
    ? Buffer.from(request.split(' ').at(-1), 'base64').toString('utf16le') : request).join('\n');
  assert.match(requests, /remote_validation_preparation\.mjs[\s\S]*--preparation-scope=entry-loads[\s\S]*entry-load\.mjs/);
  if (platform === 'posix') assert.ok(requests.indexOf('--preparation-scope=entry-loads') < requests.indexOf('--heavyweight-admission'));
});

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

test('try admission reports owner denial only when exit 75 and its stderr sentinel agree', async () => {
  const sentinel = 'HSTACK_ADMISSION_BUSY:admission-test-id';
  for (const scenario of [
    { code: 75, stream: 'stderr', line: sentinel, declined: true },
    { code: 75, stream: 'stderr', line: 'HSTACK_ADMISSION_DISK:admission-test-id', declined: true },
    { code: 75, stream: 'stderr', line: 'HSTACK_ADMISSION_CAPACITY:admission-test-id', declined: true },
    { code: 75, stream: 'stderr', line: 'HSTACK_ADMISSION_CAPACITY:another-execution-id', declined: false },
    { code: 75, stream: 'stdout', line: 'HSTACK_ADMISSION_CAPACITY:admission-test-id', declined: false },
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

test('explicit sync rescans scan-only problems through the existing flush before admission', async () => {
  const initial = readyListResult();
  const sessions = JSON.parse(initial.out);
  sessions[0].successfulCycles = 0;
  sessions[0].status = 'waiting-for-rescan';
  sessions[0].alpha.scanned = false;
  sessions[0].beta.scanned = false;
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

test('explicit sync rescans stale scan errors and still refuses persistent errors on Windows', async t => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', originalPlatformDescriptor));
  const initial = readyListResult();
  const sessions = JSON.parse(initial.out);
  sessions[0].alpha.scanProblems = [{ path: 'source/removed-link', error: 'invalid symbolic link: target is absolute' }];
  initial.out = JSON.stringify(sessions);
  for (const persistent of [false, true]) {
    let flushes = 0;
    const sync = () => syncDevTarget({ target, stackBaseDir: '/tmp/stack', env: {} }, {
      runCaptureResult: async ({ args }) => {
        if (args.includes('flush')) {
          flushes += 1;
          return { ok: true, exitCode: 0, out: '', err: '' };
        }
        return persistent || flushes === 0 ? initial : readyListResult();
      },
    });
    if (persistent) await assert.rejects(sync, /source\/removed-link.*invalid symbolic link/);
    else assert.equal((await sync()).state, 'ready');
    assert.equal(flushes, persistent ? 2 : 1, 'one causal flush and at most one fresh rescan');
  }
});

test('explicit sync recovers a staged relocation collision through the existing flush', async () => {
  const initial = readyListResult();
  const sessions = JSON.parse(initial.out);
  sessions[0].beta.transitionProblems = [{ path: 'apps/website/src/i18n/generated/slices/en.json',
    error: 'unable to relocate staged file: file exists' }];
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
  const controller = new AbortController();
  const result = await runDevTargetDependencyBootstrap({
    target,
    stackBaseDir: '/tmp/stack',
    syncAlreadyVerified: true,
    defaultBuildMode: 'qa-runtime',
    signal: controller.signal,
    env: { TEST_ENV: 'project' },
  }, {
    runCommand: async (options) => {
      calls.push(options);
      return { code: 0, signal: null };
    },
  });

  assert.deepEqual(result, { code: 0, signal: null });
  const { onLine, ...invocation } = calls[0];
  assert.deepEqual(invocation, {
    target,
    stackBaseDir: '/tmp/stack',
    commandArgs: [
      'node',
      './apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
      '--execution-placement=remote',
      '--validation-kind=runtime',
      '--component-relative-dir=.',
      '--default-build-mode=qa-runtime',
    ],
    environment: {
      HAPPIER_STACK_PM_CACHE_BASE_DIR: '/home/dev/.happier/linux/cache',
    },
    dependencyAdmission: 'skip',
    provenance: 'skip',
    signal: controller.signal,
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
      '--default-build-mode=strict',
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

test('explicit remote execution rejects authority-bound commands before sync or SSH', async () => {
  let boundaryCalls = 0;
  for (const [commandArgs, error] of [
    [['git', 'status'], /Git.*authoritative|primary.*Git/i],
    [['node', 'scripts/api-governance/cli.mjs', '--profile', 'plugin-ui', '--write'], /tracked-source writer.*authoritative/i],
  ]) {
    await assert.rejects(
      runDevTargetCommand({
        target,
        stackBaseDir: '/tmp/stack',
        commandArgs,
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
      error,
    );
  }
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

test('Windows source-test dispatch preserves preparation and explicit command mode through both existing transports', async (t) => {
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
    environment: { HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime' },
    env: { ...process.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict', TRACE: trace, PATH: `${root}:${process.env.PATH}` },
  });
  const requests = readFileSync(trace, 'utf8').trim().split('\n')
    .map(request => Buffer.from(request.split(' ').at(-1), 'base64').toString('utf16le'));
  assert.equal(requests.length, 3);
  assert.match(requests[0], /remote_dependency_bootstrap\.mjs.*--validation-kind=source-test/);
  assert.match(requests[1], /remote_validation_preparation\.mjs.*--validation-kind=source-test/);
  assert.match(requests[0], /--default-build-mode=qa-runtime/);
  assert.match(requests[1], /--default-build-mode=qa-runtime/);
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
  assert.equal(listCalls, 3, 'the Windows adapter re-evaluates after its one fresh rescan');
  for (const problemFamily of ['transitionProblems', 'scanProblems']) {
    for (const persistent of [false, true]) {
      let flushes = 0;
      let launched = false;
      const dispatch = () => runDevTargetCommand(
        { target, stackBaseDir: '/tmp/stack', commandArgs: ['rg', '-n', 'needle'], env: {} },
        {
          runCaptureResult: async ({ args }) => {
            if (args.includes('flush')) flushes += 1;
            if (args.includes('list')) {
              const result = readyListResult();
              if (flushes === 1 || (persistent && flushes > 0)) {
                const sessions = JSON.parse(result.out);
                sessions[0].beta[problemFamily] = [{ path: 'source', error: problemFamily === 'scanProblems'
                  ? 'hashed size mismatch: 1 != 2' : 'unable to validate existing file: modification detected' }];
                result.out = JSON.stringify(sessions);
              }
              return result;
            }
            return { ok: true, exitCode: 0, out: '', err: '' };
          },
          spawnProcess: () => {
            launched = true;
            return { completion: Promise.resolve({ code: 0, signal: null }) };
          },
        },
      );
      if (persistent) await assert.rejects(dispatch, /synchronization is unhealthy/);
      else await dispatch();
      assert.equal(flushes, 2, 'the native-less adapter allows only one fresh retry');
      assert.equal(launched, !persistent, 'dispatch requires clean final evidence');
    }
  }
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

test('JavaScript cancellation preserves real custody signal events on controller stderr', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-cancel-events-' });
  // SSH is the OS transport boundary; its cancellation reply comes from the
  // real custody producer rather than a handwritten event fixture.
  writeFakeBin({ root, name: 'ssh', content: `#!/bin/sh
exec /bin/bash "$CUSTODY_SOURCE" run "$CUSTODY_RECORD" js-cancel-events /bin/bash -c 'sleep 300 & exit 0'
` });
  const script = `
    import { EventEmitter } from 'node:events';
    import { runDevTargetCommand } from ${JSON.stringify(new URL('./executor.mjs', import.meta.url).href)};
    const signals = new EventEmitter();
    let complete;
    const child = { completion: new Promise(resolve => { complete = resolve; }) };
    await runDevTargetCommand({
      target: ${JSON.stringify(target)}, stackBaseDir: ${JSON.stringify(root)}, sourceDir: ${JSON.stringify(sourceFixtureDir)},
      commandArgs: ['long-test'], syncAlreadyVerified: true, provenance: 'skip', env: process.env,
    }, {
      signalSource: signals,
      spawnProcess: () => { setImmediate(() => signals.emit('SIGTERM')); return child; },
      stopProcess: async () => { complete({ code: null, signal: 'SIGTERM' }); },
    });
  `;
  const result = await runCaptureResult(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TMPDIR: root,
      CUSTODY_SOURCE: new URL('./remote_execution_custody.sh', import.meta.url).pathname,
      CUSTODY_RECORD: join(root, 'remote-exec/js-cancel-events.pid') },
  });
  assert.equal(result.exitCode, 0, result.err);
  assert.equal(result.out, '', 'cancellation diagnostics must not enter payload stdout');
  const lines = result.err.split('\n').filter(line => line.includes('[preferred-execution] custody_signal '));
  assert.ok(lines.length > 0, 'successful cancellation must expose its real signal events');
  for (const line of lines) {
    const event = JSON.parse(line.slice(line.indexOf('[preferred-execution] custody_signal ') + '[preferred-execution] custody_signal '.length));
    assert.equal(event.execution_id, 'js-cancel-events');
    assert.equal(event.initiating_execution_id, 'js-cancel-events');
    assert.equal(event.signal, 'TERM');
    assert.equal(event.syscall_result, 0);
  }
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
