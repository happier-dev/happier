import type { PromptResponse, StopReason } from '@agentclientprotocol/sdk';

import type { AcpTurnOutcome } from './outcome';

const ACP_STOP_REASONS: ReadonlySet<StopReason> = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

export function readPromptStopReason(promptResponse: PromptResponse | unknown): StopReason | null {
  if (!promptResponse || typeof promptResponse !== 'object') return null;
  const stopReason = (promptResponse as { stopReason?: unknown }).stopReason;
  if (typeof stopReason !== 'string') return null;
  return ACP_STOP_REASONS.has(stopReason as StopReason) ? (stopReason as StopReason) : null;
}

export function mapStopReasonToAcpTurnOutcome(stopReason: StopReason): AcpTurnOutcome {
  switch (stopReason) {
    case 'cancelled':
      return { kind: 'aborted', stopReason };
    case 'refusal':
      return { kind: 'refused', stopReason };
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
      return { kind: 'completed', stopReason };
  }
}
