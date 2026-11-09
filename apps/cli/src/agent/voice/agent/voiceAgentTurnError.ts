import { readExecutionRunRuntimeIssue } from '@/agent/runtime/bridges/executionRun/errors';

/** Keep the runtime owner's category on Voice's existing failure-code projection. */
export function normalizeVoiceAgentTurnError(error: unknown): unknown {
  const issue = readExecutionRunRuntimeIssue(error);
  if (error && typeof error === 'object' && issue?.source === 'usage_limit') {
    return Object.assign(error, { executionRunErrorCode: 'usage_limit',
      ...(issue.usageLimit?.resetAtMs != null ? { usageLimitResetAtMs: issue.usageLimit.resetAtMs } : {}),
    });
  }
  return error;
}
