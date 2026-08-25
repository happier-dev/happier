import { isExternalSessionOperationTerminalStatusV1 } from '@happier-dev/protocol';
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

export function presentExternalSessionOperationShell(
    progress: ExternalSessionOperationSharedPresentationV1 | null,
): ExternalSessionOperationShellPresentation {
    const running = progress?.status === 'running'
        || progress?.status === 'cancel_requested';
    const blocksNewOperation = progress !== null
        && !isExternalSessionOperationTerminalStatusV1(progress.status);
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
