import { expect, it } from 'vitest';
import { completeActionResult, normalizeActionExecutorThrownError, settleActionOutput } from './resultProjection.js';
import { createActionExecuteFailureError } from '../actionExecutionResult.js';
import { getActionSpec } from '../actionSpecs.js';
import { withActionFailureCauseDiagnostic } from './actionFailureDiagnostic.js';
import { classifyExecutionRunStartFailure } from './executionRuns.js';

it('creates private thrown-error diagnostics that survive native adapter spreading', () => {
  const diagnostics: unknown[] = [];
  const normalized = normalizeActionExecutorThrownError(Object.assign(new TypeError('PRIVATE_PROVIDER_RESPONSE'), { code: 'ECONNRESET' }),
    'execution.run.start');
  const failure = { ok: false as const, ...normalized };
  const result = settleActionOutput('execution.run.start', failure, undefined, undefined, diagnostic => diagnostics.push(diagnostic));
  expect(result).toEqual({ ok: false, errorCode: normalized.errorCode, error: normalized.error, failureCause: normalized.failureCause });
  expect(diagnostics).toMatchObject([{ source: 'execution.run.start',
    failureCause: { phase: 'execution.run.start', errorClass: 'TypeError', errorCode: 'ECONNRESET' } }]);
  expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_');
});

it.each([false, true])('settles a returned failure without private exception data (declared cause: %s)', declared => {
  const errorCode = 'execution_run_profile_preparation_failed';
  const privateCause = { headers: { authorization: 'PRIVATE_CREDENTIAL' }, response: 'PRIVATE_RESPONSE' };
  const cause = declared
    ? Object.assign(createActionExecuteFailureError({ ok: false, errorCode, error: 'Preparation failed' }), { cause: privateCause })
    : privateCause;
  const error = Object.assign(new TypeError('PRIVATE_PROVIDER_BODY', { cause }), { code: errorCode });
  const normalized = completeActionResult(withActionFailureCauseDiagnostic({
    ok: false, errorCode, error: 'Preparation failed',
  }, error, 'execution.run.start'));
  if (normalized.ok) throw new Error('Expected returned failure');
  const result = settleActionOutput('execution.run.start', classifyExecutionRunStartFailure(normalized, 'noRunCreated'));
  expect(result).toEqual({ ok: false, errorCode, error: 'Preparation failed',
    details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    failureCause: { phase: 'execution.run.start', errorClass: 'TypeError', errorCode: declared ? errorCode : null, httpStatus: null },
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
