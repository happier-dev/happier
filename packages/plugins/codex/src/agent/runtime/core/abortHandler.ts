function rememberCodexRemoteSessionIdForResume(params: Readonly<{
  getRemoteSessionId: () => string | null;
  setStoredSessionIdForResume: (value: string | null) => void;
  setStoredSessionIdFromLocalControl: (value: boolean) => void;
}>): boolean {
  const remoteSessionId = params.getRemoteSessionId();
  if (!remoteSessionId) return false;
  params.setStoredSessionIdForResume(remoteSessionId);
  params.setStoredSessionIdFromLocalControl(false);
  return true;
}

export function createCodexAbortHandler(params: Readonly<{
  getRemoteSessionId: () => string | null;
  getStoredSessionIdForResume: () => string | null;
  setStoredSessionIdForResume: (value: string | null) => void;
  setStoredSessionIdFromLocalControl: (value: boolean) => void;
  cancelCurrentTurn: (() => Promise<void>) | null;
  abortStartOrLoad: () => void;
  abortTurn: () => void;
  resetAbortControllers: () => void;
  logDebug: (message: string, error?: unknown) => void;
}>): () => Promise<void> {
  return async function handleAbort(): Promise<void> {
    params.logDebug('[Codex] Abort requested - stopping current task');
    try {
      params.abortStartOrLoad();

      if (
        rememberCodexRemoteSessionIdForResume({
          getRemoteSessionId: params.getRemoteSessionId,
          setStoredSessionIdForResume: params.setStoredSessionIdForResume,
          setStoredSessionIdFromLocalControl: params.setStoredSessionIdFromLocalControl,
        })
      ) {
        params.logDebug('[CodexACP] Stored session for resume:', params.getStoredSessionIdForResume());
      }

      try {
        await params.cancelCurrentTurn?.();
      } catch (error) {
        params.logDebug('[Codex] Failed to cancel in-flight turn on abort (non-fatal)', error);
      }

      params.abortTurn();
      params.logDebug('[Codex] Abort completed - session remains active');
    } catch (error) {
      params.logDebug('[Codex] Error during abort:', error);
    } finally {
      params.resetAbortControllers();
    }
  };
}

