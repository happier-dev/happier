import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

export type HistoryGapRecoveryPresentation = 'resolving' | 'ready' | 'recovering' | 'unavailable' | 'failed';

/**
 * Which recovery state the History gap banner shows. The watcher facts still arriving read as resolving, so the
 * banner never says "unavailable" and then flips; it says unavailable only once the recovery owner settled it.
 */
export function readHistoryGapRecoveryPresentation(input: Readonly<{
    projectionPhase: DaemonMergedProjectionPhase;
    canRecover: boolean;
    recovering: boolean;
    recoveryFailed: boolean;
}>): HistoryGapRecoveryPresentation {
    if (input.recoveryFailed) return 'failed';
    if (input.recovering) return 'recovering';
    if (input.canRecover) return 'ready';
    return input.projectionPhase === 'idle' || input.projectionPhase === 'loading' ? 'resolving' : 'unavailable';
}
