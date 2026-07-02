export type CodexRunnerTerminationOutcome = Readonly<{
  archive: boolean;
  archiveReason: string | null;
}>;

export type CodexRunnerTerminationEvent = unknown;

export function createCodexTerminationHandler(params: Readonly<{
  startedBy?: 'daemon' | 'terminal';
  setShouldExit: (value: boolean) => void;
  handleAbort: () => Promise<void>;
  archiveSession: (archiveReason: string | null) => Promise<void>;
  cleanupRunResources: () => Promise<void>;
  stopCaffeinate: () => void;
  logDebug: (message: string, error?: unknown) => void;
  resolveArchiveDecision?: (args: Readonly<{
    startedBy?: 'daemon' | 'terminal';
    event: CodexRunnerTerminationEvent;
    outcome: CodexRunnerTerminationOutcome;
  }>) => Readonly<{ archive: boolean; archiveReason: string | null }>;
}>): (event: CodexRunnerTerminationEvent, outcome: CodexRunnerTerminationOutcome) => Promise<void> {
  const resolveArchiveDecision = params.resolveArchiveDecision ?? ((args) => ({
    archive: args.startedBy !== 'daemon' && args.outcome.archive,
    archiveReason: args.outcome.archiveReason,
  }));

  return async (event, outcome) => {
    params.setShouldExit(true);
    await params.handleAbort();

    const archiveDecision = resolveArchiveDecision({
      startedBy: params.startedBy,
      event,
      outcome,
    });

    try {
      if (archiveDecision.archive) {
        await params.archiveSession(archiveDecision.archiveReason);
      }
    } catch (error) {
      params.logDebug('[Codex] Failed to archive session during termination (non-fatal)', error);
    }

    try {
      await params.cleanupRunResources();
    } catch (error) {
      params.logDebug('[Codex] Cleanup failure during termination (non-fatal)', error);
    } finally {
      params.stopCaffeinate();
    }
  };
}

