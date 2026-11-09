import test from 'node:test';
import assert from 'node:assert/strict';
import { relayStartupFailure } from './failure.mjs';

test('startup diagnostics retain only closed codes and never arbitrary exception details', () => {
  const detail = '/private/diagnostic-payload';
  const error = Object.assign(new Error(detail), { code: detail, remediation: detail });
  const result = relayStartupFailure(error, 'certificate');
  assert.equal(result.reason, 'relay_start_failed');
  assert.deepEqual(result.failure, { phase: 'certificate', code: 'unclassified' });
  assert.equal(JSON.stringify(result).includes(detail), false);
  assert.deepEqual(relayStartupFailure(new ReferenceError(detail), 'certificate').failure,
    { phase: 'certificate', code: 'ReferenceError' });
  assert.deepEqual(relayStartupFailure(Object.assign(new Error(detail), { code: 'EACCES' }), 'spawn').failure,
    { phase: 'spawn', code: 'EACCES' });
});
