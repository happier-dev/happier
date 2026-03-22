import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { buildExecutionRunProfileStartParams } from '@/agent/executionRuns/runtime/buildExecutionRunProfileStartParams';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';

export function getExecutionRunAvailableActionIds(
  run: ExecutionRunState,
  controller: ExecutionRunController | null,
): readonly string[] {
  if (run.intent === 'voice_agent') {
    if (!controller || controller.kind !== 'voice_agent') return [];
    return ['voice_agent.welcome', 'voice_agent.commit'];
  }

  const profile = resolveExecutionRunIntentProfile(run.intent);
  if (!profile.listAvailableActionIds) return [];

  return profile.listAvailableActionIds({
    start: buildExecutionRunProfileStartParams(run),
    structuredMeta: run.structuredMeta ?? null,
  });
}
