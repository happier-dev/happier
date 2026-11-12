import { describe, expect, it } from 'vitest';
import { normalizeActionExecuteResult, projectCliActionFailure } from './normalizeActionExecuteResult';

describe('CLI Action failure presentation', () => {
  it.each(['outer', 'nested'] as const)('explains the Machine owner Manage refusal in an %s result', kind => {
    const failureCause = { phase: 'execution_authorization', errorClass: 'Error',
      errorCode: 'machine_manage_required', httpStatus: null } as const;
    const refusal = { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied', failureCause } as const;
    const normalized = normalizeActionExecuteResult(kind === 'outer' ? refusal : { ok: true, result: refusal });
    expect(normalized).toMatchObject({ ok: false, errorCode: 'credential_scope_denied',
      errorMessage: 'This Action needs Manage on this Machine.', failureCause });
    if (normalized.ok) throw new Error('Expected a refused Action');
    expect(projectCliActionFailure(normalized)).toMatchObject({ code: 'credential_scope_denied',
      message: 'This Action needs Manage on this Machine.', failureCause });
  });
});


it('points a refused terminal approval to the app without changing its failure evidence', () => {
  const failureCause = { phase: 'execution_authorization', errorClass: 'Error',
    errorCode: 'RPC_FORBIDDEN', httpStatus: 403 } as const;
  const refusal = { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown',
    requestId: 'approval-request', effectAttempted: false, details: { reasonCode: 'credential_scope_denied' }, failureCause } as const;
  const normalized = normalizeActionExecuteResult(refusal);
  if (normalized.ok) throw new Error('Expected a refused approval');
  const projected = projectCliActionFailure(normalized);
  expect(projected).toMatchObject({ code: refusal.errorCode, requestId: refusal.requestId,
    effectAttempted: false, details: refusal.details, failureCause });
  expect(projected.message).toMatch(/approve.*Happier app/i);
  expect(projected.message).toBe(normalized.errorMessage);
});

it('preserves authored guidance and does not redirect unrelated credential refusals to approval', () => {
  for (const refusal of [
    { errorCode: 'credential_scope_denied', errorMessage: 'This credential cannot read the resource.' },
    { errorCode: 'approval_execution_outcome_unknown', errorMessage: 'The Machine must reconnect.', details: { reasonCode: 'target_unavailable' } },
    { errorCode: 'approval_execution_outcome_unknown', errorMessage: 'Review this exact request in your organization app.', details: { reasonCode: 'credential_scope_denied' } },
  ]) expect(projectCliActionFailure(refusal).message).toBe(refusal.errorMessage);
});
