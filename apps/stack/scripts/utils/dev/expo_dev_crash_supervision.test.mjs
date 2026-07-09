import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDevExpoServer } from './expo_dev.mjs';
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

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
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

    await waitForCondition(async () => (await readRunCount(runCountPath)) >= 2);
    assert.equal(children.length, 2);
    assert.equal(children[0].signalCode, 'SIGKILL');
    assert.equal(children[1].exitCode, null);

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
