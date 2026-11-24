import { projectActionFailureCauseV1, readActionErrorCodeV1,
  type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Session control owners supply code-only boundary names, never input or private exception text. */
export function sessionControlUnavailable(phase: string, nativeErrorReason?: string): ActionExecuteFailure {
  return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
    failureCause: { phase, errorClass: 'Error', errorCode: 'target_unavailable', httpStatus: null,
      ...(nativeErrorReason ? { nativeErrorReason } : {}) } };
}

export function sessionControlThrownFailure(error: unknown, phase: string): ActionExecuteFailure {
  const errorCode = readActionErrorCodeV1(error) ?? 'action_failed';
  return { ok: false, errorCode, error: errorCode, failureCause: projectActionFailureCauseV1(error, phase) };
}
