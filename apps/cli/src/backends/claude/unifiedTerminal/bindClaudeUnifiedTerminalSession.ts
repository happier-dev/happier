import type { ReadyNotificationTurnContext } from '@/agent/runtime/runPermissionModePromptLoop';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { logger } from '@/ui/logger';
import { TERMINAL_INPUT_QUIET_PERIOD_MS } from '@/agent/runtime/terminal/injection/arbiter';

import type { EnhancedMode } from '../loop';
import type { RawJSONLines } from '../types';
import type { ClaudeUnifiedTerminalSessionOptions } from './runClaudeUnifiedTerminalSession';
import {
  createClaudeUnifiedPromptEchoSuppressor,
  type ClaudeUnifiedPromptEchoSuppressor,
} from './promptEchoSuppression';
import { seedClaudeUnifiedPersistedPromptEchoes } from './promptEchoSeed';
import { createClaudeOwnComposerTextLog, type ClaudeOwnComposerTextLog } from './ownComposerTextLog';
import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity';
import type { ClaudeUnifiedNativeContinuationIntent } from './startupLifecycle';

type ClaudeUnifiedSessionBindingClient = Pick<
  SessionClientPort,
  | 'beginTurnAssistantTextSnapshot'
  | 'fetchRecentTranscriptTextItemsForAcpImport'
  | 'getLastObservedMessageSeq'
  | 'recordClaudeJsonlMessageConsumed'
> & Readonly<{
  sessionTurnLifecycle?: Pick<
    NonNullable<SessionClientPort['sessionTurnLifecycle']>,
    'beginTurn' | 'cancelTurn' | 'completeTurn' | 'failTurn' | 'touchActiveTurn'
  > | undefined;
}>;

type ClaudeUnifiedTerminalSessionBindingOptions<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  session: ClaudeUnifiedSessionBindingClient;
  logPrefix: string;
  acceptedPromptEchoWindowMs: number;
  nowMs?: (() => number) | undefined;
  onMessage: (message: RawJSONLines) => void | Promise<void>;
  onReady: (context?: ReadyNotificationTurnContext) => void | Promise<void>;
  onTurnInterruptChanged?: ((handler: (() => Promise<void>) | null) => void) | undefined;
  onPromptTurnStarted?: (() => void | Promise<void>) | undefined;
  suppressor?: ClaudeUnifiedPromptEchoSuppressor | undefined;
  providerResumeIdleReleaseDelayMs?: number | undefined;
}>;

export type ClaudeUnifiedTerminalSessionBinding<Mode extends EnhancedMode = EnhancedMode> = Readonly<{
  sessionOptions: Pick<
    ClaudeUnifiedTerminalSessionOptions<Mode>,
    | 'allowFirstInputBeforeSessionStart'
    | 'onMessage'
    | 'onProviderPromptStarted'
    | 'onReady'
    | 'onTerminalPromptInjected'
    | 'setTurnInterrupt'
  >;
  seedPersistedPromptEchoes(opts?: Readonly<{ nowMs?: number | undefined }>): Promise<void>;
  /**
   * C11 (incident cmq8y3nlx): binding-owned own-injected-text registry, seeded from the persisted
   * prompt store by `seedPersistedPromptEchoes` and handed to the unified terminal run so a
   * respawned runner recognizes (and may clear) its predecessor's leftover composer injection.
   */
  ownComposerTexts: ClaudeOwnComposerTextLog;
  noteNextInjectedPromptShouldSuppressEcho(
    options?: Readonly<{ retainUntilObserved?: boolean | undefined }>,
  ): void;
  noteNextInjectedPromptShouldImportEcho(): void;
  shouldSuppressTranscriptMessage(message: RawJSONLines): boolean;
  beginReadyNotificationTurn(): void;
  recordPromptTurnStarted(): Promise<void>;
  recordProviderResumeStarted(input: ClaudeUnifiedNativeContinuationIntent): Promise<void>;
  recordProviderResumeSessionStarted(): void;
  recordProviderStartupReady(): Promise<void>;
  recordPromptTurnProgress(): Promise<void>;
  recordPromptTurnCompleted(): Promise<void>;
  recordPromptTurnCancelled(): Promise<void>;
  recordPromptTurnFailed(): Promise<void>;
  notePromptTurnTerminal(): void;
}>;

export function bindClaudeUnifiedTerminalSession<Mode extends EnhancedMode = EnhancedMode>(
  opts: ClaudeUnifiedTerminalSessionBindingOptions<Mode>,
): ClaudeUnifiedTerminalSessionBinding<Mode> {
  const promptEchoSuppressor = opts.suppressor ?? createClaudeUnifiedPromptEchoSuppressor({
    acceptedPromptEchoWindowMs: opts.acceptedPromptEchoWindowMs,
    nowMs: opts.nowMs,
  });
  const nowMs = opts.nowMs ?? Date.now;
  const ownComposerTexts = createClaudeOwnComposerTextLog();
  const acceptedPromptEchoSuppressionDecisions: Array<Readonly<{
    suppress: boolean;
    retainUntilObserved: boolean;
  }>> = [];
  // A steered prompt's JSONL user echo only appears when Claude submits the queued prompt at TURN
  // END, which for long autonomous turns is far beyond the fixed accepted-prompt echo window. Track
  // steered echoes separately: unexpired until the steered turn completes (onReady), then bounded by
  // one echo window so a stale entry can never suppress a later identical terminal-typed prompt.
  const pendingSteerEchoes: Array<{ normalizedText: string; expiresAtMs: number | null }> = [];
  let readyTurnContext: ReadyNotificationTurnContext | undefined;
  let canonicalTurnOpen = false;
  let canonicalTurnStartPromise: Promise<void> | null = null;
  let providerResumeBarrier: 'none' | 'provisional' | 'confirmed' = 'none';
  let providerResumeSessionStarted = false;
  let providerStartupReady = false;
  let providerResumeIdleReleaseTimer: NodeJS.Timeout | null = null;
  let providerResumeIdleReleasePromise: Promise<void> | null = null;

  function clearProviderResumeIdleReleaseTimer(): void {
    if (!providerResumeIdleReleaseTimer) return;
    clearTimeout(providerResumeIdleReleaseTimer);
    providerResumeIdleReleaseTimer = null;
  }

  function scheduleProviderResumeIdleRelease(): void {
    if (providerResumeBarrier !== 'provisional' || !providerResumeSessionStarted || !providerStartupReady) return;
    if (providerResumeIdleReleaseTimer) return;
    const delayMs = Math.max(0, Math.trunc(
      opts.providerResumeIdleReleaseDelayMs ?? TERMINAL_INPUT_QUIET_PERIOD_MS,
    ));
    providerResumeIdleReleaseTimer = setTimeout(() => {
      providerResumeIdleReleaseTimer = null;
      if (providerResumeBarrier !== 'provisional') return;
      providerResumeBarrier = 'none';
      const releasePromise = recordPromptTurnCancelled().finally(() => {
        if (providerResumeIdleReleasePromise === releasePromise) {
          providerResumeIdleReleasePromise = null;
        }
      });
      providerResumeIdleReleasePromise = releasePromise;
    }, delayMs);
  }

  function armPendingSteerEchoExpiry(): void {
    const expiresAtMs = nowMs() + opts.acceptedPromptEchoWindowMs;
    for (const echo of pendingSteerEchoes) {
      if (echo.expiresAtMs === null) {
        echo.expiresAtMs = expiresAtMs;
      }
    }
  }

  function consumePendingSteerEcho(message: RawJSONLines): boolean {
    if (pendingSteerEchoes.length === 0 || message.type !== 'user') return false;
    const content = message.message?.content;
    if (typeof content !== 'string') return false;
    const normalizedContent = normalizeClaudeUnifiedPromptIdentityText(content);
    if (normalizedContent.length === 0) return false;
    const referenceMs = nowMs();
    while (pendingSteerEchoes.length > 0) {
      const head = pendingSteerEchoes[0];
      if (!head || head.expiresAtMs === null || head.expiresAtMs >= referenceMs) break;
      pendingSteerEchoes.shift();
    }
    const head = pendingSteerEchoes[0];
    if (!head || head.normalizedText !== normalizedContent) return false;
    pendingSteerEchoes.shift();
    return true;
  }

  function beginReadyNotificationTurn(): void {
    if (typeof opts.session.beginTurnAssistantTextSnapshot !== 'function') return;
    const startSeqExclusive = typeof opts.session.getLastObservedMessageSeq === 'function'
      ? opts.session.getLastObservedMessageSeq()
      : null;
    const turnToken = opts.session.beginTurnAssistantTextSnapshot({ startSeqExclusive });
    readyTurnContext = { turnToken, startSeqExclusive };
  }

  async function recordCanonicalTurnStarted(confirmProviderResume: boolean): Promise<void> {
    // The idle-resume release terminalizes the provisional canonical turn asynchronously. A
    // delayed exact resume prompt can arrive while that mutation is in flight; wait for the old
    // turn to close before opening its successor, otherwise the start deduplicates against the old
    // `canonicalTurnOpen` latch and the release then cancels the real resumed work.
    if (confirmProviderResume && providerResumeIdleReleasePromise) {
      await providerResumeIdleReleasePromise;
    }
    if (confirmProviderResume && providerResumeBarrier === 'provisional') {
      providerResumeBarrier = 'confirmed';
      clearProviderResumeIdleReleaseTimer();
    }
    if (canonicalTurnOpen) {
      await canonicalTurnStartPromise;
      return;
    }
    canonicalTurnOpen = true;
    const lifecycle = opts.session.sessionTurnLifecycle;
    if (!lifecycle?.beginTurn) return;
    const startPromise = Promise.resolve(lifecycle.beginTurn({ provider: 'claude' }))
      .then(() => undefined)
      .catch((error) => {
        canonicalTurnOpen = false;
        logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn start (non-fatal)`, error);
      })
      .finally(() => {
        if (canonicalTurnStartPromise === startPromise) {
          canonicalTurnStartPromise = null;
        }
      });
    canonicalTurnStartPromise = startPromise;
    await startPromise;
  }

  async function recordPromptTurnStarted(): Promise<void> {
    await recordCanonicalTurnStarted(true);
  }

  async function recordProviderResumeStarted(input: ClaudeUnifiedNativeContinuationIntent): Promise<void> {
    if (providerResumeBarrier !== 'none' || canonicalTurnOpen) {
      await canonicalTurnStartPromise;
      return;
    }
    providerResumeBarrier = 'provisional';
    providerResumeSessionStarted = false;
    providerStartupReady = false;
    logger.debug(`${opts.logPrefix}: Opening provisional Claude resume turn barrier`, {
      origin: input.kind === 'resume_native' ? 'explicit_resume_native' : 'explicit_continue_native',
      ...(input.kind === 'resume_native' ? { providerSessionId: input.providerSessionId } : {}),
    });
    await recordCanonicalTurnStarted(false);
    providerResumeBarrier = canonicalTurnOpen ? 'provisional' : 'none';
  }

  function recordProviderResumeSessionStarted(): void {
    if (providerResumeBarrier !== 'provisional') return;
    providerResumeSessionStarted = true;
    scheduleProviderResumeIdleRelease();
  }

  async function recordProviderStartupReady(): Promise<void> {
    if (providerResumeBarrier !== 'provisional') return;
    providerStartupReady = true;
    scheduleProviderResumeIdleRelease();
  }

  async function recordPromptTurnProgress(): Promise<void> {
    await canonicalTurnStartPromise;
    if (!canonicalTurnOpen) return;
    try {
      await opts.session.sessionTurnLifecycle?.touchActiveTurn?.({ provider: 'claude' });
    } catch (error) {
      logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn progress (non-fatal)`, error);
    }
  }

  async function recordPromptTurnCompleted(): Promise<void> {
    await canonicalTurnStartPromise;
    if (!canonicalTurnOpen) return;
    try {
      await opts.session.sessionTurnLifecycle?.completeTurn?.({ provider: 'claude' });
    } catch (error) {
      logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn completion (non-fatal)`, error);
    } finally {
      canonicalTurnOpen = false;
      providerResumeBarrier = 'none';
      clearProviderResumeIdleReleaseTimer();
    }
  }

  // A failed prompt turn (e.g. hook StopFailure: API error, content filter) MUST terminalize the
  // canonical turn. Leaving it open orphans the server turn 'in_progress' forever, which keeps the
  // daemon pending-queue materialization gate blocked and strands queued messages (QA A-F3/C-F2).
  async function recordPromptTurnFailed(): Promise<void> {
    await canonicalTurnStartPromise;
    if (!canonicalTurnOpen) return;
    try {
      await opts.session.sessionTurnLifecycle?.failTurn?.({ provider: 'claude' });
    } catch (error) {
      logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn failure (non-fatal)`, error);
    } finally {
      canonicalTurnOpen = false;
      providerResumeBarrier = 'none';
      clearProviderResumeIdleReleaseTimer();
    }
  }

  async function recordPromptTurnCancelled(): Promise<void> {
    await canonicalTurnStartPromise;
    if (!canonicalTurnOpen) return;
    try {
      await opts.session.sessionTurnLifecycle?.cancelTurn?.({ provider: 'claude' });
    } catch (error) {
      logger.debug(`${opts.logPrefix}: Failed to record Claude unified turn cancellation (non-fatal)`, error);
    } finally {
      canonicalTurnOpen = false;
      providerResumeBarrier = 'none';
      clearProviderResumeIdleReleaseTimer();
    }
  }

  function notePromptTurnTerminal(): void {
    canonicalTurnOpen = false;
    providerResumeBarrier = 'none';
    clearProviderResumeIdleReleaseTimer();
  }

  function noteNextInjectedPromptShouldSuppressEcho(
    options?: Readonly<{ retainUntilObserved?: boolean | undefined }>,
  ): void {
    acceptedPromptEchoSuppressionDecisions.push({
      suppress: true,
      retainUntilObserved: options?.retainUntilObserved === true,
    });
  }

  function noteNextInjectedPromptShouldImportEcho(): void {
    acceptedPromptEchoSuppressionDecisions.push({ suppress: false, retainUntilObserved: false });
  }

  function readAcceptedPromptEchoSuppressionDecision(): Readonly<{
    suppress: boolean;
    retainUntilObserved: boolean;
  }> {
    return acceptedPromptEchoSuppressionDecisions.shift()
      ?? { suppress: true, retainUntilObserved: false };
  }

  function shouldSuppressTranscriptMessage(message: RawJSONLines): boolean {
    if (consumePendingSteerEcho(message)) {
      opts.session.recordClaudeJsonlMessageConsumed?.(message);
      return true;
    }
    if (!promptEchoSuppressor.shouldSuppressTranscriptMessage(message)) return false;
    opts.session.recordClaudeJsonlMessageConsumed?.(message);
    return true;
  }

  function isAcceptedResumeSummaryCompactCommand(message: RawJSONLines): boolean {
    if (message.type !== 'user') return false;
    const content = message.message?.content;
    return typeof content === 'string'
      && normalizeClaudeUnifiedPromptIdentityText(content) === '/compact';
  }

  async function seedPersistedPromptEchoes(seedOpts: Readonly<{ nowMs?: number | undefined }> = {}): Promise<void> {
    await seedClaudeUnifiedPersistedPromptEchoes({
      session: opts.session,
      suppressor: promptEchoSuppressor,
      ownComposerTexts,
      logPrefix: opts.logPrefix,
      nowMs: seedOpts.nowMs,
    });
  }

  return {
    sessionOptions: {
      allowFirstInputBeforeSessionStart: true,
      onMessage: async (message) => {
        if (shouldSuppressTranscriptMessage(message)) return;
        await opts.onMessage(message);
        // Choosing Claude's native "resume from summary" option makes Claude submit `/compact`
        // itself. Slash commands do not consistently emit UserPromptSubmit, but this exact
        // provider-authored JSONL row proves the provisional resume is active. Confirm the
        // canonical turn before the bounded idle-resume release can cancel real compaction.
        if (isAcceptedResumeSummaryCompactCommand(message)) {
          void recordPromptTurnStarted().then(recordPromptTurnProgress);
          return;
        }
        void recordPromptTurnProgress();
      },
      onReady: async () => {
        // The steered turn is over: its queued prompt is being submitted now, so the matching JSONL
        // echo must arrive within one echo window from here (bounding stale-entry suppression risk).
        armPendingSteerEchoExpiry();
        await recordPromptTurnCompleted();
        await opts.onReady(readyTurnContext);
      },
      onProviderPromptStarted: async () => {
        beginReadyNotificationTurn();
        await recordPromptTurnStarted();
        await recordPromptTurnProgress();
      },
      setTurnInterrupt: (handler) => {
        opts.onTurnInterruptChanged?.(handler);
      },
      onTerminalPromptInjected: async (acceptedPrompt) => {
        const suppressionDecision = readAcceptedPromptEchoSuppressionDecision();
        if (acceptedPrompt.acceptedAs === 'in_flight_steer') {
          if (suppressionDecision.suppress) {
            const normalizedText = normalizeClaudeUnifiedPromptIdentityText(acceptedPrompt.message);
            if (normalizedText.length > 0) {
              pendingSteerEchoes.push({ normalizedText, expiresAtMs: null });
            }
          }
          await recordPromptTurnProgress();
          return;
        }
        if (suppressionDecision.suppress) {
          promptEchoSuppressor.recordAcceptedPrompt({
            ...acceptedPrompt,
            ...(suppressionDecision.retainUntilObserved ? { retainUntilObserved: true } : {}),
          });
        }
        beginReadyNotificationTurn();
        await recordPromptTurnStarted();
        await recordPromptTurnProgress();
        await opts.onPromptTurnStarted?.();
      },
    },
    seedPersistedPromptEchoes,
    ownComposerTexts,
    noteNextInjectedPromptShouldSuppressEcho,
    noteNextInjectedPromptShouldImportEcho,
    shouldSuppressTranscriptMessage,
    beginReadyNotificationTurn,
    recordPromptTurnStarted,
    recordProviderResumeStarted,
    recordProviderResumeSessionStarted,
    recordProviderStartupReady,
    recordPromptTurnProgress,
    recordPromptTurnCompleted,
    recordPromptTurnCancelled,
    recordPromptTurnFailed,
    notePromptTurnTerminal,
  };
}
