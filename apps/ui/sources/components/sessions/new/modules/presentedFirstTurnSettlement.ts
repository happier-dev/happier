import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { SessionSpawnNewActionResult } from '@/sync/ops/actions/sessionSpawnNewAction';
import {
    resolveSessionSpawnNewActionFailureMessage,
    resolveSessionSpawnNewOperationFailureMessage,
    resolveSessionSpawnNewResultFailureMessage,
} from '@/sync/ops/actions/sessionSpawnFailurePresentation';

export type PresentedFirstTurn = Readonly<{ sessionId: string; firstTurnLocalId: string | null }>;
export type PresentedFirstTurnSettlement = Exclude<NonNullable<PendingMessage['pendingLaunch']>, Readonly<{ state: 'starting' }>>;

/**
 * The one settle path for a first message presented at its Session's commit. Every launch exit ends the
 * row's "starting" state exactly once: a typed refusal or failed operation says why ("Didn't start" + the
 * draft that keeps the input), accepted input is left to its committed message, and anything else is
 * unresolved (it may already have reached the agent).
 */
export function createPresentedFirstTurnSettlement(params: Readonly<{
    draftId: string | null;
    readCanonicalOperation: () => Pick<ActionOperationSnapshotV1, 'state' | 'error'> | null;
    write: (presented: PresentedFirstTurn, settlement: PresentedFirstTurnSettlement) => void;
}>) {
    let presented: PresentedFirstTurn | null = null;
    let settled = false;
    let lastResult: SessionSpawnNewActionResult | null = null;

    const resolveFailureMessage = (): string | null => {
        if (lastResult?.ok) {
            return lastResult.result.type === 'error' ? resolveSessionSpawnNewResultFailureMessage(lastResult.result) : null;
        }
        const operation = params.readCanonicalOperation();
        const known = operation?.state === 'failed' || operation?.state === 'cancelled';
        if (lastResult && known) return resolveSessionSpawnNewActionFailureMessage(lastResult);
        if (known && operation?.error) return resolveSessionSpawnNewOperationFailureMessage(operation.error);
        return null;
    };

    return {
        presented: (): PresentedFirstTurn | null => presented,
        present(value: PresentedFirstTurn): void {
            presented = value;
        },
        observe(result: SessionSpawnNewActionResult): void {
            lastResult = result;
        },
        /**
         * A launch presented at commit has handed its launcher on (a docked composer renews to a fresh
         * draft): its completion — custody, consuming the submitted draft once, accepted input — no longer
         * depends on what the launcher now shows. Before hand-off, the launcher's current scope decides.
         */
        ownsCompletion(launcherScopeCurrent: boolean): boolean {
            return launcherScopeCurrent || presented !== null;
        },
        /** The created-Session branch already projected or handed off the input. */
        markSettled(): void {
            settled = true;
        },
        /**
         * Mid-launch calls settle only a known non-success; the final call (the launch's exit) settles
         * whatever is still starting.
         */
        settle(options: Readonly<{ final: false } | { final: true; acceptedLocalId: string | null }>): void {
            if (settled || !presented?.firstTurnLocalId) return;
            const succeeded = lastResult?.ok === true && lastResult.result.type === 'success';
            if (succeeded && (!options.final || options.acceptedLocalId === presented.firstTurnLocalId)) return;
            const message = succeeded ? null : resolveFailureMessage();
            if (!options.final && message === null) return;
            settled = true;
            params.write(presented, message !== null
                ? { state: 'failed', message, draftId: params.draftId }
                : { state: 'unresolved' });
        },
    };
}
