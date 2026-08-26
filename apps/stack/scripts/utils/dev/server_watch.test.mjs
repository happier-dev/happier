import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveStackOwnedServerListenPid,
  resolveStackOwnedServerRuntimePid,
  preflightDevServerRestart,
  startDevServer,
  stopStackOwnedServerForRestart,
  terminateSpawnedChildForCleanup,
} from './server.mjs';
import { getSpawnedProcessPlannedExitReason } from '../proc/proc.mjs';
import { listListenPids } from '../net/ports.mjs';
import { createListenerOwnershipObservationScope } from '../server/listener_ownership.mjs';

function expectedDirectServerRuntimePatch({ listenerPid, wrapperPid, serverPort = 34567 }) {
  return {
    processes: {
      serverPid: listenerPid,
      serverWrapperPid: wrapperPid,
      proxyPid: null,
      serverBackendPid: null,
      serverDrainingPid: null,
    },
    ports: {
      server: serverPort,
      serverBackend: null,
    },
    serverProxy: {
      enabled: false,
      mode: 'direct',
      restartMode: null,
      reloadGeneration: null,
      fallbackReason: null,
    },
  };
}

async function withTempServerDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-server-watch-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return await fn(dir);
}

test('startDevServer normalizes providers independently of the full preset', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const sideEffects = [];
    const sqliteOut = await startDevServer(
        {
          serverComponentName: 'happier-server',
          serverDir,
          autostart: { stackName: 'watch-test', baseDir: serverDir },
          baseEnv: {
            HAPPIER_DB_PROVIDER: 'sqlite',
            HAPPIER_STACK_MANAGED_INFRA: '0',
            HAPPIER_STACK_PRISMA_MIGRATE: '0',
          },
          serverPort: 34567,
          internalServerUrl: 'http://127.0.0.1:34567',
          publicServerUrl: 'http://127.0.0.1:34567',
          envPath: join(serverDir, 'env'),
          stackMode: true,
          runtimeStatePath: join(serverDir, 'stack.runtime.json'),
          serverAlreadyRunning: true,
          restart: false,
          children: [],
          quiet: true,
        },
        {
          ensureDepsInstalledImpl: async () => sideEffects.push('deps'),
          pmSpawnScriptImpl: async () => {
            sideEffects.push('spawn');
            return { pid: 201, exitCode: null };
          },
          waitForServerReadyImpl: async () => {},
          listListenPidsImpl: async () => [201],
          getProcessGroupIdImpl: async () => 201,
          recordStackRuntimeUpdateImpl: async () => {},
        },
      );
    assert.equal(sqliteOut.serverEnv.HAPPIER_DB_PROVIDER, 'sqlite');
    assert.equal(sqliteOut.serverEnv.HAPPIER_SERVER_FLAVOR, 'full');
    assert.equal(sqliteOut.serverEnv.HAPPIER_SERVER_LIGHT_DATA_DIR, join(serverDir, 'server-light'));
    assert.deepEqual(sideEffects, ['deps']);

    const out = await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_SERVER_FLAVOR: 'light',
          HAPPY_SERVER_FLAVOR: 'light',
          DATABASE_URL: 'postgresql://operator:secret@db.example.test/happier',
          HAPPIER_STACK_MANAGED_INFRA: '0',
          HAPPIER_STACK_PRISMA_MIGRATE: '0',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: true,
        restart: false,
        children: [],
        quiet: true,
      },
      { ensureDepsInstalledImpl: async () => {} },
    );
    assert.equal(out.serverEnv.HAPPIER_DB_PROVIDER, 'postgres');
    assert.equal(out.serverEnv.HAPPIER_SERVER_FLAVOR, 'full');
    assert.equal(out.serverEnv.HAPPY_SERVER_FLAVOR, 'full');
  });
});

test('startDevServer prepares dependencies before full-server infrastructure and migration side effects', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const sideEffects = [];
    await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_STACK_MANAGED_INFRA: '1',
          HAPPIER_STACK_PRISMA_MIGRATE: '1',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
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
        applyServerMigrationsImpl: async () => sideEffects.push('migration'),
      },
    );

    assert.deepEqual(sideEffects, ['dependencies', 'infrastructure', 'migration']);
  });
});

test('startDevServer keeps explicit mysql database authority through managed infra and migrations', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const mysqlUrl = 'mysql://operator:secret@db.example/happier?mode=exact';
    let migrationInput = null;
    const out = await startDevServer(
      {
        serverComponentName: 'happier-server',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_DB_PROVIDER: 'mysql',
          DATABASE_URL: mysqlUrl,
          HAPPIER_STACK_MANAGED_INFRA: '1',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: true,
        restart: false,
        children: [],
        quiet: true,
      },
      {
        ensureHappyServerManagedInfraImpl: async () => ({
          env: {
            DATABASE_URL: 'postgresql://managed-sidecar/happier',
            REDIS_URL: 'redis://managed-sidecar',
          },
        }),
        applyServerMigrationsImpl: async (input) => {
          migrationInput = input;
        },
        ensureDepsInstalledImpl: async () => {},
      },
    );

    assert.equal(out.serverEnv.HAPPIER_DB_PROVIDER, 'mysql');
    assert.equal(out.serverEnv.DATABASE_URL, mysqlUrl);
    assert.equal(out.serverEnv.REDIS_URL, 'redis://managed-sidecar');
    assert.equal(migrationInput.dbProvider, 'mysql');
    assert.equal(migrationInput.env.DATABASE_URL, mysqlUrl);
  });
});

test('startDevServer applies provider migrations under the light preset without full managed infrastructure', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const postgresUrl = 'postgresql://operator:secret@db.example/happier';
    const sideEffects = [];
    await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_DB_PROVIDER: 'postgres',
          DATABASE_URL: postgresUrl,
          HAPPIER_STACK_PRISMA_MIGRATE: '1',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
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
        ensureHappyServerManagedInfraImpl: async () => sideEffects.push('unexpected-infrastructure'),
        applyServerMigrationsImpl: async ({ dbProvider, env }) => {
          sideEffects.push(`migration:${dbProvider}:${env.DATABASE_URL}`);
        },
      },
    );

    assert.deepEqual(sideEffects, ['dependencies', `migration:postgres:${postgresUrl}`]);
  });
});

test('startDevServer clears an inherited DATABASE_URL for a light server', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const out = await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_SERVER_FLAVOR: 'full',
          HAPPY_SERVER_FLAVOR: 'full',
          HAPPIER_DB_PROVIDER: 'sqlite',
          DATABASE_URL: 'mysql://exported-shell/db',
          HAPPIER_STACK_MANAGED_INFRA: '0',
          HAPPIER_STACK_PRISMA_MIGRATE: '0',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: true,
        restart: false,
        children: [],
        quiet: true,
      },
      { ensureDepsInstalledImpl: async () => {} },
    );
    assert.equal(Object.hasOwn(out.serverEnv, 'DATABASE_URL'), false);
    assert.equal(out.serverEnv.HAPPIER_SERVER_FLAVOR, 'light');
    assert.equal(out.serverEnv.HAPPY_SERVER_FLAVOR, 'light');
  });
});

function createWatcherOptions(serverDir, overrides = {}) {
  return {
    enabled: true,
    stackMode: true,
    serverComponentName: 'happier-server-light',
    serverDir,
    serverPort: 34567,
    internalServerUrl: 'http://127.0.0.1:34567',
    serverScript: 'dev:light',
    serverEnv: {},
    runtimeStatePath: join(serverDir, 'stack.runtime.json'),
    stackName: 'watch-test',
    envPath: join(serverDir, 'env'),
    children: [],
    serverProcRef: { current: { pid: process.pid, exitCode: null } },
    isShuttingDown: () => false,
    ...overrides,
  };
}

function createChangingSignatureReader() {
  let value = 0;
  return () => String(value++);
}

test('server restart preflight validates runtime sources without using the test-aware package build', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({
      private: true,
      scripts: {
        build: 'full-package-typecheck',
        'typecheck:runtime': 'runtime-only-typecheck',
      },
    }));
    const directProcessCalls = [];
    const packageManagerCalls = [];

    const result = await preflightDevServerRestart(
      { serverDir, serverEnv: {}, logger: { log() {} } },
      {
        runImpl: async (command, args, options) => {
          directProcessCalls.push({ command, args, cwd: options.cwd });
        },
        pmExecBinImpl: async (input) => packageManagerCalls.push(input),
      },
    );

    assert.deepEqual(result, { ran: true, reason: 'runtime-typecheck-ok' });
    assert.deepEqual(directProcessCalls, []);
    assert.equal(packageManagerCalls.length, 1);
    assert.equal(packageManagerCalls[0].dir, serverDir);
    assert.equal(packageManagerCalls[0].bin, 'typecheck:runtime');
    assert.deepEqual(packageManagerCalls[0].args, []);
    assert.equal(packageManagerCalls[0].quiet, false);
    assert.equal(packageManagerCalls[0].env.HAPPIER_STACK_SKIP_REFRESH_DEPS, '1');

    await writeFile(join(serverDir, 'package.json'), JSON.stringify({
      private: true,
      scripts: { build: 'full-package-typecheck' },
    }));
    directProcessCalls.length = 0;
    packageManagerCalls.length = 0;
    const fallback = await preflightDevServerRestart(
      { serverDir, serverEnv: {}, logger: { log() {} } },
      {
        runImpl: async (command, args, options) => {
          directProcessCalls.push({ command, args, cwd: options.cwd });
        },
        pmExecBinImpl: async (input) => packageManagerCalls.push(input),
      },
    );
    assert.deepEqual(fallback, { ran: true, reason: 'build-ok' });
    assert.deepEqual(directProcessCalls, []);
    assert.equal(packageManagerCalls.length, 1);
    assert.equal(packageManagerCalls[0].bin, 'build');
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
        logger: { log() {} },
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
        logger: { log() {} },
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
        logger: { log() {} },
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
      await preflightDevServerRestart({ serverDir, serverEnv, logger: { log() {} } }, boundary),
      { ran: false, reason: 'already-done' },
    );
    assert.equal(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.deepEqual(
      await preflightDevServerRestart({ serverDir, serverEnv, logger: { log() {} } }, boundary),
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
        { serverDir, serverEnv, logger: { log() {} } },
        { pmExecBinImpl: async () => { packageManagerCalls += 1; } },
      ),
      { ran: false, reason: 'disabled' },
    );
    assert.equal(serverEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(packageManagerCalls, 0);
  });
});

test('server runtime reconciliation and restart stop reuse one listener observation scope', async () => {
  let listenerObservations = 0;
  const listListenPidsImpl = async () => {
    listenerObservations += 1;
    return [];
  };
  const observationScope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 50,
    listListenPidsImpl,
  });

  const pid = await resolveStackOwnedServerRuntimePid(
    {
      runtimeStatePath: '/tmp/stack.runtime.json',
      serverPort: 34567,
      stackName: 'watch-test',
      envPath: '/tmp/watch-test.env',
    },
    {
      readStackRuntimeStateFileImpl: async () => ({ processes: { serverPid: 201 } }),
      isPidAliveImpl: () => true,
      isPidOwnedByStackImpl: async () => true,
      listListenPidsImpl,
      getProcessGroupIdImpl: async () => 201,
      observationScope,
    },
  );

  assert.equal(pid, null);
  assert.equal(listenerObservations, 1);

  let restartListenerObservations = 0;
  let bindingProbes = 0;
  let separateAvailabilityChecks = 0;
  const restartObservationScope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 50,
    listListenPidsImpl: async () => {
      restartListenerObservations += 1;
      return [];
    },
    probeTcpPortBindingImpl: async () => {
      bindingProbes += 1;
      return { status: 'free' };
    },
  });

  await assert.rejects(
    () => stopStackOwnedServerForRestart(
      {
        serverPort: 34567,
        runtimeStatePath: '/tmp/stack.runtime.json',
        stackName: 'watch-test',
        envPath: '/tmp/watch-test.env',
      },
      {
        readStackRuntimeStateFileImpl: async () => ({ processes: { serverPid: 201 } }),
        isPidAliveImpl: () => true,
        isPidOwnedByStackImpl: async () => true,
        getProcessGroupIdImpl: async () => null,
        isTcpPortFreeImpl: async () => {
          separateAvailabilityChecks += 1;
          throw new Error('separate listener deadline must not run');
        },
        listenerObservationScope: restartObservationScope,
      },
    ),
    /still alive.*no listener proof/i,
  );

  assert.equal(restartListenerObservations, 1);
  assert.equal(bindingProbes, 1);
  assert.equal(separateAvailabilityChecks, 0);
});

test('server runtime adoption refreshes an expired preflight listener observation', async () => {
  let now = 1_000;
  let currentListenPids = [];
  const preflightScope = createListenerOwnershipObservationScope({
    totalTimeoutMs: 50,
    nowImpl: () => now,
    listListenPidsImpl: async () => currentListenPids,
  });

  assert.deepEqual(await preflightScope.observe(34567), {
    status: 'ok',
    supported: true,
    pids: [],
  });
  now += 100;
  currentListenPids = [301];

  const pid = await resolveStackOwnedServerRuntimePid(
    {
      runtimeStatePath: '/tmp/stack.runtime.json',
      serverPort: 34567,
      stackName: 'watch-test',
      envPath: '/tmp/watch-test.env',
    },
    {
      readStackRuntimeStateFileImpl: async () => ({ processes: {} }),
      isPidOwnedByStackImpl: async (candidatePid) => candidatePid === 301,
      listListenPidsImpl: async () => currentListenPids,
      observationScope: preflightScope,
    },
  );

  assert.equal(pid, 301);
});

test('startDevServer cleans up a spawned child when ownership proof fails', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    const ownershipKills = [];
    const updates = [];

    await assert.rejects(
      () =>
        startDevServer(
          {
            serverComponentName: 'happier-server-light',
            serverDir,
            autostart: { stackName: 'watch-test', baseDir: serverDir },
            baseEnv: {
              HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
              HAPPIER_STACK_PRISMA_PUSH: '0',
              HAPPIER_STACK_MANAGED_INFRA: '0',
              HAPPIER_STACK_PRISMA_MIGRATE: '0',
              HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200',
            },
            serverPort: 34567,
            internalServerUrl: 'http://127.0.0.1:34567',
            publicServerUrl: 'http://127.0.0.1:34567',
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
            pmSpawnScriptImpl: async () => ({ pid: 201, exitCode: null }),
            waitForServerReadyImpl: async () => {},
            listListenPidsImpl: async () => [],
            getProcessGroupIdImpl: async () => 201,
            killProcessGroupOwnedByStackImpl: async (pid, options) => {
              ownershipKills.push({ pid, options });
              return { killed: true };
            },
            terminateSpawnedChildImpl: async () => assert.fail('successful ownership cleanup must not call fallback'),
            recordStackRuntimeUpdateImpl: async (_path, patch) => {
              updates.push(patch);
            },
          }
        ),
      /ownership could not be proven/
    );

    assert.deepEqual(children, []);
    assert.deepEqual(ownershipKills, [{
      pid: 201,
      options: {
        stackName: 'watch-test',
        envPath: join(serverDir, 'env'),
        label: 'server',
        json: false,
        graceMs: 1450,
      },
    }]);
    assert.deepEqual(updates, []);
  });
});

test('startDevServer surfaces typed cleanup-incomplete truth when provisional termination is unconfirmed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const child = { pid: 201, exitCode: null };
    const children = [];

    await assert.rejects(
      () => startDevServer(
        {
          serverComponentName: 'happier-server-light',
          serverDir,
          autostart: { stackName: 'watch-test', baseDir: serverDir },
          baseEnv: {
            HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
            HAPPIER_STACK_PRISMA_PUSH: '0',
            HAPPIER_STACK_MANAGED_INFRA: '0',
            HAPPIER_STACK_PRISMA_MIGRATE: '0',
          },
          serverPort: 34567,
          internalServerUrl: 'http://127.0.0.1:34567',
          publicServerUrl: 'http://127.0.0.1:34567',
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
          pmSpawnScriptImpl: async () => child,
          waitForServerReadyImpl: async () => {},
          listListenPidsImpl: async () => [],
          getProcessGroupIdImpl: async () => 201,
          killProcessGroupOwnedByStackImpl: async () => ({ killed: false, reason: 'not_owned' }),
          terminateSpawnedChildImpl: async () => false,
        },
      ),
      (error) => error?.code === 'ESERVERPROVISIONINGCLEANUPINCOMPLETE'
        && /ownership could not be proven/.test(String(error?.cause?.message)),
    );

    assert.deepEqual(children, [child], 'unconfirmed child ownership must remain visible for operator attention');
  });
});

for (const observation of [
  { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' },
  { status: 'unsupported', supported: false, pids: [], reason: 'missing-listener-discovery-command' },
  { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' },
]) {
  test(`startDevServer preserves typed ${observation.status} listener evidence through readiness ownership`, async (t) => {
    await withTempServerDir(t, async (serverDir) => {
      const children = [];
      let typedObservations = 0;

      await assert.rejects(
        () => startDevServer(
          {
            serverComponentName: 'happier-server-light',
            serverDir,
            autostart: { stackName: 'watch-test', baseDir: serverDir },
            baseEnv: {
              HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
              HAPPIER_STACK_PRISMA_PUSH: '0',
              HAPPIER_STACK_MANAGED_INFRA: '0',
              HAPPIER_STACK_PRISMA_MIGRATE: '0',
            },
            serverPort: 34567,
            internalServerUrl: 'http://127.0.0.1:34567',
            publicServerUrl: 'http://127.0.0.1:34567',
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
            pmSpawnScriptImpl: async () => ({ pid: 201, exitCode: null }),
            waitForServerReadyImpl: async () => {},
            // Exercise the production compatibility function identity. The canonical
            // typed boundary must win; custom legacy test adapters remain injectable.
            listListenPidsImpl: listListenPids,
            listListenPidsWithStatusImpl: async () => {
              typedObservations += 1;
              return observation;
            },
            getProcessGroupIdImpl: async () => null,
            listenerOwnershipTimeoutMs: 20,
            listenerOwnershipRetryDelayMs: 0,
            killProcessGroupOwnedByStackImpl: async () => ({ killed: true }),
            recordStackRuntimeUpdateImpl: async () => {},
          },
        ),
        (error) => error?.code === 'ELISTENERDISCOVERYINCONCLUSIVE'
          && error?.observation?.status === observation.status
          && error?.observation?.reason === observation.reason,
      );

      assert.ok(typedObservations > 0);
      assert.deepEqual(children, []);
    });
  });
}

test('startDevServer accepts process-group-scoped listener proof when broad discovery times out after readiness', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    const observations = [];
    const updates = [];
    let spawnOnLine = null;

    const out = await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          HAPPIER_STACK_PRISMA_PUSH: '0',
          HAPPIER_STACK_MANAGED_INFRA: '0',
          HAPPIER_STACK_PRISMA_MIGRATE: '0',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
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
        pmSpawnScriptImpl: async ({ options }) => {
          spawnOnLine = options?.onLine;
          spawnOnLine?.({ line: '{"happierStackTransition":"migration_started"}' });
          return { pid: 201, exitCode: null };
        },
        waitForServerReadyImpl: async (_url, options) => {
          assert.equal(options?.startupDeadline?.getPhase(), 'migration');
          spawnOnLine?.({ line: '{"happierStackTransition":"migration_completed"}' });
          assert.equal(options?.startupDeadline?.getPhase(), 'readiness');
        },
        listListenPidsImpl: listListenPids,
        listListenPidsWithStatusImpl: async (_port, options) => {
          observations.push(options);
          return options?.processGroupId === 201
            ? { status: 'ok', supported: true, pids: [301] }
            : { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
        },
        getProcessGroupIdImpl: async (pid) => [201, 301].includes(Number(pid)) ? 44 : null,
        listenerOwnershipTimeoutMs: 20,
        listenerOwnershipRetryDelayMs: 0,
        recordStackRuntimeUpdateImpl: async (_path, patch) => {
          updates.push(patch);
        },
      },
    );

    assert.equal(out.serverProc.pid, 201);
    assert.equal(typeof spawnOnLine, 'function');
    assert.ok(observations.some((options) => options?.processGroupId === 201));
    assert.deepEqual(children, [out.serverProc]);
    assert.deepEqual(updates, [expectedDirectServerRuntimePatch({ listenerPid: 301, wrapperPid: 201 })]);
  });
});

test('startDevServer retries transient process-group listener discovery before rejecting a ready server', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    let processGroupObservations = 0;

    const out = await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          HAPPIER_STACK_PRISMA_PUSH: '0',
          HAPPIER_STACK_MANAGED_INFRA: '0',
          HAPPIER_STACK_PRISMA_MIGRATE: '0',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
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
        pmSpawnScriptImpl: async () => ({ pid: 201, exitCode: null }),
        waitForServerReadyImpl: async () => {},
        listListenPidsImpl: listListenPids,
        listListenPidsWithStatusImpl: async (_port, options) => {
          if (options?.processGroupId === 201) {
            processGroupObservations += 1;
            return processGroupObservations === 1
              ? { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' }
              : { status: 'ok', supported: true, pids: [301] };
          }
          return { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
        },
        getProcessGroupIdImpl: async () => null,
        listenerOwnershipTimeoutMs: 750,
        listenerOwnershipRetryDelayMs: 0,
        recordStackRuntimeUpdateImpl: async () => {},
      },
    );

    assert.equal(out.serverProc.pid, 201);
    assert.equal(processGroupObservations, 2);
    assert.deepEqual(children, [out.serverProc]);
  });
});

test('startDevServer directly terminates a spawned child when marker cleanup refuses', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    const killedPids = [];
    const directlyKilled = [];

    await assert.rejects(
      () =>
        startDevServer(
          {
            serverComponentName: 'happier-server-light',
            serverDir,
            autostart: { stackName: 'watch-test', baseDir: serverDir },
            baseEnv: {
              HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
              HAPPIER_STACK_PRISMA_PUSH: '0',
              HAPPIER_STACK_MANAGED_INFRA: '0',
              HAPPIER_STACK_PRISMA_MIGRATE: '0',
            },
            serverPort: 34567,
            internalServerUrl: 'http://127.0.0.1:34567',
            publicServerUrl: 'http://127.0.0.1:34567',
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
            pmSpawnScriptImpl: async () => ({ pid: 201, exitCode: null }),
            waitForServerReadyImpl: async () => {},
            listListenPidsImpl: async () => [],
            getProcessGroupIdImpl: async () => 201,
            killProcessGroupOwnedByStackImpl: async (pid) => {
              killedPids.push(pid);
              return { killed: false, reason: 'not_owned' };
            },
            terminateSpawnedChildImpl: async (child) => {
              directlyKilled.push({ pid: child?.pid });
              return true;
            },
            recordStackRuntimeUpdateImpl: async () => {},
          }
        ),
      /ownership could not be proven/
    );

    assert.deepEqual(children, []);
    assert.deepEqual(killedPids, [201]);
    assert.deepEqual(directlyKilled, [{ pid: 201 }]);
  });
});

test('spawned-child cleanup delegates to the canonical async tree terminator', async () => {
  const child = { pid: 201, exitCode: null };
  const treeSignals = [];

  const terminated = await terminateSpawnedChildForCleanup(child, {
    env: { HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200' },
    async killSpawnedChildImpl(_child, signal, options) {
      treeSignals.push([signal, options]);
      child.exitCode = 0;
      return { ok: true, signal };
    },
  });

  assert.equal(terminated, true);
  assert.deepEqual(treeSignals, [['SIGTERM', { graceMs: 1450 }]]);
});

test('startDevServer skips stack restart cleanup when existing server health check failed', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const order = [];
    const children = [];
    let stopInput = null;

    const out = await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          HAPPIER_STACK_PRISMA_PUSH: '0',
          HAPPIER_STACK_MANAGED_INFRA: '0',
          HAPPIER_STACK_PRISMA_MIGRATE: '0',
          HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '1200',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: true,
        children,
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => {
          order.push('deps');
        },
        ensureSourceServerWorkspacePackagesBuiltImpl: async () => {
          order.push('workspace');
        },
        preflightDevServerRestartImpl: async () => {
          order.push('preflight');
          return { ran: true, reason: 'runtime-typecheck-ok' };
        },
        stopStackOwnedServerForRestartImpl: async (input) => {
          order.push('stop');
          stopInput = input;
        },
        pmSpawnScriptImpl: async () => {
          order.push('spawn');
          return { pid: 201, exitCode: null };
        },
        waitForServerReadyImpl: async () => {
          order.push('ready');
        },
        listListenPidsImpl: async () => [201],
        getProcessGroupIdImpl: async () => 201,
        recordStackRuntimeUpdateImpl: async () => {
          order.push('record');
        },
      }
    );

    assert.equal(out.serverProc.pid, 201);
    assert.deepEqual(order, ['deps', 'preflight', 'spawn', 'ready', 'record']);
    assert.equal(stopInput, null);
  });
});

test('stack restart consumes the parent preflight marker from server and long-lived orchestration environments', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({
      private: true,
      scripts: { 'typecheck:runtime': 'runtime-only-typecheck' },
    }));
    const baseEnv = {
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_PRISMA_PUSH: '0',
      HAPPIER_STACK_MANAGED_INFRA: '0',
      HAPPIER_STACK_PRISMA_MIGRATE: '0',
      HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE: '1',
    };
    let workspaceAdmissions = 0;
    let spawnedEnv;

    await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv,
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
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
        stopStackOwnedServerForRestartImpl: async () => {},
        pmSpawnScriptImpl: async ({ env }) => {
          spawnedEnv = env;
          return { pid: 201, exitCode: null };
        },
        waitForServerReadyImpl: async () => {},
        listListenPidsImpl: async () => [201],
        getProcessGroupIdImpl: async () => 201,
        recordStackRuntimeServerActivationImpl: async () => {},
      },
    );

    assert.equal(spawnedEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(workspaceAdmissions, 1, 'already-completed preflight must fall back to source declaration admission');
  });
});

test('disabled stack restart cannot preserve the parent preflight marker', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const baseEnv = {
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_PRISMA_PUSH: '0',
      HAPPIER_STACK_MANAGED_INFRA: '0',
      HAPPIER_STACK_PRISMA_MIGRATE: '0',
      HAPPIER_STACK_SERVER_RESTART_PREFLIGHT: '0',
      HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE: '1',
    };
    let workspaceAdmissions = 0;
    let spawnedEnv;

    await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv,
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
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
        stopStackOwnedServerForRestartImpl: async () => {},
        pmSpawnScriptImpl: async ({ env }) => {
          spawnedEnv = env;
          return { pid: 201, exitCode: null };
        },
        waitForServerReadyImpl: async () => {},
        listListenPidsImpl: async () => [201],
        getProcessGroupIdImpl: async () => 201,
        recordStackRuntimeServerActivationImpl: async () => {},
      },
    );

    assert.equal(spawnedEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE, undefined);
    assert.equal(workspaceAdmissions, 1, 'disabled preflight must fall back to source declaration admission');
  });
});

test('stack restart admits source declarations once when runtime preflight has no build script', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({ private: true, scripts: {} }));
    const calls = [];
    await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: { HAPPIER_STACK_PRISMA_PUSH: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
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
          return { pid: 201, exitCode: null };
        },
        waitForServerReadyImpl: async () => {},
        listListenPidsImpl: async () => [201],
        getProcessGroupIdImpl: async () => 201,
        recordStackRuntimeServerActivationImpl: async () => {},
      },
    );

    assert.deepEqual(calls, ['missing-build-script', 'workspace', 'spawn']);
  });
});

test('startDevServer records the listener pid separately from the spawned wrapper pid', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const children = [];
    const updates = [];
    const calls = [];

    const out = await startDevServer(
      {
        serverComponentName: 'happier-server-light',
        serverDir,
        autostart: { stackName: 'watch-test', baseDir: serverDir },
        baseEnv: {
          HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
          HAPPIER_STACK_PRISMA_PUSH: '0',
          HAPPIER_STACK_MANAGED_INFRA: '0',
          HAPPIER_STACK_PRISMA_MIGRATE: '0',
        },
        serverPort: 34567,
        internalServerUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'http://127.0.0.1:34567',
        envPath: join(serverDir, 'env'),
        stackMode: true,
        runtimeStatePath: join(serverDir, 'stack.runtime.json'),
        serverAlreadyRunning: false,
        restart: false,
        children,
        quiet: true,
      },
      {
        ensureDepsInstalledImpl: async () => { calls.push('deps'); },
        ensureSourceServerWorkspacePackagesBuiltImpl: async ({ serverDir: admittedDir }) => {
          calls.push('workspace');
          assert.equal(admittedDir, serverDir);
        },
        pmSpawnScriptImpl: async () => {
          calls.push('spawn');
          return { pid: 201, exitCode: null };
        },
        waitForServerReadyImpl: async () => {},
        listListenPidsImpl: async () => [301],
        getProcessGroupIdImpl: async (pid) => (Number(pid) === 201 || Number(pid) === 301 ? 44 : Number(pid)),
        recordStackRuntimeUpdateImpl: async (_path, patch) => {
          updates.push(patch);
        },
      }
    );

    assert.equal(out.serverProc.pid, 201);
    assert.deepEqual(calls, ['deps', 'workspace', 'spawn']);
    assert.deepEqual(updates, [expectedDirectServerRuntimePatch({ listenerPid: 301, wrapperPid: 201 })]);
  });
});

for (const mode of ['direct', 'proxy', 'directFallback']) {
  test(`startDevServer surfaces ${mode} runtime publication failure without terminating the active child`, async (t) => {
    await withTempServerDir(t, async (serverDir) => {
      const child = { pid: 201, exitCode: null };
      const children = [];
      const killedPids = [];

      await assert.rejects(
        () => startDevServer(
          {
            serverComponentName: 'happier-server-light',
            serverDir,
            autostart: { stackName: 'watch-test', baseDir: serverDir },
            baseEnv: {
              HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
              HAPPIER_STACK_PRISMA_PUSH: '0',
              HAPPIER_STACK_MANAGED_INFRA: '0',
              HAPPIER_STACK_PRISMA_MIGRATE: '0',
            },
            serverPort: 34567,
            serverBindPort: mode === 'proxy' ? 34568 : 34567,
            internalServerUrl: `http://127.0.0.1:${mode === 'proxy' ? 34568 : 34567}`,
            publicServerUrl: 'http://127.0.0.1:34567',
            envPath: join(serverDir, 'env'),
            stackMode: true,
            runtimeStatePath: join(serverDir, 'stack.runtime.json'),
            serverAlreadyRunning: false,
            restart: false,
            children,
            quiet: true,
            serverProxyRuntime: mode === 'proxy'
              ? { enabled: true, proxyPid: 401, mode: 'proxy' }
              : mode === 'directFallback'
                ? { enabled: true, proxyPid: null, mode: 'directFallback', fallbackReason: 'proxy unavailable' }
                : null,
          },
          {
            ensureDepsInstalledImpl: async () => {},
            pmSpawnScriptImpl: async () => child,
            waitForServerReadyImpl: async () => {},
            listListenPidsImpl: async () => [301],
            getProcessGroupIdImpl: async (pid) => [201, 301].includes(Number(pid)) ? 44 : Number(pid),
            killProcessGroupOwnedByStackImpl: async (pid) => {
              killedPids.push(pid);
              return { killed: true };
            },
            recordStackRuntimeUpdateImpl: async () => {
              throw new Error('runtime publication unavailable');
            },
          },
        ),
        (error) => error?.code === 'ESERVERRUNTIMEPROJECTION'
          && error?.serverActivationCommitted === true
          && error?.authoritativeServerPid === 301
          && error?.serverMode === mode,
      );

      assert.deepEqual(children, [child]);
      assert.deepEqual(killedPids, []);
    });
  });
}
