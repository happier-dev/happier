import type { AgentState, InFlightSteerUnavailableReason } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

export function publishInFlightSteerCapability(opts: {
  session: { updateAgentState: (updater: (current: AgentState) => AgentState) => Promise<void> | void };
  runtime: { supportsInFlightSteer: () => boolean; canSteerPrompt?: () => boolean };
  nowMs?: () => number;
}): void {
  const supported = opts.runtime.supportsInFlightSteer() === true;
  const available = supported && (opts.runtime.canSteerPrompt?.() ?? supported) === true;
  // Seam A: publish WHY steering is unavailable so the UI can stop pretending a non-steerable
  // send was delivered. Reason is null when available (back-compat by optionality).
  const unavailableReason: InFlightSteerUnavailableReason | null = !supported
    ? 'backend_unsupported'
    : !available
      ? 'unsafe_window'
      : null;
  const stateAt = (opts.nowMs ?? Date.now)();
  updateAgentStateBestEffort(
    opts.session,
    (currentState) => ({
      ...currentState,
      capabilities: {
        ...(currentState.capabilities && typeof currentState.capabilities === 'object' ? currentState.capabilities : {}),
        inFlightSteer: supported,
        inFlightSteerSupported: supported,
        inFlightSteerAvailable: available,
        inFlightSteerUnavailableReason: unavailableReason,
        inFlightSteerStateAt: stateAt,
      },
    }),
    '[codex]',
    'publish_in_flight_steer_capability',
  );
}
