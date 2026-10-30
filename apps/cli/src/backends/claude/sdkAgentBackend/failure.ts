import type { SDKResultMessage } from '@/backends/claude/sdk/types';
import { classifyClaudeConnectedServiceRuntimeAuthFailure } from '../connectedServices/classifyClaudeConnectedServiceRuntimeAuthFailure';
import { mapClaudeProviderFailureToUsageDetails } from '../connectedServices/mapClaudeRateLimitEventToUsageDetails';

export function createClaudeSdkResultError(result: SDKResultMessage): Error {
  const runtimeAuthClassification = classifyClaudeConnectedServiceRuntimeAuthFailure({ error: result })
    ?? classifyClaudeConnectedServiceRuntimeAuthFailure({
      error: result,
      details: mapClaudeProviderFailureToUsageDetails(result),
    });
  return Object.assign(new Error(`Claude SDK error: ${result.subtype}`), { runtimeAuthClassification });
}
