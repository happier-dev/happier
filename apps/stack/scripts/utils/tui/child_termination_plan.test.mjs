import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTuiChildTerminationPlan } from './child_termination_plan.mjs';

test('resolveTuiChildTerminationPlan returns none for invalid child pid', () => {
  assert.deepEqual(resolveTuiChildTerminationPlan({ childPid: 0, childPgid: 0, selfPgid: 0 }), { strategy: 'none', target: null });
  assert.deepEqual(resolveTuiChildTerminationPlan({ childPid: null }), { strategy: 'none', target: null });
});

test('resolveTuiChildTerminationPlan prefers pgid when it differs from self pgid', () => {
  assert.deepEqual(resolveTuiChildTerminationPlan({ childPid: 123, childPgid: 456, selfPgid: 999 }), { strategy: 'pgid', target: 456 });
});

test('resolveTuiChildTerminationPlan falls back to pid when child pgid equals self pgid', () => {
  assert.deepEqual(resolveTuiChildTerminationPlan({ childPid: 123, childPgid: 777, selfPgid: 777 }), { strategy: 'pid', target: 123 });
});

test('resolveTuiChildTerminationPlan falls back to pid when child pgid is missing', () => {
  assert.deepEqual(resolveTuiChildTerminationPlan({ childPid: 123, childPgid: null, selfPgid: 777 }), { strategy: 'pid', target: 123 });
});

test('resolveTuiChildTerminationPlan prefers pgid when self pgid is unknown', () => {
  assert.deepEqual(resolveTuiChildTerminationPlan({ childPid: 123, childPgid: 456, selfPgid: null }), { strategy: 'pgid', target: 456 });
});
