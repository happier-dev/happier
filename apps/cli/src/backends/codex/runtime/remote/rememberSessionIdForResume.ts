export function rememberCodexRemoteSessionIdForResume(params: Readonly<{
    getRemoteSessionId: () => string | null;
    setStoredSessionIdForResume: (sessionId: string) => void;
    setStoredSessionIdFromLocalControl: (isFromLocalControl: boolean) => void;
}>): boolean {
    const currentRemoteSessionId = params.getRemoteSessionId();
    if (!currentRemoteSessionId) {
        return false;
    }

    params.setStoredSessionIdForResume(currentRemoteSessionId);
    params.setStoredSessionIdFromLocalControl(false);
    return true;
}
