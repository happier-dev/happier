import type { StopReason } from '@agentclientprotocol/sdk';

import type { AcpTurnOutcome } from './outcome';

export type AcpPromptStopReasonProjector = (stopReason: string) => StopReason | null;

export function readPromptStopReason(promptResponse: unknown): string | null {
  if (!promptResponse || typeof promptResponse !== 'object') return null;
  const stopReason = (promptResponse as { stopReason?: unknown }).stopReason;
  return typeof stopReason === 'string' ? stopReason : null;
}

export function mapStopReasonToAcpTurnOutcome(
  stopReason: string,
  projectStopReason?: AcpPromptStopReasonProjector,
): AcpTurnOutcome {
  switch (stopReason) {
    case 'cancelled':
      return { kind: 'aborted', stopReason };
    case 'refusal':
      return { kind: 'refused', stopReason };
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
      return { kind: 'completed', stopReason };
    default: {
      try {
        const projected = projectStopReason?.(stopReason);
        if (projected != null) {
          const outcome = mapStopReasonToAcpTurnOutcome(projected);
          if (outcome.kind !== 'unknown') return outcome;
        }
      } catch {
        // A failed plugin projection supplies no evidence about the native outcome.
      }
      return { kind: 'unknown', stopReason };
    }
  }
}
