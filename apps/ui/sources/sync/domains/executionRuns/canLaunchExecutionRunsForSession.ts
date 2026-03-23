import type { Session } from '@/sync/domains/state/storageTypes';

function hasLiveExecutionRunBackends(backends: Record<string, unknown> | null | undefined): boolean {
    return Boolean(backends && typeof backends === 'object' && Object.keys(backends).length > 0);
}

export function canLaunchExecutionRunsForSession(input: Readonly<{
    session: Session | null | undefined;
    executionRunsSupported: boolean;
    executionRunsBackends: Record<string, unknown> | null | undefined;
    allowWhileInactive?: boolean;
    hasDirectSessionLink?: boolean;
    directSessionRunnerActive?: boolean | null | undefined;
}>): boolean {
    if (input.session?.active === false && input.allowWhileInactive !== true) return false;
    if (input.hasDirectSessionLink === true && input.directSessionRunnerActive !== true) return false;
    if (input.executionRunsSupported !== true) return false;
    return hasLiveExecutionRunBackends(input.executionRunsBackends);
}
