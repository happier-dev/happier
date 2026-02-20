import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScriptPtyArgs } from './script_pty_command.mjs';

test('buildScriptPtyArgs uses util-linux -c form on linux', () => {
  const res = buildScriptPtyArgs({
    platform: 'linux',
    file: '/dev/null',
    command: ['/usr/bin/node', '/x/hstack.mjs', 'dev', '--restart'],
  });
  assert.equal(res.cmd, 'script');
  assert.equal(res.args[0], '-q');
  assert.ok(res.args.includes('-c'), `expected -c in args, got ${JSON.stringify(res.args)}`);
  assert.equal(res.args[res.args.length - 1], '/dev/null');
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

