import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

const repoRootDir = resolve(import.meta.dirname, '../../../..');

type HarnessCase = {
  label: string;
  scriptPath: string;
  configPath: string;
  expectedArgs: string[];
  startupErrorLabel: string;
  usage: string;
};

type ScriptResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const harnessCases: readonly HarnessCase[] = [
  {
    label: 'playwright',
    scriptPath: resolve(repoRootDir, 'packages/tests/scripts/run-playwright-with-heartbeat.mjs'),
    configPath: 'playwright.ui.config.mjs',
    expectedArgs: ['-s', 'playwright', 'test', '-c', 'playwright.ui.config.mjs'],
    startupErrorLabel: 'playwright',
    usage: 'Usage: node scripts/run-playwright-with-heartbeat.mjs --config <playwright.config.mjs> [extra args]',
  },
  {
    label: 'vitest',
    scriptPath: resolve(repoRootDir, 'packages/tests/scripts/run-vitest-with-heartbeat.mjs'),
    configPath: 'vitest.core.fast.config.ts',
    expectedArgs: ['-s', 'vitest', 'run', '--no-file-parallelism', '-c', 'vitest.core.fast.config.ts'],
    startupErrorLabel: 'vitest',
    usage: 'Usage: node scripts/run-vitest-with-heartbeat.mjs --config <vitest.config.ts> [extra args]',
  },
];

const tempDirs = new Set<string>();

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(filePath)) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function createFakeYarnHarness(): Promise<{ binDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'happier-heartbeat-script-'));
  tempDirs.add(root);
  const binDir = join(root, 'bin');
  const nodeEntrypoint = join(binDir, 'yarn-impl.cjs');
  const yarnPath = join(binDir, 'yarn');
  const yarnCmdPath = join(binDir, 'yarn.cmd');

  await mkdir(binDir, { recursive: true });

  await writeFile(
    nodeEntrypoint,
    [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { dirname } = require('node:path');",
      '',
      'function ensureParentDir(filePath) {',
      '  mkdirSync(dirname(filePath), { recursive: true });',
      '}',
      '',
      'function writeMaybe(filePath, text) {',
      '  if (!filePath) return;',
      '  ensureParentDir(filePath);',
      "  writeFileSync(filePath, text, 'utf8');",
      '}',
      '',
      'const captureKeys = String(process.env.HARNESS_CAPTURE_KEYS ?? "")',
      "  .split(',')",
      '  .map((key) => key.trim())',
      '  .filter(Boolean);',
      'const capturedEnv = {};',
      'for (const key of captureKeys) {',
      '  capturedEnv[key] = process.env[key];',
      '}',
      '',
      'writeMaybe(',
      '  process.env.HARNESS_LOG_FILE,',
      '  JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: capturedEnv }),',
      ');',
      "writeMaybe(process.env.HARNESS_READY_FILE, 'ready');",
      '',
      'const signalLogFile = process.env.HARNESS_SIGNAL_LOG_FILE;',
      'for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {',
      '  process.on(signal, () => {',
      '    writeMaybe(signalLogFile, signal);',
      '    process.exit(0);',
      '  });',
      '}',
      '',
      'const mode = String(process.env.HARNESS_MODE ?? "exit:0");',
      'if (mode === "wait-for-signal") {',
      '  setInterval(() => {}, 1_000);',
      '} else if (mode.startsWith("delay:")) {',
      '  const delayMs = Number.parseInt(mode.slice("delay:".length), 10);',
      '  setTimeout(() => process.exit(0), Number.isFinite(delayMs) ? delayMs : 0);',
      '} else if (mode.startsWith("exit:")) {',
      '  const code = Number.parseInt(mode.slice("exit:".length), 10);',
      '  process.exit(Number.isFinite(code) ? code : 0);',
      '} else {',
      '  throw new Error(`Unsupported HARNESS_MODE: ${mode}`);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    yarnPath,
    `#!/bin/sh\nexec "${process.execPath.replaceAll('"', '\\"')}" "${nodeEntrypoint.replaceAll('"', '\\"')}" "$@"\n`,
    'utf8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(
    yarnCmdPath,
    `@echo off\r\n"${process.execPath.replaceAll('"', '""')}" "${nodeEntrypoint.replaceAll('"', '""')}" %*\r\n`,
    'utf8',
  );

  return { binDir };
}

async function runHeartbeatScript(params: {
  scriptPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  onSpawn?: (child: ReturnType<typeof spawn>) => Promise<void> | void;
}): Promise<ScriptResult> {
  const child = spawn(process.execPath, [params.scriptPath, ...params.args], {
    cwd: repoRootDir,
    env: { ...process.env, ...params.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  if (params.onSpawn) {
    await params.onSpawn(child);
  }

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (nextCode, nextSignal) => resolve({ code: nextCode, signal: nextSignal }));
  });

  return { code, signal, stdout, stderr };
}

describe('heartbeat harness scripts', () => {
  afterEach(async () => {
    await Promise.all(
      [...tempDirs].map(async (dir) => {
        tempDirs.delete(dir);
        await rm(dir, { recursive: true, force: true });
      }),
    );
  });

  it.each(harnessCases)('prints usage when %s config is missing', async ({ scriptPath, usage }) => {
    const result = await runHeartbeatScript({ scriptPath, args: [] });

    expect(result.code).toBe(2);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain(usage);
    expect(result.stdout).toBe('');
  });

  it.each(harnessCases)('launches yarn with the expected args for %s', async ({ scriptPath, configPath, expectedArgs }) => {
    const harness = await createFakeYarnHarness();
    const harnessLogPath = join(harness.binDir, 'launch.json');

    const result = await runHeartbeatScript({
      scriptPath,
      args: ['--config', configPath, '--grep', 'smoke'],
      env: {
        PATH: `${harness.binDir}${delimiter}${process.env.PATH ?? ''}`,
        HARNESS_CAPTURE_KEYS: 'HAPPIER_TEST_HEARTBEAT_MS',
        HARNESS_LOG_FILE: harnessLogPath,
        HARNESS_MODE: 'exit:0',
        HAPPIER_TEST_HEARTBEAT_MS: '5555',
      },
    });

    const launch = JSON.parse(await readFile(harnessLogPath, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: Record<string, string | undefined>;
    };

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain(`[tests] starting: yarn ${[...expectedArgs, '--grep', 'smoke'].join(' ')}`);
    expect(result.stdout).toContain('[tests] completed in ');
    expect(launch.argv).toEqual([...expectedArgs, '--grep', 'smoke']);
    expect(launch.cwd).toBe(repoRootDir);
    expect(launch.env.HAPPIER_TEST_HEARTBEAT_MS).toBe('5555');
  });

  it.each(harnessCases)('emits heartbeat output while %s child is still running', async ({ scriptPath, configPath }) => {
    const harness = await createFakeYarnHarness();

    const result = await runHeartbeatScript({
      scriptPath,
      args: ['--config', configPath],
      env: {
        PATH: `${harness.binDir}${delimiter}${process.env.PATH ?? ''}`,
        HARNESS_MODE: 'delay:1100',
        HAPPIER_TEST_HEARTBEAT_MS: '1000',
      },
    });

    const heartbeatMatches = result.stdout.match(/\[tests\] still running \(/g) ?? [];
    expect(result.code).toBe(0);
    expect(heartbeatMatches).toHaveLength(1);
    expect(result.stdout).toContain(configPath);
  }, 10_000);

  it.each(harnessCases)('forwards SIGTERM to the spawned %s child', async ({ scriptPath, configPath }) => {
    const harness = await createFakeYarnHarness();
    const readyPath = join(harness.binDir, 'child.ready');
    const signalPath = join(harness.binDir, 'child.signal');

    const resultPromise = runHeartbeatScript({
      scriptPath,
      args: ['--config', configPath],
      env: {
        PATH: `${harness.binDir}${delimiter}${process.env.PATH ?? ''}`,
        HARNESS_MODE: 'wait-for-signal',
        HARNESS_READY_FILE: readyPath,
        HARNESS_SIGNAL_LOG_FILE: signalPath,
      },
      onSpawn: async (child) => {
        await waitForFile(readyPath);
        child.kill('SIGTERM');
      },
    });

    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(await readFile(signalPath, 'utf8')).toBe('SIGTERM');
    expect(result.stdout).toContain('[tests] completed in ');
  }, 10_000);

  it.each(harnessCases)('reports a startup failure when yarn is unavailable for %s', async ({ scriptPath, configPath, startupErrorLabel }) => {
    const result = await runHeartbeatScript({
      scriptPath,
      args: ['--config', configPath],
      env: {
        PATH: join(await mkdtemp(join(tmpdir(), 'happier-heartbeat-missing-yarn-')), 'empty-bin'),
      },
    });

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain(`[tests] failed to start ${startupErrorLabel}:`);
  }, 10_000);
});
