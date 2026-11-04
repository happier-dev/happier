import type { ClaudeCompletionEvent } from '../contextCompactionEvents';

/** Local reset has no provider result, so it must finish through the launcher's turn owner. */
export async function completeClaudeRemoteClear(
    callbacks: Readonly<{
        onCompletionEvent?: (event: ClaudeCompletionEvent) => void;
        onSessionReset?: () => void;
        onReady: () => void | Promise<void>;
    }>,
    acceptPrompt: () => void,
): Promise<void> {
    callbacks.onCompletionEvent?.('Context was reset');
    callbacks.onSessionReset?.();
    acceptPrompt();
    await callbacks.onReady();
}
