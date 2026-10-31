import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScriptPtyArgs } from './script_pty_command.mjs';
import { runCommandCapture } from '../../testkit/core/run_node_capture.mjs';

test('buildScriptPtyArgs uses util-linux -c form on linux', async () => {
  const forwarded = ['work tree', "it's ready", '$HOME; echo expanded'];
  const res = buildScriptPtyArgs({
    platform: 'linux',
    file: '/dev/null',
    command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...forwarded],
  });
  assert.equal(res.cmd, 'script');
  assert.equal(res.args[0], '-q');
  assert.ok(res.args.includes('-e'), `expected -e to preserve child exit status, got ${JSON.stringify(res.args)}`);
  assert.ok(res.args.includes('-c'), `expected -c in args, got ${JSON.stringify(res.args)}`);
  assert.equal(res.args[res.args.length - 1], '/dev/null');
  if (process.platform !== 'win32') {
    const result = await runCommandCapture('sh', ['-c', res.args[res.args.indexOf('-c') + 1]]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), forwarded);
  }
});

test('buildScriptPtyArgs uses BSD args form on darwin', () => {
  const res = buildScriptPtyArgs({
    platform: 'darwin',
    file: '/dev/null',
    command: ['/usr/bin/node', '/x/hstack.mjs', 'dev'],
  });
  assert.deepEqual(res, {
    cmd: 'script',
    args: ['-q', '/dev/null', '/usr/bin/node', '/x/hstack.mjs', 'dev'],
  });
});
