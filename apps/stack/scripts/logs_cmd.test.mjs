import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

test('hstack logs --json resolves stack-scoped sources and auto-selects runner when present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-logs-cmd-'));
  const stackName = 'exp1';
  const baseDir = join(root, stackName);
  const logsDir = join(baseDir, 'logs');
  const cliLogsDir = join(baseDir, 'cli', 'logs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(cliLogsDir, { recursive: true });

  const runnerLog = join(logsDir, 'runner.log');
  writeFileSync(runnerLog, '[runner] hello\n', 'utf-8');
  writeFileSync(join(logsDir, 'server.log'), '[server] hi\n', 'utf-8');
  writeFileSync(join(logsDir, 'expo.log'), '[expo] hi\n', 'utf-8');
  writeFileSync(join(cliLogsDir, 'x-daemon.log'), '[daemon] hi\n', 'utf-8');

  const runtimePath = join(baseDir, 'stack.runtime.json');
  writeFileSync(runtimePath, JSON.stringify({ version: 1, stackName, logs: { runner: runnerLog } }, null, 2) + '\n', 'utf-8');

  const res = await runNode(
    [join(process.cwd(), 'apps/stack/scripts/logs.mjs'), '--json'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: root,
        HAPPIER_STACK_STACK: stackName,
      },
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.stackName, stackName);
  assert.equal(data.selected.component, 'runner');
  assert.ok(Array.isArray(data.selected.paths));
  assert.equal(data.selected.paths[0], runnerLog);
});

test('hstack logs --component=server --json selects server log path when present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-logs-cmd-'));
  const stackName = 'exp1';
  const baseDir = join(root, stackName);
  const logsDir = join(baseDir, 'logs');
  mkdirSync(logsDir, { recursive: true });

  const serverLog = join(logsDir, 'server.log');
  writeFileSync(serverLog, '[server] hi\n', 'utf-8');

  const res = await runNode(
    [join(process.cwd(), 'apps/stack/scripts/logs.mjs'), '--component=server', '--json'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HAPPIER_STACK_STORAGE_DIR: root,
        HAPPIER_STACK_STACK: stackName,
      },
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.selected.component, 'server');
  assert.deepEqual(data.selected.paths, [serverLog]);
});

