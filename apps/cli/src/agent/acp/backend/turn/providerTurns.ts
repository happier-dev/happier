import type { AcpTurnOutcome } from './_types';
import type { SessionUpdate } from '../../updates/types';

export type AcpProviderTurnSink = Readonly<{
  update(update: SessionUpdate): Promise<void>;
  finish(outcome: AcpTurnOutcome): Promise<void>;
}>;

export type AcpProviderTurnSourceHost = Readonly<{
  sessionId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  registerContinuation(input: Readonly<{ id: string; parentToolCallId: string }>): boolean;
  beginContinuation(input: Readonly<{ id: string; turnId: string }>): AcpProviderTurnSink | null;
  /** The native journal has crossed the parent terminal and all task registrations. */
  releaseToolCalls(toolCallIds: readonly string[]): void;
  /** Return claimed live updates that no continuation will publish to generic handling, in arrival order. */
  releaseClaimedUpdates(updates: readonly SessionUpdate[]): void;
  fail(error: Error): void;
}>;

export type AcpProviderTurnSource = Readonly<{
  catchUp(input?: Readonly<{ permissionToolCallId?: string; foregroundActive?: boolean; signal?: AbortSignal }>): Promise<void>;
  /**
   * Offer a live, non-replayed ACP update for the active session before generic turn filtering.
   * Returning true transfers it to the source, which must publish it through an admitted continuation sink
   * or hand it back with `releaseClaimedUpdates`.
   */
  claimLiveUpdate?(update: SessionUpdate, context: Readonly<{ foregroundActive: boolean }>): boolean;
  dispose(): void | Promise<void>;
}>;

export type AcpProviderTurnSourceFactory = (
  host: AcpProviderTurnSourceHost,
) => Promise<AcpProviderTurnSource>;
