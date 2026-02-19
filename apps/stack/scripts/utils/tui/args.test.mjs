import test from 'node:test';
import assert from 'node:assert/strict';

import { isTuiHelpRequest, normalizeTuiForwardedArgs } from './args.mjs';

test('normalizeTuiForwardedArgs defaults to dev for empty args', () => {
  assert.deepEqual(normalizeTuiForwardedArgs([]), ['dev']);
});

test('normalizeTuiForwardedArgs preserves explicit args', () => {
  assert.deepEqual(normalizeTuiForwardedArgs(['stack', 'dev', 'exp1']), ['stack', 'dev', 'exp1']);
});

test('isTuiHelpRequest only matches explicit help', () => {
  assert.equal(isTuiHelpRequest([]), false);
  assert.equal(isTuiHelpRequest(['--help']), true);
  assert.equal(isTuiHelpRequest(['help']), true);
  assert.equal(isTuiHelpRequest(['stack', 'dev', 'exp1']), false);
});
