export type PiCompactionTurnState = Readonly<{
  agentSettled: boolean;
  lastAssistantStopReason: string | null;
  lastCompactionEnd: Readonly<{
    payload?: Readonly<Record<string, unknown>> | null;
    willRetry: boolean;
    errorMessage: string | null;
    phase?: string | null;
    errorCode?: string | null;
  }> | null;
}>;

export type PiCompactionTurnOutcome = 'completed_post_final' | 'terminal_failure' | 'pause';
