import test from 'node:test';
import assert from 'node:assert/strict';

import { isTauriMcpCliErrorText, throwIfTauriMcpCliError } from './tauriMcpCli.mjs';

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

