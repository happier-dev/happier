import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTuiAuthArgs, buildTuiDaemonStartArgs, shouldHoldAfterAuthExit } from './actions.mjs';

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

test('buildTuiDaemonStartArgs builds stack-scoped daemon start args', () => {
  assert.deepEqual(buildTuiDaemonStartArgs({ happysBin: 'bin/hstack.mjs', stackName: 'main' }), [
    'bin/hstack.mjs',
    'stack',
    'daemon',
    'main',
    'start',
  ]);
});

test('shouldHoldAfterAuthExit holds on failure but not on success', () => {
  assert.equal(shouldHoldAfterAuthExit({ code: 0, signal: null }), false);
  assert.equal(shouldHoldAfterAuthExit({ code: 1, signal: null }), true);
  assert.equal(shouldHoldAfterAuthExit({ code: 0, signal: 'SIGINT' }), true);
});

