import type { AgentAcpCompletionEvidenceOutcome } from './acp.js';
import type { AgentTranscriptFileFollowInput, AgentTranscriptFileFollowHandle } from './context.js';

/** Provider evidence only. The host retains and decides the originating input authority. */
export type AgentAcpProviderTurnSink = Readonly<{
  update(update: Readonly<Record<string, unknown>>): Promise<void>;
  finish(outcome: AgentAcpCompletionEvidenceOutcome, options?: Readonly<{ retainToolCallIds?: readonly string[] }>): Promise<void>;
}>;

export type AgentAcpProviderTurnAdmission = Readonly<{ id?: string; turnId: string }>;

export type AgentAcpProviderTurnSourceHost = Readonly<{
  sessionId: string;
  cwd: string;
  agentVersion?: string;
  /** Composed launch settings for this ACP process, before runner-private credential substitution.
   * Inheritance, explicit overrides and removals are already applied; managed credential slots retain their markers. */
  env: Readonly<Record<string, string | undefined>>;
  /** One native journal validated by the adapter, scoped to this source lifetime. */
  followJournal(input: Omit<AgentTranscriptFileFollowInput, 'signal'>): Promise<AgentTranscriptFileFollowHandle>;
  signal: AbortSignal;
  registerContinuation(input: Readonly<{ id: string; parentToolCallId: string }>): boolean;
  /** A missing id can only begin work after this source registered a witnessed continuation. */
  beginContinuation(input: AgentAcpProviderTurnAdmission): AgentAcpProviderTurnSink | null;
  releaseClaimedUpdates(updates: readonly Readonly<Record<string, unknown>>[]): Promise<void>;
  releaseToolCalls(toolCallIds: readonly string[]): void;
  fail(error: Error): void;
}>;

export type AgentAcpProviderTurnSource = Readonly<{
  /** Claim a current session's live ACP update before the normal prompt-turn fence. */
  claimLiveUpdate?(update: Readonly<Record<string, unknown>>, context: Readonly<{ foregroundActive: boolean }>): boolean | Promise<boolean>;
  /** This peer has produced autonomous work without attributing subsequent requests to inputs. */
  hasUnattributedWork?(): boolean;
  /** Active tool calls witnessed on a completed foreground turn that the peer will finish asynchronously. */
  onForegroundTurnFinished?(outcome: AgentAcpCompletionEvidenceOutcome): readonly string[];
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
