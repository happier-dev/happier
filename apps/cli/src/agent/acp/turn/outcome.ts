import type { StopReason } from '@agentclientprotocol/sdk';

export type AcpTurnCompletedStopReason = Extract<
  StopReason,
  'end_turn' | 'max_tokens' | 'max_turn_requests'
>;

export type AcpTurnOutcome =
  | { kind: 'completed'; stopReason: AcpTurnCompletedStopReason }
  | { kind: 'aborted'; stopReason: Extract<StopReason, 'cancelled'> }
  | { kind: 'refused'; stopReason: Extract<StopReason, 'refusal'> }
  | { kind: 'failed'; error: Error }
  | { kind: 'timed_out'; capMs: number };
