import {
    createTranscriptViewportController,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportController';
import {
    createTranscriptViewportOwnership,
    type TranscriptViewportCloseTransactionResult,
    type TranscriptViewportOpenTransactionResult,
    type TranscriptViewportPreemptResult,
    type TranscriptViewportTransactionOutcome,
    type TranscriptViewportTransactionOwner,
} from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
    TranscriptViewportOwner,
    TranscriptViewportScrollReason,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export type TranscriptViewportRejectedWrite = Readonly<{
    activeOwner: TranscriptViewportOwner;
    command: TranscriptViewportCommand;
    rejectedOwner: TranscriptViewportOwner;
}>;

export type TranscriptViewportCommandExecutionAdapter = Readonly<{
    clearWebPrependRestoreWindow: (outcome: TranscriptViewportTransactionOutcome) => void;
    hasWebPrependRestoreWindow: () => boolean;
    isWeb: boolean;
    perform: (command: TranscriptViewportCommand) => boolean;
    recordRejectedWrite: (write: TranscriptViewportRejectedWrite) => void;
}>;

export type TranscriptViewportCommandController = Readonly<{
    activeOwner: () => TranscriptViewportOwner;
    canWrite: (owner: TranscriptViewportOwner) => boolean;
    closeTransaction: (
        owner: TranscriptViewportTransactionOwner,
        outcome: TranscriptViewportTransactionOutcome,
    ) => TranscriptViewportCloseTransactionResult;
    execute: (command: TranscriptViewportCommand, adapter: TranscriptViewportCommandExecutionAdapter) => boolean;
    openTransaction: (owner: TranscriptViewportTransactionOwner) => TranscriptViewportOpenTransactionResult;
    preempt: (owner: TranscriptViewportTransactionOwner) => TranscriptViewportPreemptResult;
    resetForSession: (params: Readonly<{ openEntryTransaction: boolean; sessionId: string }>) => void;
    resolve: (input: TranscriptViewportControllerInput) => TranscriptViewportCommand;
    setActive: (active: boolean) => void;
    setCurrentSessionId: (sessionId: string) => void;
}>;

function resolveTranscriptViewportWriteOwner(
    reason: TranscriptViewportScrollReason,
    entryPhaseOpen: boolean,
): Exclude<TranscriptViewportOwner, 'idle'> {
    switch (reason) {
        case 'entry-restore':
            return 'entry';
        case 'prepend-restore':
            return 'prepend';
        case 'jump-to-bottom':
        case 'jump-to-seq':
            return 'explicit';
        case 'initial-open':
        case 'mount-settle':
            return entryPhaseOpen ? 'entry' : 'follow';
        default:
            return 'follow';
    }
}

export function createTranscriptViewportCommandController(): TranscriptViewportCommandController {
    let active = true;
    let currentSessionId: string | null = null;
    let resolver = createTranscriptViewportController();
    let ownership = createTranscriptViewportOwnership();

    const resetForSession = (params: Readonly<{ openEntryTransaction: boolean; sessionId: string }>) => {
        currentSessionId = params.sessionId;
        resolver = createTranscriptViewportController();
        ownership = createTranscriptViewportOwnership();
        if (params.openEntryTransaction) {
            ownership.openTransaction('entry');
        }
    };

    const closeTransaction = (
        owner: TranscriptViewportTransactionOwner,
        outcome: TranscriptViewportTransactionOutcome,
    ) => ownership.closeTransaction(owner, outcome);

    const activeOwner = () => ownership.activeOwner();

    const execute = (
        command: TranscriptViewportCommand,
        adapter: TranscriptViewportCommandExecutionAdapter,
    ): boolean => {
        if (command.kind === 'none') return false;
        if (!active) return false;
        if (command.sessionId !== currentSessionId) return false;

        const commandOwner = resolveTranscriptViewportWriteOwner(
            command.reason,
            ownership.activeOwner() === 'entry',
        );
        if (commandOwner === 'explicit') {
            ownership.preempt('explicit');
            ownership.closeTransaction('explicit', 'confirmed');
            // Explicit writes (jump-to-bottom, jump-to-seq, nav-rail/panel jumps) move the
            // viewport away from any pending web prepend anchor. Clear the restore window at
            // this single chokepoint so a stale content-growth restore cannot re-assert the
            // old mid-transcript position after the explicit write lands.
            if (adapter.isWeb && adapter.hasWebPrependRestoreWindow()) {
                adapter.clearWebPrependRestoreWindow('preempted');
            }
        } else {
            if (adapter.isWeb && ownership.activeOwner() === 'prepend' && !adapter.hasWebPrependRestoreWindow()) {
                ownership.closeTransaction('prepend', 'abandoned-identity');
            }
            if (adapter.isWeb && commandOwner === 'prepend' && ownership.activeOwner() === 'follow') {
                ownership.openTransaction('prepend');
            }
            if (!ownership.canWrite(commandOwner)) {
                adapter.recordRejectedWrite({
                    command,
                    rejectedOwner: commandOwner,
                    activeOwner: ownership.activeOwner(),
                });
                return false;
            }
        }

        return adapter.perform(command);
    };

    return {
        activeOwner,
        canWrite: (owner) => ownership.canWrite(owner),
        closeTransaction,
        execute,
        openTransaction: (owner) => ownership.openTransaction(owner),
        preempt: (owner) => ownership.preempt(owner),
        resetForSession,
        resolve: (input) => resolver.resolve(input),
        setActive(nextActive) {
            active = nextActive;
        },
        setCurrentSessionId(sessionId) {
            currentSessionId = sessionId;
        },
    };
}
