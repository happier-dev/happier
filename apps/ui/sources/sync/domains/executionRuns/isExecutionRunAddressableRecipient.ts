import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';

type ExecutionRunAddressabilityShape = Readonly<{
    status?: unknown;
    intent?: unknown;
    runClass?: unknown;
    turnInFlight?: unknown;
}>;

function readNormalizedString(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * May a person choose this run as the destination of their next message?
 *
 * This answers **addressability**, not interaction capability. It runs on
 * transcript-derived roster facts — the only evidence a Session roster has — and
 * a positive answer means the composer may target the run so canonical Session
 * input admission can durably queue the input against it. Admission then owns
 * what actually happens: an unproven or unloaded target stays visibly queued, and
 * a positively terminal or noninteractive target moves through the blocked
 * Pending lifecycle. Nothing here reaches a runtime.
 *
 * What this must never do is authorize a mutation control. Whether a run can
 * accept a turn, be steered, be cancelled or be resumed is owned solely by
 * `resolveExecutionRunInteractionAffordances`, which reads the daemon's exact
 * `interaction` projection for a live retained controller. Voice keeps its own
 * dedicated surface and is not addressable from a Session composer.
 */
export function isExecutionRunAddressableRecipient(
    run: ExecutionRunAddressabilityShape | ExecutionRunPublicState | null | undefined,
): boolean {
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
