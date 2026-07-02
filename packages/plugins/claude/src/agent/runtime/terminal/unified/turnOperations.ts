import type { TerminalHostHandle, TerminalHostPreference, TerminalPromptInput } from '@happier-dev/agents';
import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { randomUUID } from 'node:crypto';
import type {
  InternalRuntimeTurnOperationsEnvelopeV1,
  InternalRuntimeTurnOperationsV1,
} from '@happier-dev/plugin-sdk/internal/runtime/session';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';
import {
  buildClaudeHookPluginHooks,
  buildClaudeHookPluginManifest,
} from '../../../hooks/settings.js';
import { buildDefaultPermissionHookResponse } from '../../../hooks/protocol.js';
import { resolveClaudePermissionHookCeilingMs } from '../../../hooks/permissionHookTimeout.js';
import { createClaudeStatuslineApplier } from '../../../statusline/apply.js';
import {
  buildClaudeStatuslineOverlaySettings,
  resolveClaudeStatuslineOriginalCommand,
  type ClaudeStatuslineOverlaySettings,
} from '../../../statusline/overlay.js';
import { parseClaudeStatuslinePayload } from '../../../statusline/payload.js';

import { recordClaudeRuntimeProviderAccountUsageSnapshot } from '../../accountUsage.js';
import type { ClaudeTerminalLifecycleObservation } from '../lifecycle.js';
import { buildClaudeEffortCliArgs, isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';
import { mapToClaudePermissionMode, resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';
import {
  createClaudeUnifiedInputArbiter,
  type ClaudeUnifiedInputArbiter,
  type ClaudeUnifiedPromptInjectionFailure,
} from './inputArbiter.js';
import { subscribeClaudeUnifiedTerminalLifecycleEvents } from './lifecycleEvents.js';
import { createPersistedClaudeUnifiedOwnInjectedTextLog } from './ownInjectedTextLog.js';
import { createClaudeUnifiedPermissionHookHandler } from './permissionHooks.js';
import { createClaudeUnifiedPromptEchoSuppressor } from './promptEchoSuppression.js';
import {
  isClaudeScreenReadyForInput,
  parseClaudeScreenState,
  resolveClaudeScreenInFlightSteerVeto,
} from './screenState.js';
import { createClaudeUnifiedProviderTranscriptPublisher } from './providerTranscript.js';
import {
  createClaudeUnifiedRuntimeConfigOutcomeEmitter,
  mapApplyOutcomeToUpdateOutcome,
  mapRuntimeConfigUpdateToDesired,
  type ClaudeUnifiedRuntimeConfigOutcomeSessionEvent,
} from './runtimeControlIntegration.js';
import {
  CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID,
  createClaudeSettingsGuard,
  createClaudeTuiControlTelemetrySink,
  createClaudeUnifiedTuiControlController,
  resolveClaudeConfigRootFromEnv,
  type ClaudeTuiControlTimings,
  type ClaudeUnifiedTuiControlController,
} from './tuiControls/index.js';
import { createClaudeUnifiedSteerCapabilityPublisher } from './steerCapabilityPublisher.js';
import { createClaudeUnifiedTerminalRuntimeState } from './runtimeState.js';
import {
  ClaudeUnifiedTerminalInjectionFailureError,
  recordClaudeUnifiedProcessExitFailure,
  recordClaudeUnifiedTurnFailure,
} from './turnFailures.js';
import { publishClaudeUnifiedRuntimeEvent } from './runtimeEvents.js';
import {
  createClaudeUnifiedPromptInput,
  createClaudeUnifiedTerminalSessionName,
  createClaudeUnifiedTurnId,
  createClaudeUnifiedWritableReadiness,
} from './turnInput.js';

const DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS = 5_000;

// Startup-readiness window: a live host that is still rendering may take longer than the
// base window to show an interactive composer. SessionStart evidence (or a progressing
// live screen) extends the wait up to the hard ceiling; a silent, unconfirmed host
// fast-fails after the base window plus a short progress grace.
const DEFAULT_STARTUP_READINESS_BASE_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_READINESS_EXTENDED_TIMEOUT_MS = 60_000;
const DEFAULT_STARTUP_READINESS_PROGRESS_GRACE_MS = 8_000;
const DEFAULT_STARTUP_READINESS_POLL_INTERVAL_MS = 1_000;
const READINESS_DIAGNOSTIC_TAIL_MAX_LINES = 40;
const READINESS_DIAGNOSTIC_TAIL_MAX_CHARS = 2_000;

// user_draft starvation (incident 294-veto loop, lane X1): a leftover composer draft blocks
// every injection/steer window. An OWN exact-match leftover on a non-generating screen is
// cleared with a bounded Escape; a persisting (genuine) draft escalates ONCE per episode into
// an honest blocking notice instead of starving silently.
const MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS = 2;
const USER_DRAFT_STARVATION_VETO_THRESHOLD = 4;
const USER_DRAFT_STARVATION_MIN_EPISODE_MS = 15_000;
const USER_DRAFT_STARVATION_RECHECK_MS = 30_000;

// Stale-turn recovery (incident cmq7pyqkj, L1): when a prompt is queued behind a turn whose
// completion evidence was lost, a bounded window of provider silence plus idle-composer screen
// evidence reconciles the turn so the queued prompt can drain as a new turn. Demand-driven only —
// never an idle completion watchdog (a quiet accepted turn with no queued prompt keeps waiting).
const DEFAULT_STALE_TURN_RECOVERY_WINDOW_MS = 30_000;
const DEFAULT_STALE_TURN_RECOVERY_POLL_INTERVAL_MS = 1_000;

export type ClaudeUnifiedTerminalTurnOperationsParams = Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  hostPreference: TerminalHostPreference;
  launchEnv: Readonly<Record<string, string>>;
  permissionMode: string | null;
  setThinking?: (thinking: boolean) => void;
  startupReadiness?: Readonly<{
    baseTimeoutMs?: number;
    extendedTimeoutMs?: number;
    progressGraceMs?: number;
    pollIntervalMs?: number;
  }>;
  staleTurnRecovery?: Readonly<{
    windowMs?: number;
    pollIntervalMs?: number;
  }>;
  /** Test seam for the TUI runtime-control controller (settle/verification delays). */
  tuiControl?: Readonly<{
    timings?: Partial<ClaudeTuiControlTimings>;
  }>;
}>;

/**
 * Outcome of an in-flight permission-mode delta application (the host's steer-config seam):
 * `applied`/`scheduled_in_turn` let the steered text join the running turn; `unsupported`/`failed`
 * send the message back to the legacy queue path (mode applies when the queue drains).
 */
export type ClaudeUnifiedInFlightConfigApplyOutcome = Readonly<
  | { status: 'applied' }
  | { status: 'scheduled_in_turn' }
  | { status: 'unsupported'; reason?: string | undefined }
  | { status: 'failed'; reason?: string | undefined }
>;

type TurnCompletionWaiter = Readonly<{
  resolve(): void;
  reject(error: Error): void;
}>;

type ClaudeUnifiedSessionHookServer = Awaited<ReturnType<PluginContextV1['sessionHooks']['startServer']>> & Readonly<{
  sessionHookSecretFile?: string;
  permissionHookSecretFile?: string;
}>;

type ClaudeUnifiedTerminalNativeRuntime = InternalRuntimeTurnOperationsV1 & Readonly<{
  confirmProviderAcceptance(evidence?: Readonly<{ promptText?: string; includeTimedOutAmbiguous?: boolean }>): Promise<boolean>;
  observeTerminalLifecycle(observation: ClaudeTerminalLifecycleObservation): Promise<void>;
  // Host session-loop in-flight steer hooks (read off the native runtime by
  // runHostSessionRuntime's InFlightSteerController).
  supportsInFlightSteer(): boolean;
  isTurnInFlight(): boolean;
  canSteerPrompt(): boolean;
  steerPrompt(prompt: string, options?: Readonly<{ localId?: string | null }>): Promise<void>;
  // Demand signal from the host: a prompt was queued behind the running turn (mode change /
  // special command / steer fallback). Arms the bounded stale-turn recovery check.
  notifyPromptQueuedDuringTurn(): void;
  /**
   * Apply a steered message's PERMISSION-MODE delta to the RUNNING turn (probe Q-A steer-safe
   * generating window) so the message can steer instead of deferring to turn end. Gated behind
   * the TUI runtime-control feature; without it the result is `unsupported` and the message
   * keeps the legacy queue path.
   */
  applyConfigDeltaInFlight(delta: Readonly<{ permissionMode: string }>): Promise<ClaudeUnifiedInFlightConfigApplyOutcome>;
}>;

function createProviderAcceptancePendingError(
  snapshot: ReturnType<ClaudeUnifiedInputArbiter['snapshot']>,
  failureState: 'failed_terminal' | 'failed_ambiguous' = 'failed_terminal',
): Error {
  const suffix = snapshot.lastFailureReason ? `: ${snapshot.lastFailureReason}` : '';
  return new ClaudeUnifiedTerminalInjectionFailureError(
    `Claude unified terminal prompt is awaiting provider acceptance${suffix}`,
    failureState,
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function boundReadinessDiagnosticTail(text: string | null): string {
  if (!text) return '';
  const tail = text
    .split('\n')
    .slice(-READINESS_DIAGNOSTIC_TAIL_MAX_LINES)
    .join('\n');
  return tail.length > READINESS_DIAGNOSTIC_TAIL_MAX_CHARS
    ? tail.slice(-READINESS_DIAGNOSTIC_TAIL_MAX_CHARS)
    : tail;
}

function readBooleanOptionValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function readUltracodeFromRuntimeConfigUpdate(update: Readonly<Record<string, unknown>>): boolean | null {
  const configOption = update.configOption;
  if (configOption && typeof configOption === 'object' && !Array.isArray(configOption)) {
    const option = configOption as Record<string, unknown>;
    if (readNonEmptyString(option.id) === 'ultracode') {
      return readBooleanOptionValue(option.value);
    }
  }
  const configOptions = update.configOptions;
  if (configOptions && typeof configOptions === 'object' && !Array.isArray(configOptions)) {
    return readBooleanOptionValue((configOptions as Record<string, unknown>).ultracode);
  }
  return null;
}

function readEffortFromRuntimeConfigUpdate(update: Readonly<Record<string, unknown>>): string | null {
  // Singular `configOption` is the canonical host shape (gap 34 unification); the plural
  // `configOptions` record is only a legacy alias. Singular wins.
  const configOption = update.configOption;
  if (configOption && typeof configOption === 'object' && !Array.isArray(configOption)) {
    const option = configOption as Record<string, unknown>;
    const optionId = readNonEmptyString(option.id);
    if (optionId === 'reasoning_effort' || optionId === 'effort') {
      return readNonEmptyString(option.value);
    }
  }
  const configOptions = update.configOptions;
  if (configOptions && typeof configOptions === 'object' && !Array.isArray(configOptions)) {
    const options = configOptions as Record<string, unknown>;
    const effort = readNonEmptyString(options.reasoning_effort) ?? readNonEmptyString(options.effort);
    if (effort) return effort;
  }
  return null;
}

export function createClaudeUnifiedTerminalTurnOperations(
  params: ClaudeUnifiedTerminalTurnOperationsParams,
): InternalRuntimeTurnOperationsEnvelopeV1 {
  const state = createClaudeUnifiedTerminalRuntimeState();
  const handlers = new Set<(message: RuntimeEventV1) => void>();
  const completionWaiters = new Set<TurnCompletionWaiter>();
  const publishedFailureTurnIds = new Set<string>();
  const promptEchoSuppressor = createClaudeUnifiedPromptEchoSuppressor();
  const providerTranscriptPublisher = createClaudeUnifiedProviderTranscriptPublisher({
    ctx: params.ctx,
    sessionId: params.happierSessionId,
  });
  let sessionHookServer: ClaudeUnifiedSessionHookServer | null = null;
  let hookPluginDir: string | null = null;
  let hookSecret: string | null = null;
  let statuslineOverlaySettings: ClaudeStatuslineOverlaySettings | null = null;
  let statuslineTranscriptPath: string | null = null;
  // Statusline-verified effective truth (the `lastVerified` analogue, lane Y intent): the model
  // and effort the live TUI is ACTUALLY running. Feeds the convergence baseline ONLY — never
  // desired-state surfaces, never the TUI, never launch args.
  let verifiedModelId: string | null = null;
  let verifiedEffort: string | null = null;
  // TUI runtime-control controller (feature-gated, lazily created once the host handle exists and
  // the host adapter exposes a control port). `null` means "not (yet) available"; the resolved
  // value is cached so repeated updates share one controller (one lock, one lastVerified).
  let tuiController: ClaudeUnifiedTuiControlController | null = null;
  let tuiControllerPromise: Promise<ClaudeUnifiedTuiControlController | null> | null = null;
  const statuslineApplier = createClaudeStatuslineApplier({
    logger: params.ctx.logger,
    // Async wrapper: a host without the session metadata seam rejects instead of throwing, and
    // the applier downgrades that to a warn log (statusline is additive enrichment only).
    writeMetadata: async (request) => await params.ctx.session.writeMetadata(request),
    readIdentity: () => ({
      providerSessionId: state.providerSessionId,
      transcriptPath: statuslineTranscriptPath,
    }),
    onRuntimeTruth: (truth) => {
      if (truth.modelId) verifiedModelId = truth.modelId;
      if (truth.effortLevel) verifiedEffort = truth.effortLevel;
      // Statusline is the live EFFECTIVE-truth feed for the controller's convergence baseline:
      // a matching desired change then short-circuits as already-effective with zero TUI bytes.
      const controller: ClaudeUnifiedTuiControlController | null = tuiController;
      if (controller) {
        controller.reconcileFromStatusline({
          ...(truth.modelId ? { model: truth.modelId } : {}),
          ...(truth.effortLevel ? { reasoningEffort: truth.effortLevel } : {}),
        });
      }
    },
  });
  let unsubscribeLifecycleEvents: (() => void) | null = null;
  let launchModelId: string | null = null;
  let launchFallbackModelId: string | null = null;
  let launchEffort: string | null = null;
  let launchUltracode = false;
  // Effective permission mode at spawn. Plan-inclusive: a pre-launch `{modeId:'plan'}` toggle
  // wins over the raw permission mode so the TUI launches in plan rather than the raw mode.
  let launchPermissionMode: string | null = params.permissionMode;
  const startupReadinessConfig = (() => {
    const base = Math.max(1, Math.trunc(params.startupReadiness?.baseTimeoutMs ?? DEFAULT_STARTUP_READINESS_BASE_TIMEOUT_MS));
    return {
      baseTimeoutMs: base,
      extendedTimeoutMs: Math.max(base, Math.trunc(params.startupReadiness?.extendedTimeoutMs ?? DEFAULT_STARTUP_READINESS_EXTENDED_TIMEOUT_MS)),
      progressGraceMs: Math.max(1, Math.trunc(params.startupReadiness?.progressGraceMs ?? DEFAULT_STARTUP_READINESS_PROGRESS_GRACE_MS)),
      pollIntervalMs: Math.max(1, Math.trunc(params.startupReadiness?.pollIntervalMs ?? DEFAULT_STARTUP_READINESS_POLL_INTERVAL_MS)),
    };
  })();
  let lastObservedPaneAlive: boolean | null = null;
  let lastObservedScreenText: string | null = null;
  let lastScreenProgressAtMs: number | null = null;
  let lastReadinessKind: 'writable' | 'writable_steer' | 'deferred' | 'failed' = 'deferred';
  let lastSteerVetoReason: string | null = null;
  let readinessWakeTimer: ReturnType<typeof setTimeout> | null = null;
  let readinessWaitStartedAtMs: number | null = null;
  const staleTurnRecoveryConfig = {
    windowMs: Math.max(1, Math.trunc(params.staleTurnRecovery?.windowMs ?? DEFAULT_STALE_TURN_RECOVERY_WINDOW_MS)),
    pollIntervalMs: Math.max(1, Math.trunc(params.staleTurnRecovery?.pollIntervalMs ?? DEFAULT_STALE_TURN_RECOVERY_POLL_INTERVAL_MS)),
  };
  let staleTurnDemandActive = false;
  let staleTurnWakeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastProviderActivityAtMs: number | null = null;
  // Durable across runner respawns (ported S-1): a leftover own draft must still be recognized by
  // the NEXT runner process, or it reads as a foreign user draft and idle injection starves.
  const ownInjectedTextLog = createPersistedClaudeUnifiedOwnInjectedTextLog({
    storage: params.ctx.storage.session,
    onStorageError: (operation, error) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] own-injected-text log storage degraded', { operation, error });
    },
  });
  // Single owner of the runtime-config-outcome session-event emission (grouped per status,
  // transition-deduped). The session `send` seam is optional on older hosts; emission is then a
  // logged no-op (outcomes still flow through the typed updateSessionRuntimeConfig return).
  const runtimeConfigOutcomeEmitter = createClaudeUnifiedRuntimeConfigOutcomeEmitter({
    sendSessionEvent: (event: ClaudeUnifiedRuntimeConfigOutcomeSessionEvent) => {
      const send = (params.ctx.session as { send?: (request: unknown) => Promise<unknown> }).send;
      if (typeof send !== 'function') {
        params.ctx.logger.debug('[ClaudeUnifiedTerminal] session send unavailable; runtime-config-outcome not published', { status: event.status });
        return;
      }
      void Promise.resolve(send.call(params.ctx.session, { kind: 'sessionEvent', event })).catch((error) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] runtime-config-outcome publish failed', { error });
      });
    },
  });

  function isTuiRuntimeControlFeatureEnabled(): boolean {
    try {
      return params.ctx.features.isEnabled(CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID) === true;
    } catch {
      // Fail-closed: a missing/throwing feature service means the gate is OFF.
      return false;
    }
  }

  async function ensureTuiController(): Promise<ClaudeUnifiedTuiControlController | null> {
    if (state.disposed || !state.handle) return null;
    if (!isTuiRuntimeControlFeatureEnabled()) return null;
    if (!tuiControllerPromise) {
      const handle = state.handle;
      tuiControllerPromise = (async () => {
        const port = await params.ctx.terminalHost.controlPort(handle);
        if (!port) return null;
        const controller = createClaudeUnifiedTuiControlController({
          port,
          featureEnabled: true,
          settingsGuard: createClaudeSettingsGuard({
            // The SPAWNED process env decides which config root `/model`/`/effort` mutate.
            configDir: resolveClaudeConfigRootFromEnv(params.launchEnv),
          }),
          telemetry: createClaudeTuiControlTelemetrySink({ logger: params.ctx.logger }),
          ...(params.tuiControl?.timings ? { timings: params.tuiControl.timings } : {}),
          onControlCommandTyped: (commandText) => {
            // Controller-typed slash commands must never surface as user messages: register them
            // both as own-injected text (leftover-draft recognition) and as accepted-prompt echoes
            // (terminal-origin materialization suppression).
            ownInjectedTextLog.record(commandText);
            promptEchoSuppressor.recordAcceptedPrompt({ text: commandText });
          },
          onControlCommandTextEntered: (commandText) => {
            // TYPE-time registration only (ported S-7): a typed-but-never-submitted command can
            // survive the cleanup Escape as a composer leftover that must read as OUR OWN residue.
            // Echo suppression stays on the submit hook — suppressing the echo of a never-submitted
            // text could swallow a real user message.
            ownInjectedTextLog.record(commandText);
          },
        });
        tuiController = controller;
        return controller;
      })().catch((error) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] TUI runtime-control controller unavailable', { error });
        return null;
      });
    }
    return tuiControllerPromise;
  }
  let consecutiveUserDraftDeferrals = 0;
  let userDraftEpisodeStartedAtMs: number | null = null;
  let userDraftEscalated = false;
  // Seam A: publish live steer availability (+reason) into agentState.capabilities so the UI's
  // delivery decision can stop pretending a non-steerable send was delivered. Fed by the
  // steer-window decisions inside observeCurrentReadiness; controller-independent.
  const steerCapabilityPublisher = createClaudeUnifiedSteerCapabilityPublisher({
    session: params.ctx.session,
    logger: params.ctx.logger,
    isCanonicalTurnActive: () => !state.disposed && (state.turnInFlight || state.terminalOriginTurnInFlight),
    // Lane Q: resolved once at runtime creation; the UI's "Apply & steer now" gate is fail-closed
    // on this static capability, so it must land before the first steered send.
    inFlightConfigApplySupported: isTuiRuntimeControlFeatureEnabled(),
  });
  const arbiter = createClaudeUnifiedInputArbiter({
    providerAcceptanceTimeoutMs: DEFAULT_PROVIDER_ACCEPTANCE_TIMEOUT_MS,
    injectPrompt: async (input) => {
      const handle = await ensureHost();
      // Never interleave prompt bytes with an in-flight control sequence (slash command /
      // mode cycle): the controller holds the terminal lock; wait for it to drain first.
      if (tuiController) await tuiController.whenControlIdle();
      // Recorded BEFORE the injection so failed/partial attempts (the own-leftover class)
      // are matchable too.
      ownInjectedTextLog.record(input.text);
      return await params.ctx.terminalHost.injectUserPrompt(handle, input);
    },
    onPromptInjected: async () => {
      recordProviderActivity();
      params.setThinking?.(true);
    },
    onPromptAccepted: async (input) => {
      recordProviderActivity();
      promptEchoSuppressor.recordAcceptedPrompt({ text: input.text });
      ensureAcceptedTurnStarted(input);
      state.turnInFlight = true;
      params.setThinking?.(true);
    },
    onInjectionFailure: (failure) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] prompt injection failed', {
        reason: failure.result.reason,
        phase: failure.result.phase,
        failureState: failure.failureState,
      });
      params.setThinking?.(false);
      if (failure.failureState === 'failed_ambiguous') {
        publishAmbiguousInjectionFailure(failure);
        return;
      }
      state.dispatchAttemptInFlight = false;
      state.lastTurnFailure = createProviderAcceptancePendingError(arbiter.snapshot());
      settleTurnCompletionWaiters();
    },
  });

  async function ensureHost(): Promise<TerminalHostHandle> {
    if (state.disposed) {
      throw new Error('Claude unified terminal runtime is disposed');
    }
    if (state.handle) return state.handle;
    // Respawn-attach can land on a pane holding the PREVIOUS runner's leftover draft: the seeded
    // registry must be loaded before any readiness/draft classification runs (ported S-1).
    await ownInjectedTextLog.hydrated;

    const resolution = await params.ctx.terminalHost.resolve({ preference: params.hostPreference });
    if (resolution.status !== 'resolved') {
      throw new Error(`Claude unified terminal host unavailable: ${resolution.reason}`);
    }

    const resolvedHookPluginDir = await ensureSessionHookPluginDir();
    // Ultracode and the statusline forwarder ride ONE --settings overlay (Claude Code keeps
    // only the FIRST --settings). The overlay value is secret-free: the forwarder reads the
    // hook secret from its 0600 secret file, never from the command line.
    const settingsOverlay: Record<string, unknown> = {
      ...(launchUltracode && isClaudeUltracodeSupportedModelId(launchModelId)
        ? { ultracode: true }
        : {}),
      ...(statuslineOverlaySettings ? { statusLine: statuslineOverlaySettings } : {}),
    };
    const sessionName = createClaudeUnifiedTerminalSessionName(params.happierSessionId);
    const handle = await params.ctx.terminalHost.createOrAttachHost({
      preference: params.hostPreference,
      sessionName,
      workingDirectory: params.directory,
      isolatedEnv: true,
      launch: {
        kind: 'agent-cli',
        agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
        args: [
          ...(resolvedHookPluginDir ? ['--plugin-dir', resolvedHookPluginDir] : []),
          ...(launchModelId ? ['--model', launchModelId] : []),
          ...(launchFallbackModelId ? ['--fallback-model', launchFallbackModelId] : []),
          ...buildClaudeEffortCliArgs({ modelId: launchModelId, effort: launchEffort }),
          // Single --settings overlay (ultracode + statusline forwarder). An unhonorable
          // ultracode request resolves to OFF: the gate is xhigh capability on the launch
          // model, so we never enable ultracode at a model that cannot offer it.
          ...(Object.keys(settingsOverlay).length > 0
            ? ['--settings', JSON.stringify(settingsOverlay)]
            : []),
          ...(launchPermissionMode ? ['--permission-mode', mapToClaudePermissionMode(launchPermissionMode)] : []),
        ],
        cwd: params.directory,
        env: params.launchEnv,
      },
    });
    state.handle = handle;
    return handle;
  }

  async function ensureSessionHookPluginDir(): Promise<string | null> {
    if (hookPluginDir) return hookPluginDir;
    if (!sessionHookServer) {
      hookSecret = randomUUID();
      sessionHookServer = await params.ctx.sessionHooks.startServer({
        providerId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
        sessionId: params.happierSessionId,
        sessionHookSecret: hookSecret,
        onSessionHook: async (providerSessionId, payload) => {
          state.providerSessionId = providerSessionId;
          const transcriptPath = readNonEmptyString(payload.transcript_path) ?? readNonEmptyString(payload.transcriptPath);
          if (transcriptPath) {
            statuslineTranscriptPath = transcriptPath;
          }
          await providerTranscriptPublisher.bindFromSessionHook(providerSessionId, payload);
        },
        onStatuslineUpdate: (payload) => {
          const parsed = parseClaudeStatuslinePayload(payload);
          if (!parsed) return;
          statuslineApplier.apply(parsed);
        },
        onPermissionHook: createClaudeUnifiedPermissionHookHandler(params.ctx),
        defaultPermissionHookResponse: buildDefaultPermissionHookResponse,
        permissionHookSecret: hookSecret,
        // Host response ceiling aligned with the installed Claude permission-hook `timeout`
        // (effectively-unlimited 7d, env-overridable via the shared resolver). The ceiling is
        // FINITE and >= the installed hook timeout, so a late answer that arrives after Claude
        // has already killed the forwarder honestly expires (408) instead of resolving into a
        // dead socket — the bridge never expires while the forwarder is alive (alignment
        // invariant). Interactive tools (AskUserQuestion / ExitPlanMode) inherit the SAME finite
        // ceiling: a `null` (unbounded) host wait would outlive Claude's installed hook timeout
        // and let a late answer resolve into a dead forwarder socket instead of honestly expiring.
        permissionRequestTimeoutMs: resolveClaudePermissionHookCeilingMs({ env: params.launchEnv }),
      }) as ClaudeUnifiedSessionHookServer;
    }

    const assets = await params.ctx.sessionHooks.resolveForwarderAssets();
    // Statusline forwarder overlay (merged into the single --settings at launch). STRICTLY
    // fail-open: hosts without the forwarder asset or without a 0600 secret file (the secret
    // must never ride argv — S7 hardening carry-over) leave the user's own statusline in charge.
    const statuslineForwarderScript = readNonEmptyString(assets.statuslineForwarderScript);
    const statuslineSecretFile = readNonEmptyString(sessionHookServer.sessionHookSecretFile);
    if (statuslineForwarderScript && statuslineSecretFile) {
      try {
        statuslineOverlaySettings = buildClaudeStatuslineOverlaySettings({
          nodeExecutable: assets.nodeExecutable,
          forwarderScriptPath: statuslineForwarderScript,
          port: sessionHookServer.port,
          secretFilePath: statuslineSecretFile,
          original: resolveClaudeStatuslineOriginalCommand({ env: params.launchEnv }),
        });
      } catch (error) {
        params.ctx.logger.debug('[ClaudeUnifiedTerminal] statusline overlay resolution failed (statusline forwarding off)', {
          error: error instanceof Error ? error.message : String(error),
        });
        statuslineOverlaySettings = null;
      }
    }
    const hooks = buildClaudeHookPluginHooks({
      port: sessionHookServer.port,
      nodeExecutable: assets.nodeExecutable,
      sessionForwarderScript: assets.sessionForwarderScript,
      permissionForwarderScript: assets.permissionForwarderScript,
      enableLocalPermissionBridge: true,
      ...(sessionHookServer.sessionHookSecretFile ? { sessionHookSecretFile: sessionHookServer.sessionHookSecretFile } : {}),
      ...(sessionHookServer.permissionHookSecretFile ? { permissionHookSecretFile: sessionHookServer.permissionHookSecretFile } : {}),
    });
    const manifest = buildClaudeHookPluginManifest({ instanceId: params.happierSessionId });
    hookPluginDir = await params.ctx.sessionHooks.createPluginDir({
      providerId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      files: [
        { path: '.claude-plugin/plugin.json', json: manifest },
        { path: 'hooks/hooks.json', json: hooks },
      ],
    });
    return hookPluginDir;
  }

  function recordProviderActivity(): void {
    lastProviderActivityAtMs = Date.now();
  }

  function resetCompletedTurnState(): void {
    staleTurnDemandActive = false;
    stopStaleTurnWake();
    state.activePromptText = null;
    state.dispatchAttemptInFlight = false;
    state.turnInFlight = false;
    state.activeTurnId = null;
    state.providerAccepted = false;
    state.turnCompleted = false;
    state.terminalOriginTurnInFlight = false;
    state.lastTurnFailure = null;
    params.setThinking?.(false);
  }

  function readPromptText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function isCompactPromptText(value: string | null | undefined): boolean {
    const text = readPromptText(value);
    return text === '/compact' || Boolean(text?.startsWith('/compact '));
  }

  function ensureTerminalOriginTurnStarted(promptText?: string): void {
    if (!state.activeTurnId) {
      state.promptNonce += 1;
      state.activeTurnId = createClaudeUnifiedTurnId(params.happierSessionId, state.promptNonce);
    }
    state.activePromptText = readPromptText(promptText);
    state.providerAccepted = true;
    state.turnInFlight = true;
    state.turnCompleted = false;
    params.setThinking?.(true);
  }

  function readPromptNonce(input: TerminalPromptInput): number | null {
    const nonce = input.origin?.nonce;
    if (typeof nonce !== 'string') return null;
    const prefix = `${params.happierSessionId}:`;
    if (!nonce.startsWith(prefix)) return null;
    const parsed = Number.parseInt(nonce.slice(prefix.length), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function ensureAcceptedTurnStarted(input: TerminalPromptInput): void {
    const promptNonce = readPromptNonce(input) ?? state.promptNonce;
    if (!state.activeTurnId) {
      state.activeTurnId = createClaudeUnifiedTurnId(params.happierSessionId, promptNonce);
    }
    state.activePromptText = input.text;
    state.dispatchAttemptInFlight = false;
    state.providerAccepted = true;
    state.turnInFlight = true;
    state.turnCompleted = false;
  }

  function publishAmbiguousInjectionFailure(failure: ClaudeUnifiedPromptInjectionFailure): void {
    publishClaudeUnifiedRuntimeEvent({
      handlers,
      logger: params.ctx.logger,
      event: {
        kind: 'backend-error',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        error: {
          code: 'claude_unified_terminal_injection_failed',
          message: createProviderAcceptancePendingError(arbiter.snapshot()).message,
          cause: {
            failureState: failure.failureState,
            reason: failure.result.reason,
            phase: failure.result.phase,
            duplicateRisk: failure.result.duplicateRisk,
            recoverable: failure.result.recoverable,
          },
        },
      },
    });
  }

  function hasQueuedPromptAwaitingProviderAcceptance(): boolean {
    const snapshot = arbiter.snapshot();
    return snapshot.queuedCount > 0 && snapshot.headInputState === 'awaiting_provider_acceptance';
  }

  function recordTerminalOriginTurnStarted(promptText?: string): void {
    if (hasQueuedPromptAwaitingProviderAcceptance()) {
      state.terminalOriginTurnInFlight = true;
      params.setThinking?.(true);
      return;
    }
    ensureTerminalOriginTurnStarted(promptText);
  }

  function consumeTerminalOriginTurnCompletion(): boolean {
    if (!state.terminalOriginTurnInFlight) return false;
    state.terminalOriginTurnInFlight = false;
    return true;
  }

  async function materializeTerminalOriginPrompt(params2: Readonly<{
    text?: string;
    observedAtMs?: number;
    source: 'hook' | 'transcript';
  }>): Promise<void> {
    const text = readPromptText(params2.text);
    if (!text) return;
    const observedAtMs =
      typeof params2.observedAtMs === 'number' && Number.isFinite(params2.observedAtMs)
        ? Math.trunc(params2.observedAtMs)
        : Date.now();
    if (promptEchoSuppressor.consumeAcceptedPromptEcho({ text, observedAtMs })) return;
    if (
      params2.source === 'transcript'
      && promptEchoSuppressor.consumeMaterializedTerminalPromptDuplicate({ text, observedAtMs })
    ) {
      return;
    }

    state.terminalOriginPromptNonce += 1;
    const localId = `${params.happierSessionId}:claude-terminal-origin-${state.terminalOriginPromptNonce}`;
    publishClaudeUnifiedRuntimeEvent({
      handlers,
      logger: params.ctx.logger,
      event: {
        kind: 'transcript-user-text',
        sessionId: params.happierSessionId,
        emittedAtMs: observedAtMs,
        text,
        localId,
        meta: {
          provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
          source: 'cli',
          sentFrom: 'cli',
          terminalOrigin: true,
        },
      },
    });
    if (params2.source === 'hook') {
      promptEchoSuppressor.recordMaterializedTerminalPrompt({
        text,
        materializedAtMs: observedAtMs,
      });
    }
  }

  function readTurnCompletionFailure(): Error | null {
    if (state.disposed && (state.turnInFlight || state.dispatchAttemptInFlight)) {
      return new Error('Claude unified terminal runtime was disposed while a turn was in flight');
    }
    if (state.lastTurnFailure) {
      return state.lastTurnFailure;
    }
    const snapshot = arbiter.snapshot();
    if (snapshot.headInputState === 'failed_terminal') {
      return createProviderAcceptancePendingError(snapshot);
    }
    return null;
  }

  function rejectTurnCompletionWaiters(error: Error): void {
    if (completionWaiters.size === 0) return;
    const waiters = Array.from(completionWaiters);
    completionWaiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  function resolveTurnCompletionWaiters(): void {
    if (completionWaiters.size === 0) return;
    const waiters = Array.from(completionWaiters);
    completionWaiters.clear();
    resetCompletedTurnState();
    for (const waiter of waiters) waiter.resolve();
  }

  function settleTurnCompletionWaiters(): void {
    const failure = readTurnCompletionFailure();
    if (failure) {
      rejectTurnCompletionWaiters(failure);
      return;
    }
    if (state.turnCompleted) {
      resolveTurnCompletionWaiters();
    }
  }

  function recordScreenProgress(screenText: string): void {
    if (screenText !== lastObservedScreenText) {
      lastObservedScreenText = screenText;
      lastScreenProgressAtMs = Date.now();
    }
  }

  function resetUserDraftStarvation(): void {
    consecutiveUserDraftDeferrals = 0;
    userDraftEpisodeStartedAtMs = null;
    userDraftEscalated = false;
  }

  function hasPromptDeliveryDemand(): boolean {
    return arbiter.snapshot().queuedCount > 0 || state.dispatchAttemptInFlight;
  }

  // Bounded clear of an OWN injection leftover: only when the draft EXACTLY matches text this
  // runtime injected, and NEVER while the screen is generating (Escape would interrupt the
  // running turn — deliberate fail-safe). A genuine user draft can never match.
  async function maybeClearOwnLeftoverDraft(
    handle: TerminalHostHandle,
    screen: ReturnType<typeof parseClaudeScreenState>,
  ): Promise<ReturnType<typeof parseClaudeScreenState> | null> {
    if (screen.generating) return null;
    if (!ownInjectedTextLog.matches(screen.composerContent)) return null;
    for (let attempt = 1; attempt <= MAX_OWN_LEFTOVER_DRAFT_CLEAR_ATTEMPTS; attempt += 1) {
      try {
        await params.ctx.terminalHost.interruptTurn(handle);
      } catch (error) {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] own leftover draft clear failed', { error, attempt });
        return null;
      }
      const recapture = await params.ctx.terminalHost.captureInputState(handle).catch(() => null);
      if (!recapture) return null;
      const next = parseClaudeScreenState(recapture.currentInput);
      if (!next.userDraftPresent) {
        params.ctx.logger.info('[ClaudeUnifiedTerminal] cleared own leftover composer draft', {
          sessionId: params.happierSessionId,
          attempts: attempt,
        });
        resetUserDraftStarvation();
        return next;
      }
      if (next.generating || !ownInjectedTextLog.matches(next.composerContent)) return null;
    }
    return null;
  }

  function noteUserDraftDeferral(screen: ReturnType<typeof parseClaudeScreenState>): void {
    if (!hasPromptDeliveryDemand()) return;
    consecutiveUserDraftDeferrals += 1;
    if (userDraftEpisodeStartedAtMs === null) userDraftEpisodeStartedAtMs = Date.now();
    if (
      userDraftEscalated
      || consecutiveUserDraftDeferrals < USER_DRAFT_STARVATION_VETO_THRESHOLD
      || Date.now() - userDraftEpisodeStartedAtMs < USER_DRAFT_STARVATION_MIN_EPISODE_MS
    ) {
      return;
    }
    userDraftEscalated = true;
    const draftLength = screen.composerContent?.length ?? 0;
    const ownDraft = ownInjectedTextLog.matches(screen.composerContent);
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] user draft starvation escalated', {
      sessionId: params.happierSessionId,
      consecutiveDeferrals: consecutiveUserDraftDeferrals,
      draftLength,
      ownDraft,
    });
    publishClaudeUnifiedRuntimeEvent({
      handlers,
      logger: params.ctx.logger,
      event: {
        kind: 'backend-error',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        error: {
          code: 'claude_unified_terminal_user_draft_blocking',
          message: 'A draft typed in the Claude terminal composer is blocking delivery of queued messages. Send or clear the draft in the terminal to let them through.',
          cause: {
            draftLength,
            ownDraft,
            consecutiveDeferrals: consecutiveUserDraftDeferrals,
          },
        },
      },
    });
  }

  async function observeCurrentReadiness(): Promise<void> {
    const handle = await ensureHost();
    lastSteerVetoReason = null;
    const liveness = await params.ctx.terminalHost.evaluateLiveness(handle).catch((error: unknown) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] terminal liveness check failed', { error });
      return null;
    });
    if (!liveness) {
      lastObservedPaneAlive = null;
      lastReadinessKind = 'deferred';
      arbiter.observeReadiness({
        status: 'defer_liveness_uncertain',
        observedAt: Date.now(),
        reason: 'liveness_probe_failed',
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      });
      return;
    }
    lastObservedPaneAlive = liveness.paneAlive === true;
    if (!liveness.paneAlive) {
      if (liveness.paneDead === true) {
        // The host confirmed the pane is dead. Terminalize: there is no recovery path.
        lastReadinessKind = 'failed';
        arbiter.observeReadiness({
          status: 'failed_terminal',
          observedAt: liveness.observedAt,
          reason: 'pane_dead',
          hostKind: handle.kind,
          hostSessionName: handle.sessionName,
          ...(handle.paneId ? { paneId: handle.paneId } : {}),
          liveness,
          recoverable: false,
        });
        return;
      }
      // Non-alive but NOT confirmed dead is a transient liveness observation (e.g. a momentary
      // non-interactive command during heavy resume/startup). Defer with a bounded wake — the
      // same treatment as a failed liveness probe — instead of terminalizing on a blip. A
      // genuinely dead pane is reported with `paneDead: true` by the tmux/zellij adapters and
      // takes the terminal branch above.
      lastReadinessKind = 'deferred';
      arbiter.observeReadiness({
        status: 'defer_liveness_uncertain',
        observedAt: liveness.observedAt,
        reason: 'liveness_non_alive_transient',
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
        liveness,
      });
      return;
    }
    const inputState = await params.ctx.terminalHost.captureInputState(handle).catch(() => null);
    if (inputState && !inputState.stable) {
      lastReadinessKind = 'deferred';
      lastSteerVetoReason = 'user_typing';
      arbiter.observeReadiness({
        status: 'defer_user_typing',
        observedAt: inputState.observedAt,
        reason: 'user_typing',
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
        liveness,
      });
      return;
    }
    if (inputState) {
      // ONE shared screen-state owner for readiness and steer decisions: the parser
      // recognizes the real TUI composer shapes (boxed `│ > │`, the `❯` glyph, mode
      // markers) so a live rendered composer is never false-negatively deferred.
      let screen = parseClaudeScreenState(inputState.currentInput);
      recordScreenProgress(screen.text);
      if (screen.userDraftPresent && hasPromptDeliveryDemand()) {
        const clearedScreen = await maybeClearOwnLeftoverDraft(handle, screen);
        if (clearedScreen) {
          screen = clearedScreen;
          recordScreenProgress(screen.text);
        }
      }
      if (!isClaudeScreenReadyForInput(screen)) {
        const turnRunning = state.turnInFlight || state.terminalOriginTurnInFlight;
        const steerVeto = resolveClaudeScreenInFlightSteerVeto(screen);
        if (turnRunning && steerVeto === null) {
          // In-flight steer safe-window: the screen is provably generating with a clean
          // composer — Claude natively queues typed text and submits it at turn end.
          params.ctx.logger.info('[ClaudeUnifiedTerminal] steer window safe', {
            sessionId: params.happierSessionId,
            decision: 'safe',
            generating: screen.generating,
          });
          resetUserDraftStarvation();
          lastReadinessKind = 'writable_steer';
          steerCapabilityPublisher.publish({ available: true, reason: null });
          arbiter.observeReadiness(createClaudeUnifiedWritableReadiness(handle, state.activeTurnId));
          return;
        }
        if (turnRunning && steerVeto) {
          params.ctx.logger.info('[ClaudeUnifiedTerminal] steer window vetoed', {
            sessionId: params.happierSessionId,
            decision: 'vetoed',
            reason: steerVeto,
            // Veto telemetry carries draft evidence (the incident veto loop had none).
            ...(steerVeto === 'user_draft' ? {
              draftLength: screen.composerContent?.length ?? 0,
              ownDraft: ownInjectedTextLog.matches(screen.composerContent),
            } : {}),
          });
          lastSteerVetoReason = steerVeto;
          if (steerVeto !== 'user_draft') {
            steerCapabilityPublisher.publish({ available: false, reason: 'unsafe_window' });
          }
        }
        lastReadinessKind = 'deferred';
        if (screen.userDraftPresent) {
          noteUserDraftDeferral(screen);
          if (turnRunning) {
            // X1: an escalated draft starvation keeps its honest published reason instead of
            // downgrading to a generic unsafe window (published AFTER the escalation check).
            steerCapabilityPublisher.publish({
              available: false,
              reason: userDraftEscalated ? 'user_terminal_draft' : 'unsafe_window',
            });
          }
          arbiter.observeReadiness({
            status: 'defer_user_typing',
            observedAt: inputState.observedAt,
            reason: 'user_draft',
            hostKind: handle.kind,
            hostSessionName: handle.sessionName,
            ...(handle.paneId ? { paneId: handle.paneId } : {}),
            liveness,
          });
          return;
        }
        resetUserDraftStarvation();
        arbiter.observeReadiness({
          status: 'defer_provider_starting',
          observedAt: inputState.observedAt,
          reason: 'screen_not_interactive',
          hostKind: handle.kind,
          hostSessionName: handle.sessionName,
          ...(handle.paneId ? { paneId: handle.paneId } : {}),
          liveness,
        });
        return;
      }
    }
    resetUserDraftStarvation();
    lastReadinessKind = 'writable';
    arbiter.observeReadiness(createClaudeUnifiedWritableReadiness(handle, state.activeTurnId));
  }

  function stopReadinessWake(): void {
    if (readinessWakeTimer) {
      clearTimeout(readinessWakeTimer);
      readinessWakeTimer = null;
    }
    readinessWaitStartedAtMs = null;
  }

  function readinessWakeNeeded(): boolean {
    if (state.disposed) return false;
    const snapshot = arbiter.snapshot();
    return snapshot.queuedCount > 0
      && (snapshot.headInputState === 'waiting_for_readiness' || snapshot.headInputState === 'queued');
  }

  // Bounded startup-readiness wake: a deferred prompt re-polls the screen until it becomes
  // interactive or the adaptive window expires. SessionStart is host-alive evidence that
  // holds the wait through static stalls up to the hard ceiling; a live-but-unconfirmed
  // host must keep progressing (screen output changing) past the base window; anything
  // else fails fast after the base window. On expiry the prompt fails with a STRUCTURED
  // runtime issue carrying sanitized diagnostics — never a silent hang or a generic fatal.
  function ensureReadinessWake(): void {
    if (readinessWakeTimer || state.disposed) return;
    if (!readinessWakeNeeded()) return;
    if (readinessWaitStartedAtMs === null) {
      readinessWaitStartedAtMs = Date.now();
      lastScreenProgressAtMs = Date.now();
    }
    const delayMs = userDraftEscalated
      ? Math.max(startupReadinessConfig.pollIntervalMs, USER_DRAFT_STARVATION_RECHECK_MS)
      : startupReadinessConfig.pollIntervalMs;
    readinessWakeTimer = setTimeout(() => {
      readinessWakeTimer = null;
      void runReadinessWakeTick().catch((error: unknown) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] readiness wake tick failed', { error });
      });
    }, delayMs);
    readinessWakeTimer.unref?.();
  }

  async function runReadinessWakeTick(): Promise<void> {
    if (!readinessWakeNeeded()) {
      stopReadinessWake();
      return;
    }
    await observeCurrentReadiness().catch((error: unknown) => {
      params.ctx.logger.warn('[ClaudeUnifiedTerminal] readiness wake observation failed', { error });
    });
    if (!readinessWakeNeeded()) {
      stopReadinessWake();
      return;
    }
    const startedAt = readinessWaitStartedAtMs ?? Date.now();
    const elapsedMs = Date.now() - startedAt;
    const sessionStartObserved = state.providerSessionId !== null;
    const hostAlive = sessionStartObserved || lastObservedPaneAlive === true;
    const screenStaticForMs = Date.now() - (lastScreenProgressAtMs ?? startedAt);
    const timedOut = elapsedMs >= startupReadinessConfig.extendedTimeoutMs
      || (elapsedMs >= startupReadinessConfig.baseTimeoutMs && !hostAlive)
      || (
        elapsedMs >= startupReadinessConfig.baseTimeoutMs
        && !sessionStartObserved
        && screenStaticForMs > startupReadinessConfig.progressGraceMs
      );
    if (!timedOut) {
      ensureReadinessWake();
      return;
    }
    failStartupReadiness({ elapsedMs, hostAlive, sessionStartObserved });
  }

  function failStartupReadiness(diagnostics: Readonly<{
    elapsedMs: number;
    hostAlive: boolean;
    sessionStartObserved: boolean;
  }>): void {
    stopReadinessWake();
    const handle = state.handle;
    const lastScreenTail = boundReadinessDiagnosticTail(lastObservedScreenText);
    arbiter.observeReadiness({
      status: 'failed_terminal',
      observedAt: Date.now(),
      reason: 'startup_readiness_timeout',
      ...(handle ? {
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      } : {}),
      recoverable: false,
    });
    state.dispatchAttemptInFlight = false;
    state.lastTurnFailure = recordClaudeUnifiedTurnFailure({
      evidence: {
        code: 'claude_unified_terminal_readiness_timeout',
        message: 'Claude unified terminal did not become ready for input before the startup readiness window expired',
        elapsedMs: diagnostics.elapsedMs,
        hostAlive: diagnostics.hostAlive,
        sessionStartObserved: diagnostics.sessionStartObserved,
        lastScreenTail,
      },
      fallbackMessage: 'Claude unified terminal startup readiness timed out',
      handlers,
      logger: params.ctx.logger,
      publishedFailureTurnIds,
      sessionId: params.happierSessionId,
      turnId: state.activeTurnId ?? createClaudeUnifiedTurnId(params.happierSessionId, state.promptNonce),
      // Session-scoped failure: publish begin+fail so the session-turn lifecycle commits the
      // failed turn instead of dropping a turn-failed it never saw begin (SILENT-F1 port).
      allocateTurnWhenIdle: true,
    });
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] startup readiness timed out', {
      sessionId: params.happierSessionId,
      ...diagnostics,
      lastScreenTail,
    });
    params.setThinking?.(false);
    settleTurnCompletionWaiters();
  }

  function stopStaleTurnWake(): void {
    if (staleTurnWakeTimer) {
      clearTimeout(staleTurnWakeTimer);
      staleTurnWakeTimer = null;
    }
  }

  function staleTurnRecoveryNeeded(): boolean {
    return !state.disposed
      && staleTurnDemandActive
      && (state.turnInFlight || state.terminalOriginTurnInFlight);
  }

  function ensureStaleTurnWake(): void {
    if (staleTurnWakeTimer || state.disposed) return;
    if (!staleTurnRecoveryNeeded()) return;
    staleTurnWakeTimer = setTimeout(() => {
      staleTurnWakeTimer = null;
      void runStaleTurnWakeTick().catch((error: unknown) => {
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] stale-turn wake tick failed', { error });
      });
    }, staleTurnRecoveryConfig.pollIntervalMs);
    staleTurnWakeTimer.unref?.();
  }

  // Bounded, demand-driven stale-turn recovery: only runs while a prompt is queued behind the
  // running turn. A turn is reconciled as ended ONLY when the provider has been silent for the
  // whole window AND the screen proves an idle interactive composer (turn likely ended). A
  // generating screen, fresh lifecycle activity, or a failed capture keeps the wait (fail-closed).
  async function runStaleTurnWakeTick(): Promise<void> {
    if (!staleTurnRecoveryNeeded()) {
      stopStaleTurnWake();
      if (!state.turnInFlight && !state.terminalOriginTurnInFlight) staleTurnDemandActive = false;
      return;
    }
    const lastActivityAtMs = lastProviderActivityAtMs ?? Date.now();
    if (lastProviderActivityAtMs === null) lastProviderActivityAtMs = lastActivityAtMs;
    const silentForMs = Date.now() - lastActivityAtMs;
    if (silentForMs < staleTurnRecoveryConfig.windowMs) {
      ensureStaleTurnWake();
      return;
    }
    const handle = state.handle;
    if (!handle) {
      ensureStaleTurnWake();
      return;
    }
    const inputState = await params.ctx.terminalHost.captureInputState(handle).catch(() => null);
    if (!inputState || !inputState.stable) {
      ensureStaleTurnWake();
      return;
    }
    const screen = parseClaudeScreenState(inputState.currentInput);
    if (!isClaudeScreenReadyForInput(screen)) {
      ensureStaleTurnWake();
      return;
    }
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] stale turn reconciled as ended', {
      sessionId: params.happierSessionId,
      silentForMs,
      turnId: state.activeTurnId,
      terminalOriginTurnInFlight: state.terminalOriginTurnInFlight,
    });
    staleTurnDemandActive = false;
    stopStaleTurnWake();
    state.providerAccepted = true;
    state.turnCompleted = true;
    if (completionWaiters.size > 0) {
      settleTurnCompletionWaiters();
    } else {
      resetCompletedTurnState();
    }
  }

  const CONVERGENCE_KNOWN_CONFIG_OPTION_IDS = new Set(['reasoning_effort', 'effort', 'ultracode']);

  // L5d convergence: whether a post-launch runtime-config update requests ONLY values that already
  // equal the effective config. Conservative: any unrecognized directive, unknown config
  // option, or diverging value means NOT converged (the override stays pending). Baseline is the
  // statusline-VERIFIED effective truth when observed (lane Y: the TUI's actual model/effort),
  // falling back to the launch-effective config; a `default` model request still converges only
  // against the launch intent (no override at launch).
  function isRuntimeConfigUpdateConvergedWithLaunch(update: Readonly<Record<string, unknown>>): boolean {
    let sawRecognizedDirective = false;
    for (const key of Object.keys(update)) {
      const value = update[key];
      if (value === undefined) continue;
      if (key === 'modelId') {
        const modelId = readNonEmptyString(value);
        if (modelId === null) continue;
        sawRecognizedDirective = true;
        const requested = modelId === 'default' ? null : modelId;
        if (requested === null) {
          // "default" = no override; converged only when none was launched (verified truth
          // cannot prove what "default" resolves to).
          if (launchModelId !== null) return false;
        } else if (requested !== (verifiedModelId ?? launchModelId)) {
          return false;
        }
        continue;
      }
      if (key === 'fallbackModel') {
        sawRecognizedDirective = true;
        if (value === null) {
          if (launchFallbackModelId !== null) return false;
          continue;
        }
        const fallback = readNonEmptyString(value);
        if (fallback === null) return false;
        const requested = fallback === 'default' ? null : fallback;
        if (requested !== launchFallbackModelId) return false;
        continue;
      }
      if (key === 'configOption') {
        if (value === null) continue;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        const optionId = readNonEmptyString((value as Record<string, unknown>).id);
        if (optionId === null || !CONVERGENCE_KNOWN_CONFIG_OPTION_IDS.has(optionId)) return false;
        continue;
      }
      if (key === 'configOptions') {
        if (value === null) continue;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        for (const optionId of Object.keys(value as Record<string, unknown>)) {
          if (!CONVERGENCE_KNOWN_CONFIG_OPTION_IDS.has(optionId)) return false;
        }
        continue;
      }
      if (key === 'modeId') {
        if (value === null) continue;
        // The unified terminal cannot honor session-mode changes at all; never claim convergence.
        return false;
      }
      // Unknown directive: never claim convergence for something we do not understand.
      return false;
    }
    const effort = readEffortFromRuntimeConfigUpdate(update);
    if (effort !== null) {
      sawRecognizedDirective = true;
      const effectiveEffort = verifiedEffort ?? launchEffort;
      if (effectiveEffort === null || effort.toLowerCase() !== effectiveEffort.toLowerCase()) return false;
    }
    const ultracode = readUltracodeFromRuntimeConfigUpdate(update);
    if (ultracode !== null) {
      sawRecognizedDirective = true;
      if (ultracode !== launchUltracode) return false;
    }
    if ((update.configOption != null || update.configOptions != null) && effort === null && ultracode === null) {
      // A config option was addressed but carried no comparable value (e.g. malformed payload).
      return false;
    }
    return sawRecognizedDirective;
  }

  const nativeRuntime: ClaudeUnifiedTerminalNativeRuntime = {
    beginTurnLifecycle() {
      state.promptNonce += 1;
      state.dispatchAttemptInFlight = true;
      state.lastTurnFailure = null;
      state.providerAccepted = false;
      state.turnCompleted = false;
      params.setThinking?.(true);
    },
    async startOrLoadSession() {
      const handle = await ensureHost();
      await observeCurrentReadiness();
      return {
        sessionId: handle.sessionName,
        hostKind: handle.kind,
        hostSessionName: handle.sessionName,
        ...(handle.paneId ? { paneId: handle.paneId } : {}),
      };
    },
    async sendTurnPrompt(prompt) {
      if (!state.activeTurnId && !state.dispatchAttemptInFlight) nativeRuntime.beginTurnLifecycle();
      await observeCurrentReadiness();
      const input = createClaudeUnifiedPromptInput({
        text: prompt,
        sessionId: params.happierSessionId,
        nonce: state.promptNonce,
        isSteer: false,
      });
      arbiter.enqueue(input);
      await arbiter.drain();
      ensureReadinessWake();
    },
    async steerInFlightTurn(message) {
      await observeCurrentReadiness();
      state.promptNonce += 1;
      const input = createClaudeUnifiedPromptInput({
        text: message,
        sessionId: params.happierSessionId,
        nonce: state.promptNonce,
        isSteer: true,
      });
      arbiter.enqueue(input);
      await arbiter.drain();
      ensureReadinessWake();
    },
    // Host in-flight steer hooks (consumed by the session loop's InFlightSteerController):
    // a prompt delivered while a turn is running is steered into the live TUI when the
    // screen is provably safe; any veto throws so the host falls back to the bounded
    // pending queue and drains at turn end per policy.
    supportsInFlightSteer() {
      return true;
    },
    isTurnInFlight() {
      return !state.disposed && (state.turnInFlight || state.terminalOriginTurnInFlight);
    },
    canSteerPrompt() {
      return !state.disposed && (state.turnInFlight || state.terminalOriginTurnInFlight);
    },
    async steerPrompt(prompt: string) {
      const text = readPromptText(prompt);
      if (!text) return;
      if (state.disposed) {
        throw new Error('claude_unified_steer_vetoed: runtime_disposed');
      }
      if (text.startsWith('/')) {
        // Slash/special commands are never steered mid-turn; they keep the deferred
        // path and drain at turn end as normal new-turn prompts.
        params.ctx.logger.info('[ClaudeUnifiedTerminal] steer window vetoed', {
          sessionId: params.happierSessionId,
          decision: 'vetoed',
          reason: 'slash_command',
        });
        throw new Error('claude_unified_steer_vetoed: slash_command');
      }
      await observeCurrentReadiness();
      if (lastReadinessKind !== 'writable' && lastReadinessKind !== 'writable_steer') {
        throw new Error(`claude_unified_steer_vetoed: ${lastSteerVetoReason ?? 'screen_not_steerable'}`);
      }
      state.promptNonce += 1;
      const input = createClaudeUnifiedPromptInput({
        text,
        sessionId: params.happierSessionId,
        nonce: state.promptNonce,
        isSteer: true,
      });
      arbiter.enqueue(input);
      await arbiter.drain();
      ensureReadinessWake();
    },
    notifyPromptQueuedDuringTurn() {
      if (state.disposed) return;
      if (!state.turnInFlight && !state.terminalOriginTurnInFlight) return;
      staleTurnDemandActive = true;
      if (lastProviderActivityAtMs === null) lastProviderActivityAtMs = Date.now();
      ensureStaleTurnWake();
    },
    async applyConfigDeltaInFlight(delta): Promise<ClaudeUnifiedInFlightConfigApplyOutcome> {
      const controller = await ensureTuiController();
      if (!controller) {
        // Gate off / no control port: the message keeps the legacy queue path so the mode
        // change applies when the queue drains at turn end.
        return { status: 'unsupported', reason: 'tui_runtime_control_unavailable' };
      }
      const outcome = await controller.applyPermissionModeInFlight({ permissionMode: delta.permissionMode });
      await controller.whenControlIdle();
      runtimeConfigOutcomeEmitter.emit(outcome);
      if (outcome.status === 'applied' && outcome.promptMayProceed) {
        launchPermissionMode = delta.permissionMode;
        return { status: 'applied' };
      }
      const detail = outcome.timing !== undefined ? `${outcome.status}:${outcome.timing}` : outcome.status;
      return { status: 'failed', reason: `in_flight_mode_apply_${detail}` };
    },
    async waitForTurnCompletion() {
      const failure = readTurnCompletionFailure();
      if (failure) throw failure;
      if (state.turnCompleted) {
        resetCompletedTurnState();
        return;
      }
      if (!state.turnInFlight && !state.providerAccepted && !state.dispatchAttemptInFlight) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = Object.freeze({
          resolve,
          reject,
        });
        completionWaiters.add(waiter);
        settleTurnCompletionWaiters();
      });
    },
    subscribeRuntimeEvents(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async respondToPermission(requestId, approved) {
      await params.ctx.session.permissions.requestDecision({
        provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
        requestId,
        approved,
      });
    },
    async cancelTurn() {
      stopReadinessWake();
      staleTurnDemandActive = false;
      stopStaleTurnWake();
      const handle = state.handle;
      if (handle) {
        await params.ctx.terminalHost.interruptTurn(handle);
      }
      state.turnInFlight = false;
      state.activeTurnId = null;
      state.activePromptText = null;
      state.dispatchAttemptInFlight = false;
      state.providerAccepted = false;
      state.turnCompleted = false;
      state.lastTurnFailure = null;
      state.terminalOriginTurnInFlight = false;
      params.setThinking?.(false);
      rejectTurnCompletionWaiters(new Error('Claude unified terminal turn was cancelled'));
    },
    readSessionIdentity() {
      return { sessionId: state.providerSessionId };
    },
    async updateSessionRuntimeConfig(update) {
      if (state.handle) {
        // The Claude TUI is already running. Convergence short-circuit (L5d, anti-hot-loop): when
        // every requested value already equals the effective config there is nothing left to
        // apply, so report `skipped_already_effective` and let the override-synchronizer stop
        // re-attempting it.
        if (isRuntimeConfigUpdateConvergedWithLaunch(update)) {
          return Object.freeze({ status: 'applied', timing: 'skipped_already_effective' } as const);
        }
        // Live TUI runtime control (feature-gated): route the update through the verified
        // controller (`/model`, `/effort`, ShiftTab mode cycling). Deferred timings keep the
        // override pending on the synchronizer; outcome events ride the runtime-config-outcome
        // session-event contract.
        const controller = await ensureTuiController();
        if (controller) {
          const resolution = mapRuntimeConfigUpdateToDesired(update, {
            launchPermissionMode,
            effectiveModelId: verifiedModelId ?? launchModelId,
          });
          if (resolution.kind === 'desired') {
            const outcome = await controller.applyDesiredRuntimeConfig({
              desired: resolution.desired,
              reason: 'out_of_band',
            });
            await controller.whenControlIdle();
            runtimeConfigOutcomeEmitter.emit(outcome);
            const mapped = mapApplyOutcomeToUpdateOutcome(outcome);
            if (mapped.status === 'applied' && mapped.timing !== 'queued_until_safe_window'
              && mapped.timing !== 'scheduled_for_next_prompt' && mapped.timing !== 'next_idle') {
              // Fold the now-effective values into the launch-effective baseline so the
              // convergence check and a future respawn reflect the applied config.
              if (resolution.desired.model !== undefined) launchModelId = resolution.desired.model;
              if (resolution.desired.reasoningEffort !== undefined) launchEffort = resolution.desired.reasoningEffort;
              if (resolution.desired.ultracode !== undefined) launchUltracode = resolution.desired.ultracode;
              if (resolution.desired.agentModeId === 'plan' || resolution.desired.permissionMode !== undefined) {
                launchPermissionMode = resolveClaudePermissionModeFromRuntimeMode({
                  permissionMode: resolution.desired.permissionMode ?? launchPermissionMode ?? 'default',
                  agentModeId: resolution.desired.agentModeId ?? null,
                });
              }
            }
            return Object.freeze(mapped);
          }
          return Object.freeze({
            status: 'requires_interactive_control',
            reason: resolution.reason,
          } as const);
        }
        // Gate off / no control port: model/effort/fallback stay launch-time only, so this
        // override cannot take effect now. A non-applied outcome (gap 27) keeps the override
        // pending on the host instead of marking it swallowed-but-applied.
        return Object.freeze({
          status: 'requires_interactive_control',
          reason: 'claude_unified_terminal_running',
        } as const);
      }
      const modelId = readNonEmptyString(update.modelId);
      if (modelId && modelId !== 'default') {
        launchModelId = modelId;
      }
      const fallbackModel = readNonEmptyString(update.fallbackModel);
      if (fallbackModel && fallbackModel !== 'default') {
        launchFallbackModelId = fallbackModel;
      } else if (update.fallbackModel === null) {
        launchFallbackModelId = null;
      }
      const effort = readEffortFromRuntimeConfigUpdate(update);
      if (effort) {
        launchEffort = effort;
      }
      const ultracode = readUltracodeFromRuntimeConfigUpdate(update);
      if (ultracode !== null) {
        launchUltracode = ultracode;
      }
      const modeId = readNonEmptyString(update.modeId);
      if (modeId) {
        // Plan wins over the raw permission mode at spawn; a non-plan agent mode leaves the
        // current launch permission mode intact (it has no Claude permission-mode equivalent).
        launchPermissionMode = resolveClaudePermissionModeFromRuntimeMode({
          permissionMode: launchPermissionMode ?? 'default',
          agentModeId: modeId,
        });
      }
      // Captured into the next launch args; it will take effect before the next prompt.
      return Object.freeze({ status: 'applied', timing: 'before_next_prompt' } as const);
    },
    async resetOrDisposeRuntime() {
      state.disposed = true;
      stopReadinessWake();
      staleTurnDemandActive = false;
      stopStaleTurnWake();
      steerCapabilityPublisher.dispose();
      arbiter.dispose();
      runtimeConfigOutcomeEmitter.dispose();
      if (tuiController) {
        await tuiController.dispose().catch(() => undefined);
        tuiController = null;
        tuiControllerPromise = null;
      }
      const handle = state.handle;
      state.handle = null;
      params.setThinking?.(false);
      let terminalHostDisposeError: unknown;
      let cleanupError: unknown;
      const recordCleanupError = (error: unknown, message: string): void => {
        if (cleanupError === undefined) cleanupError = error;
        params.ctx.logger.warn(message, { error });
      };
      try {
        if (handle) await params.ctx.terminalHost.dispose(handle);
      } catch (error) {
        terminalHostDisposeError = error;
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] terminal host dispose failed', { error });
      } finally {
        try {
          try {
            await providerTranscriptPublisher.dispose();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] provider transcript cleanup failed');
          }
          try {
            unsubscribeLifecycleEvents?.();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] lifecycle unsubscribe failed');
          } finally {
            unsubscribeLifecycleEvents = null;
          }
          try {
            if (hookPluginDir) {
              await params.ctx.sessionHooks.disposePluginDir(hookPluginDir);
            }
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] hook plugin cleanup failed');
          }
          try {
            await sessionHookServer?.dispose();
          } catch (error) {
            recordCleanupError(error, '[ClaudeUnifiedTerminal] hook server cleanup failed');
          }
        } finally {
          sessionHookServer = null;
          hookPluginDir = null;
          hookSecret = null;
          state.providerSessionId = null;
          state.activeTurnId = null;
          state.activePromptText = null;
          state.dispatchAttemptInFlight = false;
          state.providerAccepted = false;
          state.turnCompleted = false;
          state.turnInFlight = false;
          state.terminalOriginTurnInFlight = false;
          state.lastTurnFailure = null;
          publishedFailureTurnIds.clear();
          rejectTurnCompletionWaiters(new Error('Claude unified terminal runtime was disposed'));
          handlers.clear();
        }
      }
      if (terminalHostDisposeError) throw terminalHostDisposeError;
      if (cleanupError) throw cleanupError;
    },
    async confirmProviderAcceptance(evidence) {
      const accepted = await arbiter.confirmProviderAcceptance(evidence);
      if (accepted) {
        params.setThinking?.(true);
      }
      return accepted;
    },
    async observeTerminalLifecycle(observation) {
      if (observation.agentId !== CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID) return;
      recordProviderActivity();
      if (observation.type === 'prompt_submitted') {
        const acceptedQueuedPrompt = await nativeRuntime.confirmProviderAcceptance({
          ...(observation.promptText ? { promptText: observation.promptText } : {}),
        });
        if (acceptedQueuedPrompt) {
          // FIFO multi-steer: once the head prompt is accepted, re-evaluate the screen so
          // the next queued prompt (e.g. a second steer) can take its safe window.
          if (arbiter.snapshot().queuedCount > 0) {
            await observeCurrentReadiness();
            await arbiter.drain();
            ensureReadinessWake();
          }
          return;
        }
        recordTerminalOriginTurnStarted(observation.promptText);
        await materializeTerminalOriginPrompt({
          ...(observation.promptText ? { text: observation.promptText } : {}),
          ...(typeof observation.observedAtMs === 'number' ? { observedAtMs: observation.observedAtMs } : {}),
          source: observation.source,
        });
        return;
      }
      if (observation.type === 'compaction_started') {
        arbiter.observeCompaction({ phase: 'started' });
        return;
      }
      if (observation.type === 'compaction_completed') {
        const acceptedCompactPrompt = await nativeRuntime.confirmProviderAcceptance({
          promptText: '/compact',
          includeTimedOutAmbiguous: true,
        });
        const completesActiveCompactPrompt = acceptedCompactPrompt || isCompactPromptText(state.activePromptText);
        arbiter.observeCompaction({ phase: 'completed' });
        if (completesActiveCompactPrompt) {
          state.providerAccepted = true;
          state.turnCompleted = true;
          settleTurnCompletionWaiters();
          return;
        }
        await observeCurrentReadiness();
        await arbiter.drain();
        ensureReadinessWake();
        return;
      }
      if (observation.type === 'completion_candidate') {
        // Turn-end evidence arms the deferred acceptance timeout of a steered prompt:
        // Claude submits queued steer text right after the turn ends.
        arbiter.armPendingProviderAcceptanceTimeout();
        if (consumeTerminalOriginTurnCompletion()) return;
        if (!state.activeTurnId && !state.providerAccepted) return;
        state.providerAccepted = true;
        state.turnCompleted = true;
        settleTurnCompletionWaiters();
        return;
      }
      if (observation.type === 'completion_candidate_invalidated') {
        state.turnCompleted = false;
        return;
      }
      if (observation.type === 'turn_failed') {
        arbiter.armPendingProviderAcceptanceTimeout();
        if (consumeTerminalOriginTurnCompletion()) return;
        state.dispatchAttemptInFlight = false;
        await recordClaudeRuntimeProviderAccountUsageSnapshot({
          ctx: params.ctx,
          evidence: observation.evidence ?? observation.detail ?? observation.reason,
          sessionId: params.happierSessionId,
          launchEnv: params.launchEnv,
        });
        state.lastTurnFailure = recordClaudeUnifiedTurnFailure({
          evidence: observation.detail ?? observation.reason,
          fallbackMessage: observation.detail ?? observation.reason,
          handlers,
          logger: params.ctx.logger,
          publishedFailureTurnIds,
          sessionId: params.happierSessionId,
          turnId: state.activeTurnId,
        });
        state.turnCompleted = true;
        params.setThinking?.(false);
        settleTurnCompletionWaiters();
        return;
      }
      if (observation.type === 'turn_aborted') {
        arbiter.armPendingProviderAcceptanceTimeout();
        if (consumeTerminalOriginTurnCompletion()) return;
        state.dispatchAttemptInFlight = false;
        state.lastTurnFailure = recordClaudeUnifiedTurnFailure({
          evidence: observation.detail,
          fallbackMessage: observation.detail,
          handlers,
          logger: params.ctx.logger,
          publishedFailureTurnIds,
          sessionId: params.happierSessionId,
          turnId: state.activeTurnId,
        });
        state.turnCompleted = true;
        params.setThinking?.(false);
        settleTurnCompletionWaiters();
        return;
      }
      if (observation.type === 'process_exited' && (state.turnInFlight || state.dispatchAttemptInFlight)) {
        state.dispatchAttemptInFlight = false;
        state.lastTurnFailure = recordClaudeUnifiedProcessExitFailure({
          exitCode: observation.exitCode, signal: observation.signal, handlers,
          logger: params.ctx.logger, publishedFailureTurnIds,
          sessionId: params.happierSessionId, turnId: state.activeTurnId,
        });
        state.turnCompleted = true;
        params.setThinking?.(false);
        settleTurnCompletionWaiters();
        return;
      }
      if (observation.type === 'process_exited' && !state.disposed) {
        // IDLE host death (SILENT-F1 port): the Claude process died between turns. Surface a
        // structured failed turn (allocated begin+fail) instead of staying silent. Turn state
        // is deliberately untouched — there is no in-flight turn to settle and the allocated
        // failure must not poison the next turn's completion contract.
        recordClaudeUnifiedProcessExitFailure({
          exitCode: observation.exitCode, signal: observation.signal, handlers,
          logger: params.ctx.logger, publishedFailureTurnIds,
          sessionId: params.happierSessionId, turnId: null,
          allocateTurnWhenIdle: true,
        });
        params.ctx.logger.warn('[ClaudeUnifiedTerminal] host process exited while session was idle', {
          sessionId: params.happierSessionId,
          exitCode: observation.exitCode,
          signal: observation.signal,
        });
      }
    },
  };

  unsubscribeLifecycleEvents = subscribeClaudeUnifiedTerminalLifecycleEvents({
    ctx: params.ctx,
    happierSessionId: params.happierSessionId,
    observer: nativeRuntime,
  });

  return {
    operations: nativeRuntime,
    nativeRuntime,
  };
}
