import { describe, expect, it } from 'vitest';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecuteResult, normalizeCliActionThrownError, projectCliActionFailure } from './normalizeActionExecuteResult';

describe('CLI Action failure presentation', () => {
  it('retains the CLI target parser refusal and its cause at the command boundary', () => {
    const failure = normalizeCliActionThrownError(Object.assign(new Error('--machine-id is required for a Workflow project target.'), {
      code: 'invalid_arguments',
    }));
    expect(failure).toMatchObject({ unexpected: false, failure: { errorCode: 'invalid_arguments',
      failureCause: { errorCode: 'invalid_arguments' } } });
  });

  it('keeps an unclassified vendor code diagnostic instead of promoting it to a CLI refusal', () => {
    expect(normalizeCliActionThrownError(Object.assign(new Error('Invalid vendor payload'), {
      code: 'vendor_payload_invalid',
    }))).toMatchObject({ failure: { errorCode: 'action_failed',
      failureCause: { errorCode: 'vendor_payload_invalid' } } });
  });

  it.each(['direct', 'cause'] as const)('keeps the typed public failure authoritative over CLI-like diagnostics (%s)', kind => {
    const failure = createActionExecuteFailureError({ ok: false, errorCode: 'action_failed', error: 'Invalid vendor payload',
      requestId: 'typed-request',
      failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'invalid_arguments', httpStatus: null } });
    const error = kind === 'direct' ? failure
      : Object.assign(new Error('Invalid vendor payload', { cause: failure }), { code: 'invalid_arguments' });
    expect(normalizeCliActionThrownError(error)).toMatchObject({ failure: { errorCode: 'action_failed', requestId: 'typed-request',
      failureCause: { errorCode: 'invalid_arguments' } } });
  });

  it('retains a typed public failure even when its diagnostic has no code', () => {
    const failure = createActionExecuteFailureError({ ok: false, errorCode: 'action_failed', error: 'Invalid vendor payload',
      failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: null, httpStatus: null } });
    expect(normalizeCliActionThrownError(failure)).toMatchObject({ failure: { errorCode: 'action_failed',
      failureCause: { errorCode: null } } });
  });

  it('keeps an original vendor failure when a private cause accessor throws', () => {
    const error = Object.assign(new Error('Invalid vendor payload'), { code: 'vendor_payload_invalid' });
    Object.defineProperty(error, 'cause', { get() { throw new Error('Private cause'); } });
    expect(normalizeCliActionThrownError(error)).toMatchObject({ failure: { errorCode: 'action_failed',
      failureCause: { errorCode: 'vendor_payload_invalid' } } });
  });

  it.each([null, { message: ['PRIVATE'], stderr: 'PRIVATE' }, { message: '   ', stderr: 'PRIVATE' }])('uses a generic refusal for malformed safe reasons (%j)', details => {
    const projected = projectCliActionFailure({ errorCode: 'action_interception_rejected', errorMessage: 'PRIVATE', details });
    expect(projected).toMatchObject({ code: 'action_interception_rejected', message: 'Action refused by an automation.',
      details: { message: null, messageTrust: 'workflow_supplied_untrusted' } });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE');
  });
  it.each(['outer', 'nested'] as const)('keeps workflow refusal text explicitly untrusted and excludes diagnostics (%s)', kind => {
    const refusal = { ok: false, errorCode: 'action_interception_rejected', error: 'PRIVATE',
      details: { message: 'Do not deploy yet.', stderr: 'PRIVATE' } } as const;
    const normalized = normalizeActionExecuteResult(kind === 'outer' ? refusal : { ok: true, result: refusal });
    if (normalized.ok) throw new Error('Expected refusal');
    const projected = projectCliActionFailure(normalized);
    expect(projected).toMatchObject({ code: refusal.errorCode, details: { message: refusal.details.message, messageTrust: 'workflow_supplied_untrusted' } });
    expect(projected.message).toContain('untrusted');
    expect(projected.message).toContain(refusal.details.message);
    expect(normalized.errorMessage).toBe(projected.message);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE');
  });

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
