import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

export function publishInFlightSteerCapability(opts: {
  session: { updateAgentState: (updater: (current: AgentState) => AgentState) => Promise<void> | void };
  runtime: { supportsInFlightSteer: () => boolean };
}): void {
  const supported = opts.runtime.supportsInFlightSteer() === true;
  updateAgentStateBestEffort(
    opts.session,
    (currentState) => ({
      ...currentState,
      capabilities: {
        ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
        inFlightSteer: supported,
      },
    }),
    '[codex]',
    'publish_in_flight_steer_capability',
  );
}
