import { expect, it } from 'vitest';
import { completeActionResult, settleActionOutput } from './resultProjection.js';
import { getActionSpec } from '../actionSpecs.js';
import { withActionFailureCauseDiagnostic } from './actionFailureDiagnostic.js';
import { classifyExecutionRunStartFailure } from './executionRuns.js';

it('projects a carried cause through returned failure normalization without private exception data', () => {
  const error = Object.assign(new TypeError('PRIVATE_PROVIDER_BODY'), {
    code: 'execution_run_profile_preparation_failed',
    cause: { headers: { authorization: 'PRIVATE_CREDENTIAL' }, response: 'PRIVATE_RESPONSE' },
  });
  const normalized = completeActionResult(withActionFailureCauseDiagnostic({
    ok: false, errorCode: error.code, error: 'Preparation failed',
  }, error, 'execution.run.start'));
  if (normalized.ok) throw new Error('Expected returned failure');
  const result = settleActionOutput('execution.run.start', classifyExecutionRunStartFailure(normalized, 'noRunCreated'));
  expect(result).toEqual({ ok: false, errorCode: error.code, error: 'Preparation failed',
    details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    failureCause: { phase: 'execution.run.start', errorClass: 'TypeError', errorCode: error.code, httpStatus: null },
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});

it('logs sanitized terminal output issues and thrown causes privately', () => {
  const diagnostics: unknown[] = [];
  const record = (diagnostic: unknown) => { diagnostics.push(diagnostic); };
  const schema = getActionSpec('action.operations.list').outputSchema!;
  const result = settleActionOutput('action.operations.list', { ok: true, result: { items: 'secret-rejected', nextCursor: null } },
    'diagnostic-request', schema, record);
  expect(result).toEqual({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output', requestId: 'diagnostic-request' });
  expect(diagnostics).toHaveLength(1);
  expect(result).not.toHaveProperty('details');
  expect(diagnostics).toMatchObject([{ issues: expect.arrayContaining([{ path: ['items'], code: 'invalid_type' }]) }]);
  settleActionOutput('action.operations.list', { ok: true, result: {} }, undefined,
    { safeParse() { throw new TypeError('secret-thrown'); } }, record);
  expect(diagnostics[1]).toMatchObject({ failureCause: { errorClass: 'TypeError' } });
  expect(JSON.stringify([result, diagnostics])).not.toContain('secret-');
});
