import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';

/** A Skill Action can refuse at the executor or at its domain boundary. */
export function readSkillActionRefusal(result: ActionExecuteResult): string | null {
  if (!result.ok) return result.errorCode ?? result.error ?? 'unknown';
  const value = result.result;
  if (value && typeof value === 'object' && 'ok' in value && value.ok === false) {
    return 'code' in value && typeof value.code === 'string' ? value.code : 'unknown';
  }
  return null;
}

export function readSkillActionFailure(error: unknown) {
  const code = readActionErrorCodeV1(error) ?? 'internal_error';
  const message = error instanceof Error ? error.message
    : error && typeof error === 'object' && 'error' in error && typeof error.error === 'string' ? error.error : code;
  return { code, message: redactBugReportSensitiveText(message) };
}
