type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

export async function finalizeClaudeAgentSdkRun(params: {
    disposePromptChannel: () => void;
    disposeTurnInterrupt: () => void;
    updateThinking: (thinking: boolean) => void;
    clearBufferedAssistantMessages: (incoming: unknown) => void;
    flushStreamedTranscriptWriter: (reason: FlushReason, interruptedReason?: string) => Promise<unknown>;
    abortController: AbortController;
    waitForQueuedPromptPump: () => Promise<void>;
    closeResponse: () => void | Promise<void>;
    repairTranscriptAfterAbort: () => Promise<void>;
    closeStderrAppender: () => Promise<void>;
}) {
    params.disposePromptChannel();
    params.disposeTurnInterrupt();
    params.updateThinking(false);
    params.clearBufferedAssistantMessages(null);

    await params.flushStreamedTranscriptWriter('abort', 'runner-finalize');

    params.abortController.abort();
    await params.waitForQueuedPromptPump();

    try {
        await params.closeResponse();
    } catch {
        // ignore
    }

    await params.repairTranscriptAfterAbort();
    await params.closeStderrAppender();
}
