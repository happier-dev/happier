import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { getExpoStatePaths } from '../expo/expo.mjs';
import { isIntentionalExpoTermination } from './expo_dev_supervision.mjs';
import { killProcessTree } from '../proc/proc.mjs';

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

async function waitForCondition(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
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

test('ensureDevExpoServer restarts Expo after a Node heap OOM abort', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-oom-supervision-'));
  const children = [];
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
        "fs.writeFileSync(runCountPath, String(current));",
        "if (current === 1) {",
        "  console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');",
        "  process.kill(process.pid, 'SIGABRT');",
        '}',
        'setInterval(() => {}, 1000);',
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
      baseEnv: {
        ...process.env,
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: '45678',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-oom-supervision',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, 45678);
    assert.ok(result.proc, 'expected ensureDevExpoServer to return a tracked process handle');

    await waitForCondition(async () => (await readRunCount(runCountPath)) >= 2);
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

    result.proc.kill('SIGTERM');
    await waitForCondition(() => children[1].signalCode === 'SIGTERM');
    await waitForCondition(() => result.proc.exitCode !== null || result.proc.signalCode !== null);
    assert.equal(result.proc.signalCode, 'SIGTERM');
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer cancels a pending restart when shutdown begins during restart backoff', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-backoff-shutdown-'));
  const children = [];
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
        "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
        "fs.writeFileSync(runCountPath, String(current));",
        "if (current === 1) {",
        "  console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');",
        "  process.kill(process.pid, 'SIGABRT');",
        '}',
        'setInterval(() => {}, 1000);',
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: '45679',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '1000',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '1000',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath: join(tmp, 'stack.runtime.json'),
      stackName: 'qa-expo-backoff-shutdown',
      envPath: join(tmp, 'stack.env'),
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    await waitForCondition(async () => (await readRunCount(runCountPath)) === 1);
    await waitForCondition(() => children[0]?.signalCode === 'SIGABRT');

    killProcessTree(result.proc, 'SIGINT');
    await waitForCondition(() => result.proc.signalCode === 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(await readRunCount(runCountPath), 1);
    assert.equal(children.length, 1);
    assert.equal(result.proc.pid, null);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('isIntentionalExpoTermination treats cleanup-style exit codes as intentional', () => {
  assert.equal(isIntentionalExpoTermination({ code: 130 }), true);
  assert.equal(isIntentionalExpoTermination({ code: 143 }), true);
});
