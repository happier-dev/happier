import type { AgentState } from '@/api/types';

export function publishInFlightSteerCapability(opts: {
  session: { updateAgentState: (updater: (current: AgentState) => AgentState) => void };
  runtime: { supportsInFlightSteer: () => boolean };
}): void {
  const supported = opts.runtime.supportsInFlightSteer() === true;
  opts.session.updateAgentState((currentState) => ({
    ...currentState,
    capabilities: {
      ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
      inFlightSteer: supported,
    },
  }));
}

