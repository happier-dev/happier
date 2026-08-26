import assert from 'node:assert/strict';
import test from 'node:test';

import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';

const script = new URL('./concurrent_command.mjs', import.meta.url).pathname;

test('concurrent benchmark helper launches the requested number of identical commands', async () => {
  const result = await runNodeCapture([
    script,
    '--count=3',
    '--',
    process.execPath,
    '-e',
    'setTimeout(() => process.exit(0), 10)',
  ]);
  assert.equal(result.code, 0, result.stderr);
});

test('concurrent benchmark helper fails when any identical command fails', async () => {
  const result = await runNodeCapture([script, '--count=2', '--', process.execPath, '-e', 'process.exit(7)']);
  assert.equal(result.code, 7);
});
