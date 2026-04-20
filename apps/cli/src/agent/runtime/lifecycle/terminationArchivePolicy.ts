import type { RunnerTerminationEvent, RunnerTerminationOutcome } from './runnerTerminationOutcome';

export function resolveTerminationArchiveDecision(params: Readonly<{
    startedBy?: 'daemon' | 'terminal';
    event: RunnerTerminationEvent;
    outcome: RunnerTerminationOutcome;
}>): Readonly<{ archive: boolean; archiveReason: string | null }> {
    if (params.event.kind === 'killSession' && params.startedBy === 'daemon') {
        return { archive: false, archiveReason: null };
    }

    if (params.startedBy === 'daemon') {
        return { archive: false, archiveReason: null };
    }

    return {
        archive: params.outcome.archive,
        archiveReason: params.outcome.archive ? (params.outcome.archiveReason ?? null) : null,
    };
}
