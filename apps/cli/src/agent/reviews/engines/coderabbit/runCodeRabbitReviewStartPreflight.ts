import {
  executionRunStartNotAllowed,
  type ExecutionRunIntentStartPreflightParams,
  type ExecutionRunStartIntentPolicyResult,
} from '@/agent/executionRuns/policy/executionRunStartPreflight';

import { preflightCodeRabbitReviewScope } from './preflightCodeRabbitReviewScope';
import { readCodeRabbitReviewConfigFromEnv } from './readCodeRabbitReviewConfig';

export async function runCodeRabbitReviewStartPreflight(
  params: ExecutionRunIntentStartPreflightParams,
): Promise<ExecutionRunStartIntentPolicyResult> {
  const codeRabbitConfig = readCodeRabbitReviewConfigFromEnv(params.env);

  try {
    const preflight = await preflightCodeRabbitReviewScope({
      cwd: params.cwd,
      intentInput: params.intentInput,
      maxEligibleFiles: codeRabbitConfig.maxEligibleFiles,
    });
    return preflight.ok ? { ok: true } : executionRunStartNotAllowed(preflight.error);
  } catch (error) {
    return executionRunStartNotAllowed(error instanceof Error ? error.message : 'Execution run not allowed');
  }
}
