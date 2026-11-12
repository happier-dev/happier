import { describe, expect, it } from 'vitest';
import { projectContributedActionFailure } from './contributedActionFailure';

describe('projectContributedActionFailure', () => {
  it('preserves host schema diagnostics across the public failure boundary', () => {
    const failure = {
      errorCode: 'plugin_action_input_schema_invalid',
      error: 'plugin_action_input_schema_invalid',
      details: { issues: [{ path: ['resource'], code: 'const' }] },
    };
    expect(projectContributedActionFailure(failure).details).toEqual(failure.details);
  });
});

import { projectStructuredMessageActionFailure, contributedActionFailureResult } from './contributedActionFailure';
it('retains authored cause and correlation through immediate and retained daemon refusals', () => {
  const failure = { errorCode: 'credential_scope_denied', error: 'Choose another credential',
    data: { details: { requestId: 'daemon-refusal', effectAttempted: false },
      failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null },
      remediation: { kind: 'retry' } } } as const;
  const projected = projectStructuredMessageActionFailure(failure);
  expect(projected).toMatchObject({ ok: false, code: failure.errorCode, requestId: 'daemon-refusal', effectAttempted: false,
    failureCause: failure.data.failureCause, remediation: failure.data.remediation });
  const retained = contributedActionFailureResult.read(projected);
  expect(retained).toMatchObject({ errorCode: failure.errorCode, data: failure.data });
});
