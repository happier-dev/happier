import { create } from 'zustand';

export type LocalVoiceStatus = 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';

export type LocalVoiceState = {
  status: LocalVoiceStatus;
  sessionId: string | null;
  /**
   * Machine-readable error code (snake_case). This is the single error channel for local voice:
   * the voice surface renders it through `formatLocalVoiceErrorMessage` (`localVoiceErrorMessage.ts`).
   */
  error: string | null;
  /** Optional root-cause detail for `error` (untranslated). Cleared whenever `error` is patched without it. */
  errorMessage: string | null;
};

const useLocalVoiceStore = create<LocalVoiceState>(() => ({
  status: 'idle',
  sessionId: null,
  error: null,
  errorMessage: null,
}));

export function getLocalVoiceState(): LocalVoiceState {
  return useLocalVoiceStore.getState();
}

export const useLocalVoiceStatus = () => useLocalVoiceStore((state) => state.status);

export function subscribeLocalVoiceState(listener: () => void): () => void {
  return useLocalVoiceStore.subscribe(() => listener());
}

export function patchLocalVoiceState(patch: Partial<LocalVoiceState>): void {
  useLocalVoiceStore.setState((state) => {
    const next = { ...state, ...patch };
    if ('error' in patch && !('errorMessage' in patch)) {
      next.errorMessage = null;
    }
    if (
      state.status === next.status
      && state.sessionId === next.sessionId
      && state.error === next.error
      && state.errorMessage === next.errorMessage
    ) {
      return state;
    }
    return next;
  });
}

export function setIdleStateUnlessRecording(sessionId: string): void {
  const current = getLocalVoiceState();
  if (current.status === 'recording' && current.sessionId === sessionId) {
    return;
  }
  // A completed voice turn returns to an idle (ready) state, but we keep the active sessionId
  // until the user explicitly hangs up.
  // Preserve any existing error so the UI can surface it until the user retries.
  patchLocalVoiceState({ status: 'idle', sessionId });
}


/**
 * Maps a thrown turn failure to the local voice error fields. Errors may carry a specific
 * `localVoiceErrorCode` (e.g. the daemon voice-agent feature prerequisites); otherwise the
 * caller's fallback code is used and the root message is kept as detail.
 */
export function resolveLocalVoiceError(
  error: unknown,
  fallbackCode: string,
): Pick<LocalVoiceState, 'error' | 'errorMessage'> {
  const carrier = error as { localVoiceErrorCode?: unknown; message?: unknown } | null;
  const code = typeof carrier?.localVoiceErrorCode === 'string' && carrier.localVoiceErrorCode.trim()
    ? carrier.localVoiceErrorCode.trim()
    : fallbackCode;
  const rawMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = rawMessage.trim();
  return { error: code, errorMessage: message && message !== code ? message : null };
}
