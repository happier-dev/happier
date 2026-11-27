import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

export type LiveStreamPlayerDiagnostic = Readonly<{
    reasonCode: string;
}> & Pick<ActionExecuteFailure, 'failureCause' | 'effectAttempted'>;

export function createLiveStreamPlayerDiagnostic(input: Readonly<{
    reasonCode?: string | null;
    message?: string | null;
}> & Pick<LiveStreamPlayerDiagnostic, 'failureCause' | 'effectAttempted'>): LiveStreamPlayerDiagnostic {
    const reasonCode = typeof input.reasonCode === 'string' && input.reasonCode.trim().length > 0
        ? input.reasonCode.trim()
        : 'stream_player_error';
    return { reasonCode, ...(input.failureCause ? { failureCause: input.failureCause } : {}),
        ...(typeof input.effectAttempted === 'boolean' ? { effectAttempted: input.effectAttempted } : {}) };
}
