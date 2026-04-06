import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  buildTauriMcpCliCommand,
  isTauriMcpCliErrorText,
  runTauriMcpCli,
  throwIfTauriMcpCliError,
} from './tauriMcpCli.mjs';

test('isTauriMcpCliErrorText detects Error-prefixed output', () => {
  assert.equal(isTauriMcpCliErrorText('Error: something went wrong'), true);
  assert.equal(isTauriMcpCliErrorText('  Error: something went wrong'), true);
  assert.equal(isTauriMcpCliErrorText('error: something went wrong'), true);
  assert.equal(isTauriMcpCliErrorText('OK'), false);
  assert.equal(isTauriMcpCliErrorText(''), false);
});

test('throwIfTauriMcpCliError throws when stdout contains an error prefix', () => {
  assert.throws(
    () => throwIfTauriMcpCliError({ stdout: 'Error: Timeout waiting for selector', stderr: '' }),
    /Timeout waiting for selector/,
  );
});

test('throwIfTauriMcpCliError is a no-op for successful output', () => {
  assert.doesNotThrow(() => throwIfTauriMcpCliError({ stdout: 'Ready', stderr: '' }));
});

test('buildTauriMcpCliCommand invokes tauri-mcp through the workspace yarn script', () => {
  assert.deepEqual(
    buildTauriMcpCliCommand(['driver-session', 'status', '--port', '9223']),
    {
      command: 'yarn',
      args: ['-s', 'tauri:mcp:cli', 'driver-session', 'status', '--port', '9223'],
    },
  );
});

test('runTauriMcpCli kills the spawned process tree when the command times out', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {
    child.emit('close', null, 'SIGKILL');
    return true;
  };

  let killCalls = 0;
  const spawnImpl = () => child;
  const killProcessTree = () => {
    killCalls += 1;
    child.emit('close', null, 'SIGKILL');
  };

  const resultPromise = runTauriMcpCli(['driver-session', 'status', '--port', '9223'], {
    timeoutMs: 1,
    spawnImpl,
    killProcessTree,
  });

  await assert.rejects(resultPromise, (error) => error.code === 'ETIMEDOUT');
  assert.equal(killCalls, 1);
});
