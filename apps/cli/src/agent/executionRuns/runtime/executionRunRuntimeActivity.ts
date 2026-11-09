import type { ExecutionRunState } from './executionRunTypes';
import type { SessionRuntimeActivityContribution } from '@/session/runtimeActivity/types';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { isExecutionRunActive } from '@happier-dev/protocol';

export function readExecutionRunTurnInFlight(
  controller: ExecutionRunController | undefined,
  isVoiceAgentTurnInFlight: (voiceAgentId: string) => boolean,
): boolean | undefined {
  if (!controller) return undefined;
  if (controller.kind === 'voice_agent') return isVoiceAgentTurnInFlight(controller.voiceAgentId);
  // A visible run's turns happen in the linked child Session; this runner observes no provider turn.
  if (controller.kind === 'session') return undefined;
  // Until provisioning finishes, a false provider-turn flag does not mean the admitted run is idle.
  return controller.childSessionId ? controller.turnInFlight : undefined;
}

export function deriveExecutionRunRuntimeActivityContribution(
  runs: ReadonlyMap<string, ExecutionRunState>,
  controllers: ReadonlyMap<string, ExecutionRunController>,
  isVoiceAgentTurnInFlight: (voiceAgentId: string) => boolean,
): SessionRuntimeActivityContribution {
  let activeCount = 0;
  for (const run of runs.values()) {
    const turnInFlight = readExecutionRunTurnInFlight(controllers.get(run.runId), isVoiceAgentTurnInFlight);
    if (isExecutionRunActive({ status: run.status, runClass: run.runClass, turnInFlight })) activeCount += 1;
  }
  return activeCount > 0
    ? { state: 'active', activeCount }
    : { state: 'idle', activeCount: 0 };
}
