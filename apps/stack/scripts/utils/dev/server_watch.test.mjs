import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanupProvisionalServerChild,
  resolveStackOwnedServerListenPid,
  resolveStackOwnedServerRuntimePid,
  preflightDevServerRestart,
  startDevServer,
  stopStackOwnedServerForRestart,
} from './server.mjs';

test('server restart preflight delegates runtime validation to the package-manager owner', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({
      private: true,
      scripts: { build: 'full-build', 'typecheck:runtime': 'runtime-only-typecheck' },
    }));
    const directProcessCalls = [];
    const packageManagerCalls = [];
    const result = await preflightDevServerRestart(
      { serverDir, serverEnv: {}, consoleImpl: { log() {} } },
      {
        runImpl: async (...args) => directProcessCalls.push(args),
        pmExecBinImpl: async (input) => packageManagerCalls.push(input),
      },
    );
    assert.deepEqual(result, { ran: true, reason: 'runtime-typecheck-ok' });
    assert.deepEqual(directProcessCalls, []);
    assert.equal(packageManagerCalls.length, 1);
    assert.equal(packageManagerCalls[0].bin, 'typecheck:runtime');
  });
});

test('server restart preflight generates provider clients before runtime validation only when reload migration evidence requires it', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({
      private: true,
      scripts: {
        'generate:providers': 'generate-all-provider-clients',
        'typecheck:runtime': 'runtime-only-typecheck',
      },
    }));
    const calls = [];
    const boundary = {
      pmExecBinImpl: async ({ bin }) => calls.push(bin),
    };

    await preflightDevServerRestart(
      {
        serverDir,
        serverEnv: {},
        reloadMigrationMode: 'skip',
        consoleImpl: { log() {} },
      },
      boundary,
    );
    assert.deepEqual(calls, ['typecheck:runtime'], 'app-only reloads must not regenerate provider clients');

    calls.length = 0;
    await preflightDevServerRestart(
      {
        serverDir,
        serverEnv: {},
        reloadMigrationMode: 'apply',
        consoleImpl: { log() {} },
      },
      boundary,
    );
    assert.deepEqual(calls, ['generate:providers', 'typecheck:runtime']);

    calls.length = 0;
    await preflightDevServerRestart(
      {
        serverDir,
        serverEnv: {},
        reloadMigrationMode: 'apply',
        consoleImpl: { log() {} },
      },
      boundary,
    );
    assert.deepEqual(calls, ['generate:providers', 'typecheck:runtime']);
  });
});

test('server restart preflight consumes the parent-start marker once before watcher reloads', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({
      private: true,
      scripts: { 'typecheck:runtime': 'runtime-only-typecheck' },
    }));
    const serverEnv = { HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE: '1' };
    const packageManagerCalls = [];
    const boundary = { pmExecBinImpl: async (input) => packageManagerCalls.push(input) };

    assert.deepEqual(
      await preflightDevServerRestart({ serverDir, serverEnv, consoleImpl: { log() {} } }, boundary),
      { ran: false, reason: 'already-done' },
    );
    assert.equal(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.deepEqual(
      await preflightDevServerRestart({ serverDir, serverEnv, consoleImpl: { log() {} } }, boundary),
      { ran: true, reason: 'runtime-typecheck-ok' },
    );
    assert.equal(packageManagerCalls.length, 1);
  });
});

test('disabled server restart preflight consumes the parent marker without invoking the package boundary', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const serverEnv = {
      HAPPIER_STACK_SERVER_RESTART_PREFLIGHT: '0',
      HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE: '1',
    };
    let packageManagerCalls = 0;

    assert.deepEqual(
      await preflightDevServerRestart(
        { serverDir, serverEnv, consoleImpl: { log() {} } },
        { pmExecBinImpl: async () => { packageManagerCalls += 1; } },
      ),
      { ran: false, reason: 'disabled' },
    );
    assert.equal(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(packageManagerCalls, 0);
  });
});

test('stopped-stack restart consumes parent preflight marker before spawn and preserves the next watcher preflight', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({
      private: true,
      scripts: { 'typecheck:runtime': 'runtime-only-typecheck' },
    }));
    const packageManagerCalls = [];
    const boundary = { pmExecBinImpl: async (input) => packageManagerCalls.push(input) };
    let stopped = false;
    let workspaceAdmissions = 0;
    let spawnedEnv;
    const baseEnv = {
      HAPPIER_STACK_MANAGED_INFRA: '0',
      HAPPIER_STACK_PRISMA_MIGRATE: '0',
      HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE: '1',
    };

    await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv,
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: true,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {},
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => { workspaceAdmissions += 1; },
        preflightDevServerRestartImpl: async (input) => preflightDevServerRestart(input, boundary),
        stopStackOwnedServerForRestartImpl: async () => { stopped = true; },
        pmSpawnScriptImpl: async ({ env }) => {
          spawnedEnv = env;
          return { pid: 2001, exitCode: null };
        },
        waitForServerReadyImpl: async () => {},
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3001,
        recordStackRuntimeServerActivationImpl: async () => {},
      },
    );

    assert.equal(stopped, false, 'a stopped stack must not authorize destructive cleanup');
    assert.equal(spawnedEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.deepEqual(packageManagerCalls, [], 'the parent marker suppresses only the startup preflight');
    assert.equal(workspaceAdmissions, 1, 'already-completed preflight must fall back to source declaration admission');

    assert.deepEqual(
      await preflightDevServerRestart({ serverDir, serverEnv: spawnedEnv, consoleImpl: { log() {} } }, boundary),
      { ran: true, reason: 'runtime-typecheck-ok' },
    );
    assert.equal(packageManagerCalls.length, 1, 'the first watcher reload must run its own preflight');
  });
});

test('disabled stopped-stack restart consumes the parent preflight marker from child and orchestration environments', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const baseEnv = {
      HAPPIER_STACK_MANAGED_INFRA: '0',
      HAPPIER_STACK_PRISMA_MIGRATE: '0',
      HAPPIER_STACK_SERVER_RESTART_PREFLIGHT: '0',
      HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE: '1',
    };
    let stopped = false;
    let workspaceAdmissions = 0;
    let spawnedEnv;

    await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv,
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: true,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {},
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => { workspaceAdmissions += 1; },
        preflightDevServerRestartImpl: preflightDevServerRestart,
        stopStackOwnedServerForRestartImpl: async () => { stopped = true; },
        pmSpawnScriptImpl: async ({ env }) => {
          spawnedEnv = env;
          return { pid: 2001, exitCode: null };
        },
        waitForServerReadyImpl: async () => {},
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3001,
        recordStackRuntimeServerActivationImpl: async () => {},
      },
    );

    assert.equal(stopped, false);
    assert.equal(spawnedEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(workspaceAdmissions, 1, 'disabled preflight must fall back to source declaration admission');
  });
});

test('stopped-stack restart delegates declaration admission once to a running runtime preflight', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: { HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: true,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => { calls.push('deps'); },
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => { calls.push('workspace'); },
        preflightDevServerRestartImpl: async () => {
          calls.push('preflight');
          return { ran: true, reason: 'runtime-typecheck-ok' };
        },
        stopStackOwnedServerForRestartImpl: async () => { calls.push('stop'); },
        pmSpawnScriptImpl: async () => {
          calls.push('spawn');
          return { pid: 2001, exitCode: null };
        },
        waitForServerReadyImpl: async () => { calls.push('ready'); },
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3001,
        recordStackRuntimeServerActivationImpl: async () => {},
      },
    );

    assert.deepEqual(calls, ['deps', 'preflight', 'spawn', 'ready']);
  });
});

test('stopped-stack restart admits source declarations once when runtime preflight has no build script', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({ private: true, scripts: {} }));
    const calls = [];
    await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: { HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: true,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {},
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => { calls.push('workspace'); },
        preflightDevServerRestartImpl: async (input) => {
          const result = await preflightDevServerRestart(input);
          calls.push(result.reason);
          return result;
        },
        pmSpawnScriptImpl: async () => {
          calls.push('spawn');
          return { pid: 2001, exitCode: null };
        },
        waitForServerReadyImpl: async () => {},
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3001,
        recordStackRuntimeServerActivationImpl: async () => {},
      },
    );

    assert.deepEqual(calls, ['missing-build-script', 'workspace', 'spawn']);
  });
});

async function withTempServerDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-server-watch-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return await fn(dir);
}

test('startDevServer prepares dependencies before full-server infrastructure and migration side effects', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const sideEffects = [];
    await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_STACK_MANAGED_INFRA: '1',
          HAPPIER_STACK_PRISMA_MIGRATE: '1',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: true,
        restart: false,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => sideEffects.push('dependencies'),
        ensureHappyServerManagedInfraImpl: async () => {
          sideEffects.push('infrastructure');
          return { env: {} };
        },
        applyHappyServerMigrationsImpl: async () => sideEffects.push('migration'),
      },
    );

    assert.deepEqual(sideEffects, ['dependencies', 'infrastructure', 'migration']);
  });
});

test('startDevServer validates workspace package exports before spawning a server process', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const child = { pid: 2001, exitCode: null, kill() {} };
    let spawnOnLine = null;

    const result = await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: { HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        admitPriorBuildsImmediately: true,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async (_dir, _label, options) => {
          calls.push('deps');
          assert.equal(options.refreshExisting, false);
          assert.equal(options.prepareComponentOutputs, false);
        },
        ensureSourceServerWorkspacePackagesBuiltImpl: async ({
          serverDir: dir,
          admitPriorOutputsImmediately,
        }) => {
          calls.push('workspace');
          assert.equal(dir, serverDir);
          assert.equal(admitPriorOutputsImmediately, true);
        },
        pmSpawnScriptImpl: async ({ options }) => {
          calls.push('spawn');
          spawnOnLine = options?.onLine;
          spawnOnLine?.({ line: '{"happierStackTransition":"migration_started"}' });
          return child;
        },
        waitForServerReadyImpl: async (_url, options) => {
          calls.push('ready');
          assert.equal(options?.startupDeadline?.getPhase(), 'migration');
          spawnOnLine?.({ line: '{"happierStackTransition":"migration_completed"}' });
          assert.equal(options?.startupDeadline?.getPhase(), 'readiness');
        },
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => {
          calls.push('ownership');
        },
        recordStackRuntimeServerActivationImpl: async () => {
          calls.push('record');
        },
      },
    );

    assert.equal(result.serverProc, child);
    assert.equal(typeof spawnOnLine, 'function');
    assert.deepEqual(calls, ['deps', 'workspace', 'spawn', 'ready', 'ownership', 'record']);
  });
});

test('startDevServer boots an admitted prior runtime before source preparation and leaves source reload env current', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const child = { pid: 2001, exitCode: null, kill() {} };
    const runtimeServerDir = join(serverDir, 'prior-runtime', 'server');
    const priorRuntimeServerLaunchSpec = {
      source: 'runtime',
      serverDir: runtimeServerDir,
      command: join(runtimeServerDir, 'happier-server'),
      args: [],
    };

    const result = await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: {},
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        admitPriorBuildsImmediately: true,
        priorRuntimeServerLaunchSpec,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {
          throw new Error('source dependency preparation must stay in the background refresh');
        },
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {
          throw new Error('source workspace builds must stay in the background refresh');
        },
        pmSpawnScriptImpl: async () => {
          throw new Error('the source server must not be the cold-start availability gate');
        },
        spawnPriorRuntimeServerImpl: ({ launchSpec, env }) => {
          calls.push('spawn-runtime');
          assert.equal(launchSpec, priorRuntimeServerLaunchSpec);
          assert.equal(env.HAPPIER_SQLITE_AUTO_MIGRATE, '0');
          assert.equal(env.HAPPIER_SQLITE_MIGRATIONS_DIR, join(runtimeServerDir, 'prisma', 'sqlite', 'migrations'));
          return child;
        },
        waitForServerReadyImpl: async () => calls.push('ready'),
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => {
          calls.push('ownership');
          return 3001;
        },
        recordStackRuntimeServerActivationImpl: async () => calls.push('record'),
      },
    );

    assert.equal(result.serverProc, child);
    assert.equal(result.bootstrapSource, 'runtime');
    assert.equal(result.serverEnv.DATABASE_URL, undefined);
    assert.equal(result.serverEnv.HAPPIER_SQLITE_MIGRATIONS_DIR, undefined);
    assert.deepEqual(calls, ['spawn-runtime', 'ready', 'ownership', 'record']);
  });
});

test('startDevServer refreshes once and retries when an admitted prior generation cannot boot', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const calls = [];
    const children = [];
    const firstChild = { pid: 2001, exitCode: 1 };
    const secondChild = { pid: 2002, exitCode: null };
    let spawnCount = 0;
    let readyCount = 0;

    const result = await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: { HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        admitPriorBuildsImmediately: true,
        children,
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async (_dir, _label, options) => {
          calls.push(options.refreshExisting === false ? 'deps:prior' : 'deps:fresh');
        },
        ensureSourceServerWorkspacePackagesBuiltImpl: async ({ admitPriorOutputsImmediately }) => {
          calls.push(admitPriorOutputsImmediately ? 'workspace:prior' : 'workspace:fresh');
        },
        pmSpawnScriptImpl: async () => {
          spawnCount += 1;
          calls.push(`spawn:${spawnCount}`);
          return spawnCount === 1 ? firstChild : secondChild;
        },
        waitForServerReadyImpl: async () => {
          readyCount += 1;
          calls.push(`ready:${readyCount}`);
          if (readyCount === 1) throw new Error('prior generation is incompatible');
        },
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3002,
        recordStackRuntimeServerActivationImpl: async () => calls.push('record'),
        killProcessGroupOwnedByStackImpl: async () => ({ killed: false, reason: 'already-exited' }),
      },
    );

    assert.equal(result.serverProc, secondChild);
    assert.deepEqual(children, [secondChild]);
    assert.deepEqual(calls, [
      'deps:prior',
      'workspace:prior',
      'spawn:1',
      'ready:1',
      'deps:fresh',
      'workspace:fresh',
      'spawn:2',
      'ready:2',
      'record',
    ]);
  });
});

test('startDevServer surfaces typed cleanup-incomplete truth when provisional termination is unconfirmed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const child = { pid: 2001, exitCode: null };
    const children = [];
    const readinessError = Object.assign(new Error('readiness failed'), { code: 'ESERVERREADINESS' });

    await assert.rejects(
      () => startDevServer(
        {
          serverComponentName: 'happier-server',
          serverDir,
          autostart: { stackName: 'start-test', baseDir: serverDir },
          baseEnv: { HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
          serverPort: 34567,
          internalServerUrl: 'http://127.0.0.1:34567',
          publicServerUrl: 'http://localhost:34567',
          envPath: join(serverDir, 'env'),
          stackMode: true,
          runtimeStatePath: join(serverDir, 'stack.runtime.json'),
          serverAlreadyRunning: false,
          restart: false,
          children,
          quiet: true,
        },
        {
          ensureDepsInstalledImpl: async () => {},
          ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
          pmSpawnScriptImpl: async () => child,
          waitForServerReadyImpl: async () => { throw readinessError; },
          killProcessGroupOwnedByStackImpl: async () => ({ killed: true, reason: 'killed_pid_only' }),
          killSpawnedChildImpl: async () => ({ ok: false }),
        },
      ),
      (error) => error?.code === 'ESERVERPROVISIONINGCLEANUPINCOMPLETE'
        && error?.cause === readinessError,
    );

    assert.deepEqual(children, [child], 'unconfirmed child ownership must remain visible for operator attention');
  });
});

test('startDevServer records the listener pid separately from the server wrapper pid', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const child = { pid: 2001, exitCode: null, kill() {} };
    const updates = [];

    await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: { HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        children: [],
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {},
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        pmSpawnScriptImpl: async () => child,
        waitForServerReadyImpl: async () => {},
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3001,
        recordStackRuntimeServerActivationImpl: async (_statePath, activation) => {
          updates.push(activation);
        },
      },
    );

    assert.deepEqual(updates, [
      {
        listenerPid: 3001,
        wrapperPid: 2001,
        stablePort: 34567,
        backendPort: null,
        proxyPid: null,
        drainingPid: null,
        mode: 'direct',
        restartMode: null,
        reloadGeneration: null,
        fallbackReason: null,
        clearProxyState: true,
      },
    ]);
  });
});

test('startDevServer directFallback activation does not publish proxy backend authority', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const updates = [];

    await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'start-test', baseDir: serverDir },
        baseEnv: { HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
        serverPort: 34567,
        serverBindPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://localhost:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        children: [],
        quiet: true,
        serverProxyRuntime: {
          enabled: true,
          proxyPid: null,
          mode: 'directFallback',
          fallbackReason: 'proxy unavailable',
        },
      },
      {
        ensureDepsInstalledImpl: async () => {},
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
        pmSpawnScriptImpl: async () => ({ pid: 2001, exitCode: null }),
        waitForServerReadyImpl: async () => {},
        assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3001,
        recordStackRuntimeServerActivationImpl: async (_path, activation) => {
          updates.push(activation);
        },
      },
    );

    assert.equal(updates[0]?.listenerPid, 3001);
    assert.equal(updates[0]?.wrapperPid, 2001);
    assert.equal(updates[0]?.proxyPid, null);
    assert.equal(updates[0]?.backendPort, null);
    assert.equal(updates[0]?.stablePort, 34567);
    assert.equal(updates[0]?.mode, 'directFallback');
    assert.equal(updates[0]?.fallbackReason, 'proxy unavailable');
  });
});

for (const mode of ['direct', 'proxy', 'directFallback']) {
  test(`startDevServer surfaces ${mode} runtime publication failure without terminating the active child`, async (t) => {
    await withTempServerDir(t, async (serverDir) => {
      const children = [];
      const killedPids = [];
      const child = {
        pid: 2001,
        exitCode: null,
        kill() {
          killedPids.push(this.pid);
        },
      };

      await assert.rejects(
        () => startDevServer(
          {
            serverComponentName: 'happier-server',
            serverDir,
            autostart: { stackName: 'start-test', baseDir: serverDir },
            baseEnv: { HAPPIER_STACK_MANAGED_INFRA: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
            serverPort: 34567,
            serverBindPort: mode === 'proxy' ? 34568 : 34567,
            internalServerUrl: `http://127.0.0.1:${mode === 'proxy' ? 34568 : 34567}`,
            publicServerUrl: 'http://localhost:34567',
            envPath: join(serverDir, 'env'),
            stackMode: true,
            runtimeStatePath: join(serverDir, 'stack.runtime.json'),
            serverAlreadyRunning: false,
            restart: false,
            children,
            quiet: true,
            serverProxyRuntime: mode === 'proxy'
              ? { enabled: true, proxyPid: 4001, mode: 'proxy' }
              : mode === 'directFallback'
                ? { enabled: true, proxyPid: null, mode: 'directFallback', fallbackReason: 'proxy unavailable' }
                : null,
          },
          {
            ensureDepsInstalledImpl: async () => {},
            ensureSourceServerWorkspacePackagesBuiltImpl: async () => {},
            pmSpawnScriptImpl: async () => child,
            waitForServerReadyImpl: async () => {},
            assertServerPortOwnedBySpawnedProcessGroupImpl: async () => 3001,
            recordStackRuntimeServerActivationImpl: async (_statePath, activation) => {
              const error = new Error('runtime publication unavailable');
              error.code = 'ESERVERRUNTIMEPROJECTION';
              error.serverActivationCommitted = true;
              error.authoritativeServerPid = activation.listenerPid;
              error.authoritativeServerWrapperPid = activation.wrapperPid;
              error.serverMode = activation.mode;
              throw error;
            },
          },
        ),
        (error) => error?.code === 'ESERVERRUNTIMEPROJECTION'
          && error?.serverActivationCommitted === true
          && error?.authoritativeServerPid === 3001
          && error?.authoritativeServerWrapperPid === 2001
          && error?.serverMode === mode
          && /runtime publication unavailable/.test(error.message),
      );

      assert.deepEqual(children, [child]);
      assert.deepEqual(killedPids, []);
    });
  });
}

test('resolveStackOwnedServerListenPid returns a stack-owned listener for stale runtime repair', async () => {
  const pid = await resolveStackOwnedServerListenPid(
    { serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      listListenPidsImpl: async () => [2222],
      isPidOwnedByStackImpl: async (candidate) => Number(candidate) === 2222,
      getProcessGroupIdImpl: async () => 2222,
    },
  );

  assert.equal(pid, 2222);
});

test('resolveStackOwnedServerRuntimePid requires alive runtime PID ownership and listener evidence', async () => {
  const pid = await resolveStackOwnedServerRuntimePid(
    { runtimeServerPid: 1234, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => null,
    },
  );

  assert.equal(pid, null);
});

test('resolveStackOwnedServerRuntimePid repairs stale runtime PID from stack-owned listener evidence', async () => {
  const pid = await resolveStackOwnedServerRuntimePid(
    { runtimeServerPid: 1234, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      isPidAliveImpl: () => false,
      isPidOwnedByStackImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => 2222,
    },
  );

  assert.equal(pid, 2222);
});

test('resolveStackOwnedServerRuntimePid returns the listener identity when a wrapper leads the listener process group', async () => {
  const pid = await resolveStackOwnedServerRuntimePid(
    { runtimeServerPid: 1234, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
    {
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => true,
      listListenPidsImpl: async () => [2222],
      getProcessGroupIdImpl: async (candidate) => {
        if (Number(candidate) === 1234 || Number(candidate) === 2222) return 7000;
        return Number(candidate);
      },
      resolveStackOwnedServerListenPidImpl: async () => null,
    },
  );

  assert.equal(pid, 2222);
});

test('stopStackOwnedServerForRestart terminates through the listener identity when a wrapper leads the process group', async () => {
  const killed = [];
  const result = await stopStackOwnedServerForRestart(
    { pid: 1234, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env', label: 'server' },
    {
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => true,
      listListenPidsImpl: async () => [2222],
      getProcessGroupIdImpl: async (candidate) => {
        if (Number(candidate) === 1234 || Number(candidate) === 2222) return 7000;
        return Number(candidate);
      },
      killProcessGroupOwnedByStackImpl: async (pid) => {
        killed.push(Number(pid));
        return { killed: Number(pid) === 2222 };
      },
      waitForTcpPortFreeImpl: async () => ({ status: 'free' }),
    },
  );

  assert.deepEqual(killed, [2222]);
  assert.deepEqual(result, { stopped: true, pid: 1234 });
});

test('stopStackOwnedServerForRestart repairs stale stack-owned listeners before waiting for port release', async () => {
  const killed = [];
  const waited = [];

  const result = await stopStackOwnedServerForRestart(
    { pid: 1234, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env', label: 'server' },
    {
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => true,
      listListenPidsWithStatusImpl: async (_port, options) => ({
        status: 'ok',
        supported: true,
        pids: options.processGroupId ? [] : [2222],
      }),
      getProcessGroupIdImpl: async (candidate) => Number(candidate),
      observeTcpPortAvailabilityImpl: async () => ({ status: 'occupied', reason: 'address-in-use' }),
      killProcessGroupOwnedByStackImpl: async (pid) => {
        killed.push(pid);
        return { killed: pid === 2222, reason: pid === 2222 ? 'killed_pgid' : 'not_owned' };
      },
      resolveStackOwnedServerListenPidImpl: async () => 2222,
      waitForTcpPortFreeImpl: async (port) => {
        waited.push(port);
        return { status: 'free' };
      },
    },
  );

  assert.equal(result.stopped, true);
  assert.deepEqual(killed, [2222]);
  assert.deepEqual(waited, [34567]);
});

test('post-stop release refuses legacy Boolean evidence', async () => {
  await assert.rejects(
    () => stopStackOwnedServerForRestart(
      { pid: null, serverPort: 34567, stackName: 'watch-test', envPath: '/tmp/watch-test/env' },
      {
        waitForTcpPortFreeImpl: async () => true,
      },
    ),
    (error) => error?.code === 'ESERVERBACKENDPORTOCCUPIED',
  );
});

test('provisional cleanup uses the canonical tree terminator instead of direct child kill', async () => {
  const child = { pid: 201, exitCode: null, kill() { assert.fail('direct child kill is not tree-safe'); } };
  const children = [child];
  const treeSignals = [];

  const cleaned = await cleanupProvisionalServerChild({
    child,
    children,
    stackName: 'watch-test',
    envPath: '/tmp/watch-test.env',
    env: { HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200' },
    killProcessGroupOwnedByStackImpl: async () => ({ killed: false }),
    killSpawnedChildImpl: async (_child, signal, options) => {
      treeSignals.push([signal, options]);
      child.exitCode = 0;
      return { ok: true, signal };
    },
  });

  assert.equal(cleaned, true);
  assert.deepEqual(treeSignals, [['SIGTERM', { graceMs: 1450 }]]);
  assert.deepEqual(children, []);
});

test('successful provisional ownership cleanup consumes canonical server grace without fallback', async () => {
  const child = { pid: 202, exitCode: null };
  const children = [child];
  const ownershipKills = [];

  const cleaned = await cleanupProvisionalServerChild({
    child,
    children,
    stackName: 'watch-test',
    envPath: '/tmp/watch-test.env',
    env: { HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200' },
    killProcessGroupOwnedByStackImpl: async (pid, options) => {
      ownershipKills.push({ pid, options });
      return { killed: true, reason: 'killed_pgid' };
    },
    killSpawnedChildImpl: async () => assert.fail('successful ownership cleanup must not call fallback'),
  });

  assert.equal(cleaned, true);
  assert.deepEqual(ownershipKills, [{
    pid: 202,
    options: {
      stackName: 'watch-test',
      envPath: '/tmp/watch-test.env',
      label: 'server',
      json: false,
      graceMs: 1450,
    },
  }]);
  assert.deepEqual(children, []);
});
