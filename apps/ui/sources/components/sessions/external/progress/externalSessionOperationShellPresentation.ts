import type {
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

export type ExternalSessionOperationShellPresentation = Readonly<{
    running: boolean;
    blocksNewOperation: boolean;
    composerPlaceholderKey:
        | 'externalSessions.operationComposerImporting'
        | 'externalSessions.operationComposerTakingOver'
        | null;
}>;

const TERMINAL_STATUSES = new Set<
    ExternalSessionOperationSharedPresentationV1['status']
>([
    'cancelled',
    'completed',
    'discarded',
]);

export function presentExternalSessionOperationShell(
    progress: ExternalSessionOperationSharedPresentationV1 | null,
): ExternalSessionOperationShellPresentation {
    const running = progress?.status === 'running'
        || progress?.status === 'cancel_requested';
    const blocksNewOperation = progress !== null && !TERMINAL_STATUSES.has(progress.status);
    if (!running || !progress) {
        return {
            running: false,
            blocksNewOperation,
            composerPlaceholderKey: null,
        };
    }
    return {
        running: true,
        blocksNewOperation,
        composerPlaceholderKey: progress.kind === 'materialize'
            ? 'externalSessions.operationComposerImporting'
            : 'externalSessions.operationComposerTakingOver',
    };
}
