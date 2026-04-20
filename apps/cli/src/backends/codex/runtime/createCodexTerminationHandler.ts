import type { RunnerTerminationEvent, RunnerTerminationOutcome } from '@/agent/runtime/lifecycle/runnerTerminationOutcome';
import { resolveTerminationArchiveDecision } from '@/agent/runtime/lifecycle/terminationArchivePolicy';

export function createCodexTerminationHandler(params: Readonly<{
    startedBy?: 'daemon' | 'terminal';
    setShouldExit: (value: boolean) => void;
    handleAbort: () => Promise<void>;
    archiveSession: (archiveReason: string | null) => Promise<void>;
    cleanupRunResources: () => Promise<void>;
    stopCaffeinate: () => void;
    logDebug: (message: string, error?: unknown) => void;
}>): (event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => Promise<void> {
    return async (event, outcome) => {
        params.setShouldExit(true);
        await params.handleAbort();

        const archiveDecision = resolveTerminationArchiveDecision({
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
