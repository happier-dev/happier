import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths } from '../expo/expo.mjs';
import {
  isIntentionalExpoTermination,
  resolveExpoRestartPolicy,
  resolveNextExpoRestartAttempt,
} from './expo_dev_supervision.mjs';
import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';

let listenerFixtureRoot = null;
let listenerFixtureBinDir = null;
let previousPath = null;

before(async () => {
  listenerFixtureRoot = await mkdtemp(join(tmpdir(), 'hstack-expo-crash-listener-boundary-'));
  const { binDir } = writeFakeBin({
    root: listenerFixtureRoot,
    name: 'lsof',
    content: `#!/bin/sh
port=''
for arg in "$@"; do case "$arg" in -iTCP:*) port="\${arg#-iTCP:}" ;; esac; done
owner_file="\${TEST_EXPO_LISTENER_DIR:-}/listener-$port"
if [ -f "$owner_file" ]; then
  /bin/cat "$owner_file"
  exit 0
fi
exit 1
`,
  });
  writeFakeBin({
    root: listenerFixtureRoot,
    name: 'ps',
    // Process-group lookup is an OS boundary; keep crash-supervision timing independent of host load.
    content: `#!/bin/sh
pid=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-p' ]; then shift; pid="$1"; fi
  shift
done
[ -n "$pid" ] || exit 1
echo "$pid"
`,
  });
  listenerFixtureBinDir = binDir;
  previousPath = process.env.PATH;
  process.env.PATH = buildStackHarnessEnv({ baseEnv: process.env, binDirs: [binDir] }).PATH;
});

after(async () => {
  if (previousPath == null) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (listenerFixtureRoot) await rm(listenerFixtureRoot, { recursive: true, force: true });
});

function buildCrashFixtureEnv(root, extraEnv) {
  return buildStackHarnessEnv({
    baseEnv: buildStackFixtureEnv({ baseEnv: process.env, stripStackEnv: true }),
    binDirs: [listenerFixtureBinDir],
    extraEnv: {
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      TEST_EXPO_LISTENER_DIR: root,
      ...extraEnv,
    },
  });
}

function killProcessTreeByPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return;
  try {
    process.kill(-n, 'SIGKILL');
  } catch {
    try {
      process.kill(n, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

async function waitForCondition(predicate, { timeoutMs = 15000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function readRunCount(runCountPath) {
  const raw = await readFile(runCountPath, 'utf-8').catch(() => '0');
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

test('ensureDevExpoServer resets the consecutive crash budget after a healthy Expo generation', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-oom-supervision-'));
  const children = [];
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const argsPath = join(tmp, 'expo-args.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const argsPath = process.env.FAKE_EXPO_ARGS_PATH;",
        "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
        "fs.writeFileSync(runCountPath, String(current));",
        "fs.appendFileSync(argsPath, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "const http = require('node:http');",
        "const server = http.createServer((req, res) => {",
        "  res.end(req.url === '/status' ? 'packager-status:running' : 'expo-owned');",
        "});",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "server.listen(port, '127.0.0.1', () => {",
        "  fs.writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/listener-' + port, String(process.pid));",
        "  if (current === 1) console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');",
        "});",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildCrashFixtureEnv(tmp, {
          FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
          FAKE_EXPO_ARGS_PATH: argsPath,
          HAPPIER_STACK_EXPO_CLEAR_CACHE: '0',
          HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
          HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
          HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
          HAPPIER_STACK_EXPO_RESTART_HEALTHY_RESET_MS: '2000',
      }),
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-expo-oom-supervision',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(Number.isFinite(result.port) && result.port > 0, true);
    assert.ok(result.proc, 'expected ensureDevExpoServer to return a tracked process handle');
    assert.equal(
      typeof result.proc.completion?.then,
      'function',
      'tracked Expo must expose the final raw child close and tee-finish boundary',
    );

    // The fake lsof boundary must stop advertising the listener when its owner exits.
    await rm(join(tmp, `listener-${result.port}`), { force: true });
    process.kill(children[0].pid, 'SIGABRT');
    await waitForCondition(async () => (await readRunCount(runCountPath)) >= 2);
    const spawnedArgs = (await readFile(argsPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(spawnedArgs.length, 2);
    assert.equal(spawnedArgs[0].includes('--clear'), false);
    assert.equal(spawnedArgs[1].includes('--clear'), true);
    assert.equal(children.length, 2);
    assert.equal(children[0].signalCode, 'SIGABRT');
    assert.equal(children[1].exitCode, null);
    await waitForCondition(() => result.pid === children[1].pid);
    assert.equal(result.pid, children[1].pid);
    assert.equal(result.proc.pid, children[1].pid);

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
    });
    await waitForCondition(async () => {
      try {
        const state = JSON.parse(await readFile(paths.statePath, 'utf-8'));
        return state.pid === children[1].pid;
      } catch {
        return false;
      }
    });
    const state = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(state.pid, children[1].pid);

    // A certified generation that stays up for the policy's healthy interval starts a
    // new crash episode instead of consuming the original OOM's retry forever.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await rm(join(tmp, `listener-${result.port}`), { force: true });
    process.kill(children[1].pid, 'SIGABRT');
    await waitForCondition(async () => (await readRunCount(runCountPath)) >= 3, { timeoutMs: 3000 });
    await waitForCondition(() => result.pid === children[2]?.pid);
    await waitForCondition(async () => {
      try {
        const replacementState = JSON.parse(await readFile(paths.statePath, 'utf-8'));
        return replacementState.pid === children[2].pid;
      } catch {
        return false;
      }
    }, { timeoutMs: 3000 });
    assert.equal(children[1].signalCode, 'SIGABRT');
    assert.equal(children[2].exitCode, null);

    // The replacement has only just become ready, so another immediate crash remains
    // part of the same episode and must exhaust the single-retry budget.
    await rm(join(tmp, `listener-${result.port}`), { force: true });
    process.kill(children[2].pid, 'SIGABRT');
    await waitForCondition(() => result.proc.exitCode !== null || result.proc.signalCode !== null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await readRunCount(runCountPath), 3);
    assert.equal(children.length, 3);
    assert.equal(result.proc.signalCode, 'SIGABRT');
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer cancels a pending post-readiness restart when shutdown begins', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-backoff-shutdown-'));
  const children = [];
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const http = require('node:http');",
        "const path = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const current = Number(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '0') + 1;",
        "fs.writeFileSync(path, String(current));",
        "const server = http.createServer((req, res) => res.end(req.url === '/status' ? 'packager-status:running' : 'ok'));",
        "const port = Number(process.env.RCT_METRO_PORT);",
        "server.listen(port, '127.0.0.1', () => {",
        "  fs.writeFileSync(process.env.TEST_EXPO_LISTENER_DIR + '/listener-' + port, String(process.pid));",
        "  if (current === 1) setTimeout(() => process.kill(process.pid, 'SIGABRT'), 1000);",
        "});",
      ].join('\n') + '\n',
      'utf-8',
    );
    await chmod(expoBin, 0o755);

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: buildCrashFixtureEnv(tmp, {
          FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
          HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '1000',
          HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '1000',
          HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
      }),
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: `qa-expo-backoff-shutdown-${process.pid}`,
      envPath: join(tmp, 'stack.env'),
      children,
      spawnOptions: { silent: true },
      quiet: true,
    });

    await waitForCondition(() => children[0]?.signalCode === 'SIGABRT', { timeoutMs: 5000 });
    result.proc.kill('SIGINT');
    await waitForCondition(() => result.proc.signalCode === 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await readRunCount(runCountPath), 1);
    assert.equal(children.length, 1);
  } finally {
    for (const child of children) killProcessTreeByPid(child?.pid);
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('isIntentionalExpoTermination treats cleanup-style exit codes as intentional', () => {
  assert.equal(isIntentionalExpoTermination({ code: 130 }), true);
  assert.equal(isIntentionalExpoTermination({ code: 143 }), true);
});

test('restart attempt reset requires a certified healthy interval', () => {
  assert.equal(resolveExpoRestartPolicy({ env: {} }).healthyResetMs, 5 * 60_000);
  const policy = resolveExpoRestartPolicy({
    env: {
      HAPPIER_STACK_EXPO_RESTART_HEALTHY_RESET_MS: '2000',
    },
  });

  assert.equal(resolveNextExpoRestartAttempt({
    restartAttempt: 1,
    certifiedAtMs: null,
    exitedAtMs: 10_000,
    policy,
  }), 2);
  assert.equal(resolveNextExpoRestartAttempt({
    restartAttempt: 1,
    certifiedAtMs: 1_000,
    exitedAtMs: 2_999,
    policy,
  }), 2);
  assert.equal(resolveNextExpoRestartAttempt({
    restartAttempt: 1,
    certifiedAtMs: 1_000,
    exitedAtMs: 3_000,
    policy,
  }), 1);
});
