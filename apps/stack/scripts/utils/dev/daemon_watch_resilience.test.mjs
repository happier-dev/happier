import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ensureDevCliReady, startDevDaemon, watchHappyCliAndRestartDaemon } from './daemon.mjs';

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
  assert.equal(restartArgs.stackName, 'dev');
  assert.equal(restartArgs.cliIdentity, 'reviewer');
  assert.equal(restartArgs.env?.TEST_ENV, '1');
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
      '  rm -rf dist',
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
