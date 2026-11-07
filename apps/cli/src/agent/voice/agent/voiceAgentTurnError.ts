import { readExecutionRunRuntimeIssue } from '@/agent/runtime/bridges/executionRun/errors';

/** Keep the runtime owner's category on Voice's existing failure-code projection. */
export function normalizeVoiceAgentTurnError(error: unknown): unknown {
  if (error && typeof error === 'object' && readExecutionRunRuntimeIssue(error)?.source === 'usage_limit') {
    return Object.assign(error, { executionRunErrorCode: 'usage_limit' });
  }
  return error;
}
