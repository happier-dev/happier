import type { AgentAcpCompletionEvidenceOutcome } from './acp.js';
import type { AgentTranscriptFileFollowInput, AgentTranscriptFileFollowHandle } from './context.js';

/** Provider evidence only. The host retains and decides the originating input authority. */
export type AgentAcpProviderTurnSink = Readonly<{
  update(update: Readonly<Record<string, unknown>>): Promise<void>;
  finish(outcome: AgentAcpCompletionEvidenceOutcome): Promise<void>;
}>;

export type AgentAcpProviderTurnSourceHost = Readonly<{
  sessionId: string;
  cwd: string;
  /** The finalized environment used to spawn this exact ACP process. */
  env: Readonly<Record<string, string | undefined>>;
  /** One native journal validated by the adapter, scoped to this source lifetime. */
  followJournal(input: Omit<AgentTranscriptFileFollowInput, 'signal'>): Promise<AgentTranscriptFileFollowHandle>;
  signal: AbortSignal;
  registerContinuation(input: Readonly<{ id: string; parentToolCallId: string }>): boolean;
  beginContinuation(input: Readonly<{ id: string; turnId: string }>): AgentAcpProviderTurnSink | null;
  releaseToolCalls(toolCallIds: readonly string[]): void;
  fail(error: Error): void;
}>;

export type AgentAcpProviderTurnSource = Readonly<{
  catchUp(input?: Readonly<{
    permissionToolCallId?: string;
    foregroundActive?: boolean;
    signal?: AbortSignal;
  }>): Promise<void>;
  dispose(): void | Promise<void>;
}>;

export type AgentAcpProviderTurnSourceFactory = (
  host: AgentAcpProviderTurnSourceHost,
) => Promise<AgentAcpProviderTurnSource>;
