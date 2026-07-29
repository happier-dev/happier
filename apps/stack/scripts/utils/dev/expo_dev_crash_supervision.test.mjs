import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDevExpoServer } from './expo_dev.mjs';
import { resolveExpoRestartPolicy } from './expo_dev_supervision.mjs';
import { getExpoStatePaths } from '../expo/expo.mjs';
import { readStackRuntimeStateFile } from '../stack/runtime_state.mjs';

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

async function waitForCondition(predicate, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
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

test('resolveExpoRestartPolicy rejects positive fractions that floor to zero', () => {
  const policy = resolveExpoRestartPolicy({
    stackMode: true,
    env: {
      HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '0.5',
      HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '0.5',
      HAPPIER_STACK_EXPO_RESTART_STABILITY_WINDOW_MS: '0.5',
    },
  });

  assert.equal(policy.baseDelayMs, 1_000);
  assert.equal(policy.maxDelayMs, 30_000);
  assert.equal(policy.stabilityWindowMs, 60_000);
});

test('ensureDevExpoServer restarts Expo after a Node heap OOM abort', async () => {
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
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        FAKE_EXPO_ARGS_PATH: argsPath,
        HAPPIER_STACK_EXPO_CLEAR_CACHE: '0',
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

    await waitForCondition(async () => (await readRunCount(runCountPath)) >= 2 && children.length >= 2);
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

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
    });
    await waitForCondition(async () => {
      const state = JSON.parse(await readFile(paths.statePath, 'utf-8').catch(() => '{}'));
      return state.pid === children[1].pid;
    });
    const state = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(state.pid, children[1].pid);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer restarts Expo after an unexpected SIGKILL while the stack owner is alive', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-sigkill-supervision-'));
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
        "  process.kill(process.pid, 'SIGKILL');",
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
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: '45679',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-sigkill-supervision',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, 45679);

    await waitForCondition(async () => (await readRunCount(runCountPath)) >= 2 && children.length >= 2);
    assert.equal(children.length, 2);
    assert.equal(children[0].signalCode, 'SIGKILL');
    assert.equal(children[1].exitCode, null);

    await waitForCondition(async () => {
      const runtime = await readStackRuntimeStateFile(runtimeStatePath);
      return runtime?.processes?.expoPid === children[1].pid;
    });
    const runtime = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtime?.processes?.expoPid, children[1].pid);
    assert.equal(runtime?.expo?.webPort, 45679);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer restores the restart budget after a replacement remains stable', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-stable-restart-budget-'));
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
        "  process.kill(process.pid, 'SIGKILL');",
        '}',
        "if (current === 2) {",
        "  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 120);",
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
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: '45681',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
        HAPPIER_STACK_EXPO_RESTART_STABILITY_WINDOW_MS: '50',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-stable-restart-budget',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, 45681);
    await waitForCondition(
      async () => (await readRunCount(runCountPath)) >= 3 && children.length >= 3,
      { timeoutMs: 2_000 },
    );
    assert.equal(children[0].signalCode, 'SIGKILL');
    assert.equal(children[1].signalCode, 'SIGKILL');
    assert.equal(children[2].exitCode, null);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer keeps the rapid-crash cap when the stability override is zero', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-zero-stability-window-'));
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
        "if (current === 1) process.kill(process.pid, 'SIGKILL');",
        "if (current === 2) setTimeout(() => process.kill(process.pid, 'SIGKILL'), 25);",
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
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: '45682',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
        HAPPIER_STACK_EXPO_RESTART_STABILITY_WINDOW_MS: '0',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-zero-stability-window',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, 45682);
    await waitForCondition(
      async () => (await readRunCount(runCountPath)) >= 2 && children[1]?.signalCode === 'SIGKILL',
      { timeoutMs: 2_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(await readRunCount(runCountPath), 2);
    assert.equal(children.length, 2);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer clears published UI runtime metadata without restarting during stack shutdown', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-shutdown-supervision-'));
  const children = [];
  let shuttingDown = false;
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
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: '45680',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '10',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '1',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-shutdown-supervision',
      envPath,
      children,
      spawnOptions: {
        silent: true,
      },
      isShuttingDown: () => shuttingDown,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, 45680);
    await waitForCondition(async () => (await readRunCount(runCountPath)) === 1);

    shuttingDown = true;
    process.kill(children[0].pid, 'SIGTERM');

    await waitForCondition(async () => children[0].signalCode === 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(await readRunCount(runCountPath), 1);
    const runtime = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtime?.processes?.expoPid, null);
    assert.equal(runtime?.expo?.port, null);
    assert.equal(runtime?.expo?.webPort, null);
    assert.equal(runtime?.expo?.mobilePort, null);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer retries after a transient replacement spawn failure', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-transient-spawn-failure-'));
  const children = [];
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const expoSource = [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
      "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
      "fs.writeFileSync(runCountPath, String(current));",
      "if (current === 1) {",
      "  fs.unlinkSync(process.argv[1]);",
      "  process.kill(process.pid, 'SIGKILL');",
      '}',
      'setInterval(() => {}, 1000);',
    ].join('\n') + '\n';
    await writeFile(expoBin, expoSource, 'utf-8');
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    const teeFile = join(tmp, 'expo.log');
    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: '45683',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '40',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '40',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '2',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-transient-spawn-failure',
      envPath,
      children,
      spawnOptions: {
        silent: true,
        teeFile,
      },
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, 45683);
    await waitForCondition(async () => children[0]?.signalCode === 'SIGKILL');
    await children[0].completion;
    await rm(teeFile, { force: true });
    await waitForCondition(async () => {
      return await readFile(teeFile, 'utf-8').then(
        () => true,
        () => false,
      );
    });
    await writeFile(expoBin, expoSource, 'utf-8');
    await chmod(expoBin, 0o755);

    await waitForCondition(
      async () => (await readRunCount(runCountPath)) >= 2 && children.some((child) => Number(child?.pid) > 1 && child.exitCode === null),
      { timeoutMs: 2_000 },
    );
    assert.equal(await readRunCount(runCountPath), 2);
  } finally {
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ensureDevExpoServer does not retry a replacement spawn failure after shutdown begins during backoff', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-spawn-failure-shutdown-'));
  const children = [];
  let shuttingDown = false;
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const runCountPath = join(tmp, 'expo-runs.txt');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const expoSource = [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const runCountPath = process.env.FAKE_EXPO_RUN_COUNT_PATH;",
      "const current = Number(fs.existsSync(runCountPath) ? fs.readFileSync(runCountPath, 'utf8').trim() : '0') + 1;",
      "fs.writeFileSync(runCountPath, String(current));",
      "if (current === 1) {",
      "  fs.unlinkSync(process.argv[1]);",
      "  process.kill(process.pid, 'SIGKILL');",
      '}',
      'setInterval(() => {}, 1000);',
    ].join('\n') + '\n';
    await writeFile(expoBin, expoSource, 'utf-8');
    await chmod(expoBin, 0o755);

    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    const envPath = join(tmp, 'stack.env');
    const teeFile = join(tmp, 'expo.log');
    const result = await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        FAKE_EXPO_RUN_COUNT_PATH: runCountPath,
        HAPPIER_STACK_EXPO_DEV_PORT: '45684',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
        HAPPIER_STACK_EXPO_RESTART_BASE_DELAY_MS: '300',
        HAPPIER_STACK_EXPO_RESTART_MAX_DELAY_MS: '300',
        HAPPIER_STACK_EXPO_RESTART_MAX_ATTEMPTS: '2',
      },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: false,
      stackMode: true,
      runtimeStatePath,
      stackName: 'qa-expo-spawn-failure-shutdown',
      envPath,
      children,
      spawnOptions: {
        silent: true,
        teeFile,
      },
      isShuttingDown: () => shuttingDown,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, 45684);
    await waitForCondition(async () => children[0]?.signalCode === 'SIGKILL');
    await children[0].completion;
    await rm(teeFile, { force: true });
    await waitForCondition(async () => {
      return await readFile(teeFile, 'utf-8').then(
        () => true,
        () => false,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    shuttingDown = true;
    await writeFile(expoBin, expoSource, 'utf-8');
    await chmod(expoBin, 0o755);
    await new Promise((resolve) => setTimeout(resolve, 350));

    assert.equal(await readRunCount(runCountPath), 1);
    assert.equal(children.length, 1);
    const runtime = await readStackRuntimeStateFile(runtimeStatePath);
    assert.equal(runtime?.processes?.expoPid, null);
    assert.equal(runtime?.expo?.port, null);
  } finally {
    shuttingDown = true;
    for (const child of children) {
      killProcessTreeByPid(child?.pid);
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
