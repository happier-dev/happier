import * as React from 'react';
import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationStatusV1,
} from '@happier-dev/protocol/sessions/external/operationV1';

import {
    presentExternalSessionOperationProgress,
    resolveExternalSessionOperationStatusSummaryKey,
} from '@/components/sessions/external/progress/externalSessionOperationProgressPresentation';
import { Modal } from '@/modal';
import { t } from '@/text';

export type UseExternalSessionContinueInNewSessionResult = Readonly<{
    /** Replay is on and the transcript is either importable now or already published. */
    available: boolean;
    /** Continue started an import and is following it to its published snapshot. */
    inFlight: boolean;
    requestContinue: () => Promise<void>;
}>;

type ContinuePhase =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'starting_import' }>
    | Readonly<{ kind: 'importing'; operationId: string }>;

const IDLE: ContinuePhase = { kind: 'idle' };

/**
 * The import has stopped without producing a copy: it failed, needs the reader (resume or review), or
 * ended cancelled/discarded. `completed` is the success path even before the storage state reports the
 * published snapshot; `running`/`cancel_requested` are still moving.
 */
function importSettledWithoutCopy(status: ExternalSessionOperationStatusV1): boolean {
    return status !== 'running' && status !== 'cancel_requested' && status !== 'completed';
}

function showImportOutcome(bodyKey: Parameters<typeof t>[0]): void {
    Modal.alert(t('common.error'), t(bodyKey));
}

/**
 * "Continue in a new session" for an opened external session nobody can take over: one press imports
 * the transcript when it is not imported yet (the existing materialize owner) and then opens the existing
 * replay fork flow (the fork strategy modal, submitting Replay itself). It only sequences those two
 * owners; neither the import nor the fork is re-implemented here.
 *
 * The import is a machine operation that outlives its start request, so Continue follows the exact
 * operation the start reply names. It forks once the transcript's snapshot is published, and leaves busy
 * with the import owner's own status line when that operation settles without a copy — from the start
 * reply itself, or from the pushed operation status. No timer decides it.
 */
export function useExternalSessionContinueInNewSession(params: Readonly<{
    sessionId: string;
    /** The `sessionReplayEnabled` setting: the only closable cause of the Replay route. */
    replayEnabled: boolean;
    /** The transcript lives only on the source machine and must be imported first. */
    materializeNeeded: boolean;
    /** The imported transcript snapshot is published, so Replay can seed from it. */
    importPublished: boolean;
    /** The pushed presentation of the Session's current external-session operation, if any. */
    operation: Readonly<{ operationId: string; status: ExternalSessionOperationStatusV1 }> | null;
    requestMaterialize: () => Promise<ExternalSessionOperationProgressV1 | null>;
    openReplayFork: () => void;
}>): UseExternalSessionContinueInNewSessionResult {
    const [phase, setPhase] = React.useState<ContinuePhase>(IDLE);
    const phaseRef = React.useRef<ContinuePhase>(IDLE);
    const applyPhase = React.useCallback((next: ContinuePhase) => {
        phaseRef.current = next;
        setPhase(next);
    }, []);
    // A call (not a property read) so a check after an await is not narrowed by the one before it.
    const readPhase = React.useCallback((): ContinuePhase => phaseRef.current, []);
    const { openReplayFork, requestMaterialize } = params;
    const openReplayForkRef = React.useRef(openReplayFork);
    openReplayForkRef.current = openReplayFork;

    // A different Session never inherits a pending continuation.
    React.useEffect(() => {
        applyPhase(IDLE);
    }, [applyPhase, params.sessionId]);

    const available = params.replayEnabled
        && (params.materializeNeeded || params.importPublished);

    const requestContinue = React.useCallback(async (): Promise<void> => {
        if (!available || phaseRef.current.kind !== 'idle') return;
        if (!params.materializeNeeded) {
            openReplayFork();
            return;
        }
        applyPhase({ kind: 'starting_import' });
        // The import owner reports its own refusals (offline, permission, daemon error) visibly.
        const started = await requestMaterialize();
        // Read the phase again after the await: a dismiss or remount may have replaced it.
        if (readPhase().kind !== 'starting_import') return;
        if (!started) {
            applyPhase(IDLE);
            return;
        }
        if (importSettledWithoutCopy(started.status)) {
            applyPhase(IDLE);
            const presentation = presentExternalSessionOperationProgress(started, {
                observationContext: 'live',
                originAvailability: 'online',
            });
            showImportOutcome(presentation.detailKey ?? presentation.summaryKey);
            return;
        }
        applyPhase({ kind: 'importing', operationId: started.operationId });
    }, [applyPhase, available, openReplayFork, params.materializeNeeded, readPhase, requestMaterialize]);

    const operationId = params.operation?.operationId ?? null;
    const operationStatus = params.operation?.status ?? null;
    React.useEffect(() => {
        if (phase.kind !== 'importing') return;
        if (params.importPublished) {
            applyPhase(IDLE);
            openReplayForkRef.current();
            return;
        }
        // Only the operation this press started can settle it; an earlier one's state says nothing.
        if (operationId !== phase.operationId || operationStatus === null) return;
        if (!importSettledWithoutCopy(operationStatus)) return;
        applyPhase(IDLE);
        showImportOutcome(resolveExternalSessionOperationStatusSummaryKey(operationStatus));
    }, [applyPhase, operationId, operationStatus, params.importPublished, phase]);

    return React.useMemo(() => ({
        available,
        inFlight: phase.kind !== 'idle',
        requestContinue,
    }), [available, phase.kind, requestContinue]);
}
