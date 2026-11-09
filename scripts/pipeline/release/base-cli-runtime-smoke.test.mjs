import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBaseCliRuntimeSmokeSource } from './base-cli-runtime-smoke.mjs';

const root = fileURLToPath(new URL('../../../apps/cli/', import.meta.url));

async function runRuntimeSmoke(t, { exitCode = 0, output = 'pty-ok', emitExit = true } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-runtime-smoke-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const preload = join(scratch, 'pty-boundary.cjs');
  // The native PTY is an OS boundary. Its child emits real output and exits, while a
  // worker keeps listening like node-pty 1.1.0's ConPTY conoutSocketWorker after exit.
  await writeFile(preload, `
    const Module = require('node:module');
    const { spawn } = require('node:child_process');
    const { Worker } = require('node:worker_threads');
    const originalLoad = Module._load;
    Module._load = function (id, ...args) {
      if (id !== 'node-pty') return originalLoad.call(this, id, ...args);
      return { spawn() {
        new Worker("require('node:net').createServer().listen(0)", { eval: true, execArgv: [] });
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${exitCode};`)}]);
        return {
          onData(listener) { child.stdout.on('data', chunk => listener(chunk.toString())); },
          onExit(listener) {
            child.on('close', code => {
              process.stderr.write('pty-child-exited:' + code + '\\n');
              if (${emitExit}) listener({ exitCode: code, signal: 0 });
            });
          },
        };
      } };
    };
  `);
  return spawnSync(process.execPath, [
    '--require', preload, '--input-type=module', '-e',
    createBaseCliRuntimeSmokeSource({ root, scratch, targetOs: 'windows' }),
  ], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' } });
}

test('runtime smoke exits after verified PTY output and exit even when ConPTY retains a worker', async (t) => {
  const result = await runRuntimeSmoke(t);
  assert.match(result.stderr, /pty-child-exited:0/);
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test('runtime smoke rejects a failed PTY child', async (t) => {
  const result = await runRuntimeSmoke(t, { exitCode: 1 });
  assert.equal(result.error, undefined, result.stderr);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-pty child failed with exit 1/);
});

test('runtime smoke rejects missing PTY output', async (t) => {
  const result = await runRuntimeSmoke(t, { output: 'unexpected' });
  assert.equal(result.error, undefined, result.stderr);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node-pty did not carry subprocess output/);
});

test('runtime smoke still waits for PTY exit after receiving output', async (t) => {
  const result = await runRuntimeSmoke(t, { emitExit: false });
  assert.match(result.stderr, /pty-child-exited:0/);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.status, null);
});
