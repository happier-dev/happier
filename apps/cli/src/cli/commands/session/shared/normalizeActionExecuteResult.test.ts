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
