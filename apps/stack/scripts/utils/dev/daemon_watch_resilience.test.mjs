import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createHappyCliReloadExecutor,
  ensureDevCliReady,
  startDevDaemon,
  watchHappyCliAndRestartDaemon,
} from './daemon.mjs';

async function writeDistBuildManifestForTest(distIndexPath, fingerprint = '1111111111111111') {
  await writeFile(
    join(dirname(distIndexPath), '.build-manifest.json'),
    JSON.stringify({
      fingerprint,
      builtAt: '2026-07-09T00:00:00.000Z',
      fileCount: 1,
      toolVersion: '1',
    }) + '\n',
    'utf-8',
  );
}

test('watch onChange does not throw when daemon restart fails', async () => {
  let capturedOnChange = null;
  let restartCalls = 0;
  let buildCalls = 0;

  const watcher = watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => {
        buildCalls += 1;
        return { built: true, reason: 'test' };
      },
      startLocalDaemonWithAuthImpl: async () => {
        restartCalls += 1;
        throw new Error('restart failed');
      },
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    }
  );

  assert.ok(watcher);
  assert.equal(typeof capturedOnChange, 'function');

  await assert.doesNotReject(async () => {
    await capturedOnChange({ eventType: 'change', filename: 'foo.ts' });
  });

  assert.equal(buildCalls, 1);
  assert.equal(restartCalls, 1);
});

test('ensureDevCliReady rejects bare dist entrypoint without build manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-cli-ready-manifest-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndexPath), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await writeFile(distIndexPath, 'export const stale = true;\n', 'utf-8');

  await assert.rejects(
    () => ensureDevCliReady({
      cliDir,
      buildCli: false,
      env: {
        ...process.env,
        HAPPIER_STACK_CLI_BUILD_MODE: 'never',
      },
    }),
    /build manifest/,
  );

  await writeDistBuildManifestForTest(distIndexPath);
  await assert.doesNotReject(() => ensureDevCliReady({
    cliDir,
    buildCli: false,
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_BUILD_MODE: 'never',
    },
  }));
});

test('reload executor rejects bare dist entrypoint without build manifest', async () => {
  const cliDir = '/tmp/repo/apps/cli';
  const executor = createHappyCliReloadExecutor(
    {
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: `${cliDir}/bin/happier.mjs`,
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      existsSyncImpl: (path) => String(path).endsWith('/dist/index.mjs'),
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  await assert.rejects(() => executor.build(), /build manifest/);
});

test('watch retries restart when a pending change arrives during a failed restart', async () => {
  let capturedOnChange = null;
  let restartCalls = 0;
  let buildCalls = 0;

  const watcher = watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => {
        buildCalls += 1;
        return { built: true, reason: 'test' };
      },
      startLocalDaemonWithAuthImpl: async () => {
        restartCalls += 1;
        if (restartCalls === 1) {
          await capturedOnChange({ eventType: 'change', filename: 'second-change.ts' });
          throw new Error('restart failed');
        }
      },
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    }
  );

  assert.ok(watcher);
  assert.equal(typeof capturedOnChange, 'function');

  await assert.doesNotReject(async () => {
    await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });
  });

  assert.equal(buildCalls, 2);
  assert.equal(restartCalls, 2);
});

test('watch rebuilds and restarts again when a source change arrives during a successful build', async () => {
  let capturedOnChange = null;
  let restartCalls = 0;
  let buildCalls = 0;

  const watcher = watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => {
        buildCalls += 1;
        if (buildCalls === 1) {
          await capturedOnChange({ eventType: 'change', filename: 'second-change.ts' });
        }
        return { built: true, reason: 'test' };
      },
      startLocalDaemonWithAuthImpl: async () => {
        restartCalls += 1;
      },
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    }
  );

  assert.ok(watcher);
  assert.equal(typeof capturedOnChange, 'function');

  await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

  assert.equal(buildCalls, 2);
  assert.equal(restartCalls, 2);
});

test('startDevDaemon forwards stack context to daemon startup', async () => {
  let capturedArgs = null;

  await startDevDaemon(
    {
      startDaemon: true,
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      restart: true,
      isShuttingDown: () => false,
      env: { TEST_ENV: '1' },
      stackName: 'dev',
      cliIdentity: 'reviewer',
    },
    {
      startLocalDaemonWithAuthImpl: async (args) => {
        capturedArgs = args;
      },
    }
  );

  assert.ok(capturedArgs);
  assert.equal(capturedArgs.forceRestart, true);
  assert.equal(capturedArgs.stackName, 'dev');
  assert.equal(capturedArgs.cliIdentity, 'reviewer');
  assert.equal(capturedArgs.env?.TEST_ENV, '1');
});

test('watch forwards stack context to daemon restart', async () => {
  let capturedOnChange = null;
  let restartArgs = null;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      env: { TEST_ENV: '1' },
      stackName: 'dev',
      cliIdentity: 'reviewer',
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      startLocalDaemonWithAuthImpl: async (args) => {
        restartArgs = args;
      },
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    }
  );

  assert.equal(typeof capturedOnChange, 'function');
  await capturedOnChange({ eventType: 'change', filename: 'foo.ts' });

  assert.ok(restartArgs);
  assert.equal(restartArgs.forceRestart, false);
  assert.equal(restartArgs.stackName, 'dev');
  assert.equal(restartArgs.cliIdentity, 'reviewer');
  assert.equal(restartArgs.env?.TEST_ENV, '1');
});

test('watch uses daemon control restart for a pingable running daemon and syncs runtime state', async () => {
  let capturedOnChange = null;
  let coldStartCalls = 0;
  let controlRestartCalls = 0;
  let syncCalls = 0;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath: '/tmp/stack.runtime.json',
      isShuttingDown: () => false,
      env: { TEST_ENV: '1' },
      stackName: 'dev',
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async (args) => {
        controlRestartCalls += 1;
        assert.equal(args.cliHomeDir, '/tmp/happy-cli-home');
        assert.equal(args.internalServerUrl, 'http://127.0.0.1:3009');
        assert.equal(args.stackName, 'dev');
        assert.equal(Object.prototype.hasOwnProperty.call(args, 'restartSessionRunners'), false);
      },
      syncStackRuntimeDaemonPidFromDaemonStateImpl: async (args) => {
        syncCalls += 1;
        assert.equal(args.runtimeStatePath, '/tmp/stack.runtime.json');
      },
      startLocalDaemonWithAuthImpl: async () => {
        coldStartCalls += 1;
      },
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.equal(typeof capturedOnChange, 'function');
  await capturedOnChange({ eventType: 'change', filename: 'foo.ts' });

  assert.equal(controlRestartCalls, 1);
  assert.equal(syncCalls, 1);
  assert.equal(coldStartCalls, 0);
});

test('watch falls back to cold start without stopping an existing running daemon', async () => {
  let capturedOnChange = null;
  let coldStartCalls = 0;
  let controlRestartCalls = 0;
  let coldStartArgs = null;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      pingDaemonImpl: async () => ({ ok: false, reason: 'missing_state' }),
      restartDaemonViaControlServerImpl: async () => {
        controlRestartCalls += 1;
      },
      startLocalDaemonWithAuthImpl: async (args) => {
        coldStartCalls += 1;
        coldStartArgs = args;
      },
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.equal(typeof capturedOnChange, 'function');
  await capturedOnChange({ eventType: 'change', filename: 'foo.ts' });

  assert.equal(controlRestartCalls, 0);
  assert.equal(coldStartCalls, 1);
  assert.equal(coldStartArgs?.preserveExistingRunning, true);
});

test('watch keeps existing daemon when daemon control restart is unavailable', async () => {
  let capturedOnChange = null;
  let coldStartCalls = 0;
  let controlRestartCalls = 0;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      pingDaemonImpl: async () => ({ ok: true, pid: 111 }),
      restartDaemonViaControlServerImpl: async () => {
        controlRestartCalls += 1;
        const error = new Error('daemon control /restart failed (http 501): {"status":"restart_unavailable"}');
        error.daemonControlPath = '/restart';
        error.status = 501;
        throw error;
      },
      startLocalDaemonWithAuthImpl: async () => {
        coldStartCalls += 1;
      },
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.equal(typeof capturedOnChange, 'function');
  await capturedOnChange({ eventType: 'change', filename: 'foo.ts' });

  assert.equal(controlRestartCalls, 1);
  assert.equal(coldStartCalls, 0);
});

test('watch keeps a live runtime daemon when daemon control state is temporarily missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-runtime-live-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runtimeStatePath = join(root, 'stack.runtime.json');
  await writeFile(
    runtimeStatePath,
    JSON.stringify({ processes: { daemonPid: 4242, daemonPids: [4242] } }),
    'utf-8',
  );

  let capturedOnChange = null;
  let coldStartCalls = 0;
  let controlRestartCalls = 0;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      runtimeStatePath,
      isShuttingDown: () => false,
      stackName: 'dev',
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      pingDaemonImpl: async () => ({ ok: false, reason: 'missing_state' }),
      restartDaemonViaControlServerImpl: async () => {
        controlRestartCalls += 1;
      },
      startLocalDaemonWithAuthImpl: async () => {
        coldStartCalls += 1;
      },
      isPidAliveImpl: (pid) => pid === 4242,
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.equal(typeof capturedOnChange, 'function');
  await capturedOnChange({ eventType: 'change', filename: 'foo.ts' });

  assert.equal(controlRestartCalls, 0);
  assert.equal(coldStartCalls, 0);
});

test('watch ignores no-op manifest events without missing real source edits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-watch-noop-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const cliSrcDir = join(cliDir, 'src');
  const cliDistIndex = join(cliDir, 'dist', 'index.mjs');
  await mkdir(cliSrcDir, { recursive: true });
  await mkdir(dirname(cliDistIndex), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "@happier-dev/cli" }\n', 'utf-8');
  await writeFile(join(cliSrcDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
  await writeFile(cliDistIndex, 'export const daemon = true;\n', 'utf-8');

  let capturedOnChange = null;
  let buildCalls = 0;
  let restartCalls = 0;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir,
      cliBin: join(cliDir, 'bin', 'happier.mjs'),
      cliHomeDir: join(root, 'home'),
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      watchDebouncedImpl: ({ onChange }) => {
        capturedOnChange = onChange;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => {
        buildCalls += 1;
        return { built: true, reason: 'test' };
      },
      startLocalDaemonWithAuthImpl: async () => {
        restartCalls += 1;
      },
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.equal(typeof capturedOnChange, 'function');

  await capturedOnChange({ eventType: 'change', filename: 'package.json' });
  assert.equal(buildCalls, 0);
  assert.equal(restartCalls, 0);

  await writeFile(join(cliSrcDir, 'index.ts'), 'export const value = 200;\n', 'utf-8');
  await capturedOnChange({ eventType: 'change', filename: 'index.ts' });
  assert.equal(buildCalls, 1);
  assert.equal(restartCalls, 1);
});

test('watch does not include cliDir/yarn.lock in watched paths (prevents rebuild loops)', async () => {
  let capturedPaths = null;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/happy-cli',
      cliBin: '/tmp/happy-cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      watchDebouncedImpl: ({ paths }) => {
        capturedPaths = paths;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      startLocalDaemonWithAuthImpl: async () => {},
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.ok(Array.isArray(capturedPaths));
  assert.ok(!capturedPaths.includes('/tmp/happy-cli/yarn.lock'));
});

test('watch includes shared CLI runtime packages so daemon restarts on shared source edits', async () => {
  let capturedPaths = null;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
    },
    {
      watchDebouncedImpl: ({ paths }) => {
        capturedPaths = paths;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      startLocalDaemonWithAuthImpl: async () => {},
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.ok(Array.isArray(capturedPaths));
  assert.ok(capturedPaths.includes('/tmp/repo/packages/agents/src'));
  assert.ok(capturedPaths.includes('/tmp/repo/packages/cli-common/src'));
  assert.ok(capturedPaths.includes('/tmp/repo/packages/protocol/src'));
});

test('watch forwards signature polling to watchDebounced so missed CLI fs events still reload', async () => {
  let capturedWatchOptions = null;
  let signatureReads = 0;

  watchHappyCliAndRestartDaemon(
    {
      enabled: true,
      startDaemon: true,
      buildCli: true,
      cliDir: '/tmp/repo/apps/cli',
      cliBin: '/tmp/repo/apps/cli/bin/happier.mjs',
      cliHomeDir: '/tmp/happy-cli-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      publicServerUrl: 'http://localhost:3009',
      isShuttingDown: () => false,
      env: { HAPPIER_STACK_DEV_RELOAD_POLL_MS: '17' },
    },
    {
      watchDebouncedImpl: (options) => {
        capturedWatchOptions = options;
        return { close() {} };
      },
      ensureCliBuiltImpl: async () => ({ built: true, reason: 'test' }),
      startLocalDaemonWithAuthImpl: async () => {},
      readWatchChangeSignatureImpl: () => `signature-${++signatureReads}`,
      existsSyncImpl: () => true,
      logger: { log() {}, warn() {}, error() {} },
    },
  );

  assert.equal(capturedWatchOptions?.pollIntervalMs, 17);
  assert.equal(typeof capturedWatchOptions?.readSignature, 'function');
  assert.equal(capturedWatchOptions.readSignature(), 'signature-2');
});

test('ensureDevCliReady keeps existing dist output when build fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-daemon-cli-ready-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const binDir = join(root, 'bin');
  const distIndexPath = join(cliDir, 'dist', 'index.mjs');
  const yarnPath = join(binDir, 'yarn');

  await mkdir(dirname(distIndexPath), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await writeFile(distIndexPath, 'export const stable = true;\n', 'utf-8');
  await writeDistBuildManifestForTest(distIndexPath);
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build" ]; then',
      '  echo "simulated build failure" >&2',
      '  exit 2',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);

  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
  };
  await assert.doesNotReject(async () => {
    await ensureDevCliReady({ cliDir, buildCli: true, env });
  });
  const restored = await readFile(distIndexPath, 'utf-8');
  assert.equal(restored, 'export const stable = true;\n');
});
