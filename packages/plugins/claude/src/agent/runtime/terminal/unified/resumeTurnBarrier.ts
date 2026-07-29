import type { ClaudeUnifiedTerminalLaunchIntent } from './launchIntent.js';

export function createClaudeUnifiedResumeTurnBarrier(params: Readonly<{
  intent: ClaudeUnifiedTerminalLaunchIntent;
  quietMs: number;
  begin(): void;
  cancel(): void;
}>): Readonly<{
  beginBeforeProviderRun(): void;
  observeProviderSessionStart(source: string | null): void;
  observeStartupReady(): void;
  /** Consumes the first prompt belonging to the authoritative resume SessionStart. */
  observePromptStart(): boolean;
  observeTerminal(): void;
  dispose(): void;
  isProvisional(): boolean;
}> {
  let state: 'none' | 'provisional' | 'confirmed' = 'none';
  let begun = false;
  let sessionStarted = false;
  let startupReady = false;
  let resumePromptPending = false;
  let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (!idleReleaseTimer) return;
    clearTimeout(idleReleaseTimer);
    idleReleaseTimer = null;
  };
  const scheduleIdleRelease = (): void => {
    if (state !== 'provisional' || !sessionStarted || !startupReady || idleReleaseTimer) return;
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      if (state !== 'provisional') return;
      state = 'none';
      params.cancel();
    }, Math.max(0, Math.trunc(params.quietMs)));
  };
  const observeTerminal = (): void => {
    clearTimer();
    state = 'none';
    resumePromptPending = false;
  };

  return {
    beginBeforeProviderRun() {
      if (params.intent.kind !== 'resume_native' || begun || state !== 'none') return;
      begun = true;
      state = 'provisional';
      sessionStarted = false;
      startupReady = false;
      resumePromptPending = false;
      params.begin();
    },
    observeProviderSessionStart(source) {
      if (state !== 'provisional') return;
      sessionStarted = true;
      // A resume request can legitimately fall back to a fresh provider session (missing/invalid
      // provider transcript). That SessionStart still proves startup, but only `source=resume`
      // authorizes the special first-prompt classification below.
      resumePromptPending = source === 'resume';
      scheduleIdleRelease();
    },
    observeStartupReady() {
      if (state !== 'provisional') return;
      startupReady = true;
      scheduleIdleRelease();
    },
    observePromptStart() {
      if (!resumePromptPending) return false;
      resumePromptPending = false;
      if (state === 'provisional') {
        state = 'confirmed';
      } else if (state === 'none' && begun) {
        // Writable readiness can prove an idle resume before Claude forwards a delayed native
        // continuation hook. Re-open the canonical turn from exact SessionStart provenance rather
        // than extending the quiet-period heuristic or treating the hook as pending acceptance.
        state = 'confirmed';
        params.begin();
      }
      clearTimer();
      return true;
    },
    observeTerminal,
    dispose: observeTerminal,
    isProvisional: () => state === 'provisional',
  };
}
