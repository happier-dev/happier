import { buildExecutionRunRolePromptBlockTextV1 } from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileStartParams,
} from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

/**
 * The one prompt composition every run send uses: the run-scoped role block (when the run carries a
 * role), then the profile prompt, which holds the caller's instructions and ends with the profile's
 * output contract. A roleless run receives exactly the profile prompt.
 */
export function buildExecutionRunPrompt(
  profile: Pick<ExecutionRunIntentProfile, 'buildPrompt'>,
  start: ExecutionRunProfileStartParams,
): string {
  const prompt = profile.buildPrompt(start);
  if (!start.role) return prompt;
  return `${buildExecutionRunRolePromptBlockTextV1(start.role)}\n\n${prompt}`;
}
