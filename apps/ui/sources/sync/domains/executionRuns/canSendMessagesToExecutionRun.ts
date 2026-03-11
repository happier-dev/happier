import type { ExecutionRunPublicState } from '@happier-dev/protocol';

type ExecutionRunMessagingShape = Readonly<{
    status?: unknown;
    intent?: unknown;
    runClass?: unknown;
    turnInFlight?: unknown;
}>;

function readNormalizedString(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function canSendMessagesToExecutionRun(run: ExecutionRunMessagingShape | ExecutionRunPublicState | null | undefined): boolean {
    if (!run || typeof run !== 'object') return false;
    const status = readNormalizedString(run.status);
    if (status !== 'running') return false;

    const intent = readNormalizedString(run.intent);
    if (intent === 'voice_agent') return false;

    const runClass = readNormalizedString(run.runClass);
    const turnInFlight = typeof run.turnInFlight === 'boolean' ? run.turnInFlight : null;
    if (runClass === 'bounded' && turnInFlight === false) return false;
    if (!runClass) return true;
    return runClass === 'bounded' || runClass === 'long_lived';
}
