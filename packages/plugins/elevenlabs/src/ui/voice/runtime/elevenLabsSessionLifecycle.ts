import type { ElevenLabsPreparedSession } from './elevenLabsSessionTypes.js';

type ActiveSession = Readonly<{
  controlSessionId: string;
  conversationId: string;
  prepared: ElevenLabsPreparedSession;
}>;

function formatDuration(ms: number): string {
  const bounded = Math.max(0, Math.floor(ms));
  return bounded < 90_000
    ? `${Math.max(1, Math.ceil(bounded / 1000))}s`
    : `${Math.max(1, Math.ceil(bounded / 60_000))}m`;
}

export function createElevenLabsSessionLifecycle(input: Readonly<{
  now?: () => number;
  getCredentials: () => Promise<unknown | null>;
  completeSession: (credentials: unknown, input: Readonly<{
    leaseId: string;
    providerConversationId: string;
  }>) => Promise<unknown>;
  appendNote: (controlSessionId: string, text: string) => void;
  translate: (key: string, params?: Readonly<Record<string, unknown>>) => string;
}>) {
  const now = input.now ?? (() => Date.now());
  const getCredentials = input.getCredentials;
  const completeSession = input.completeSession;
  const appendNote = input.appendNote;
  let active: ActiveSession | null = null;
  let warningTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (warningTimer) clearTimeout(warningTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    warningTimer = null;
    expiryTimer = null;
  };

  const started = (next: ActiveSession): void => {
    clearTimers();
    active = next;
    const state = next.prepared.sessionState;
    if (state.billingMode !== 'happier' || typeof state.expiresAtMs !== 'number') return;
    const remainingMs = state.expiresAtMs - now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;
    appendNote(next.controlSessionId, input.translate('errors.voiceSessionLimitStarted', { duration: formatDuration(remainingMs) }));
    const warningDelayMs = remainingMs - 60_000;
    if (warningDelayMs <= 0) {
      appendNote(next.controlSessionId, input.translate('errors.voiceSessionLimitExpiring', { duration: formatDuration(remainingMs) }));
    } else {
      warningTimer = setTimeout(() => {
        appendNote(next.controlSessionId, input.translate('errors.voiceSessionLimitExpiring', {
          duration: formatDuration(Math.max(0, state.expiresAtMs! - now())),
        }));
      }, warningDelayMs);
    }
    expiryTimer = setTimeout(() => {
      appendNote(next.controlSessionId, input.translate('errors.voiceSessionLimitExpired'));
    }, remainingMs);
  };

  const ended = async (): Promise<void> => {
    const endedSession = active;
    active = null;
    clearTimers();
    if (!endedSession) return;
    const state = endedSession.prepared.sessionState;
    if (state.billingMode !== 'happier' || !state.leaseId) return;
    const credentials = await getCredentials();
    if (!credentials) return;
    try {
      await completeSession(credentials, {
        leaseId: state.leaseId,
        providerConversationId: endedSession.conversationId,
      });
    } catch {
      // Provider usage completion is best-effort during teardown. The server
      // lease remains bounded and retries are owned by the server route.
    }
  };

  return Object.freeze({ started, ended });
}

export type ElevenLabsSessionLifecycle = ReturnType<typeof createElevenLabsSessionLifecycle>;
