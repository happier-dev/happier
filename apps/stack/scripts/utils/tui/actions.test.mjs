import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTuiAuthArgs, buildTuiAuthExitNotice } from './actions.mjs';

test('buildTuiAuthArgs builds stack-scoped auth login args', () => {
  assert.deepEqual(buildTuiAuthArgs({ happysBin: 'bin/hstack.mjs', stackName: 'main', force: false }), [
    'bin/hstack.mjs',
    'stack',
    'auth',
    'main',
    'login',
  ]);
  assert.deepEqual(buildTuiAuthArgs({ happysBin: 'bin/hstack.mjs', stackName: 'main', force: true }), [
    'bin/hstack.mjs',
    'stack',
    'auth',
    'main',
    'login',
    '--force',
  ]);
});

test('buildTuiAuthExitNotice reports failures in the TUI instead of holding stdin', () => {
  assert.equal(buildTuiAuthExitNotice({ code: 0, signal: null }), null);
  assert.match(buildTuiAuthExitNotice({ code: 1, signal: null }), /auth: failed.*code=1/);
  assert.match(buildTuiAuthExitNotice({ code: 0, signal: 'SIGINT' }), /auth: failed.*signal=SIGINT/);
});
