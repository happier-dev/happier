import test from 'node:test';
import assert from 'node:assert/strict';

import { inferTuiStackName, isTuiHelpRequest, normalizeTuiForwardedArgs } from './args.mjs';

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

test('inferTuiStackName returns explicit stack name for stack command', () => {
  const stackName = inferTuiStackName(['stack', 'dev', 'resume-upstream'], {});
  assert.equal(stackName, 'resume-upstream');
});

test('inferTuiStackName uses env stack only when explicitly set', () => {
  const stackName = inferTuiStackName(['dev'], { HAPPIER_STACK_STACK: 'main' });
  assert.equal(stackName, 'main');
});

test('inferTuiStackName stays stackless when no explicit stack context is present', () => {
  const stackName = inferTuiStackName(['dev'], { HAPPIER_STACK_STACK: '' });
  assert.equal(stackName, null);
});
