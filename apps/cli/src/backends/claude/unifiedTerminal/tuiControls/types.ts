import type {
  RuntimeConfigOutcomeChangeKeyV1,
  RuntimeConfigOutcomeStatusV1,
  RuntimeConfigOutcomeTimingV1,
} from '@happier-dev/protocol';
import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';

import type { ClaudeUnifiedIndependentControlSubmissionResolution } from '../acceptedPromptTranscriptDiscovery';
import type { SettingsGuard } from './settingsGuard';
import type { ClaudeTuiControlTelemetrySink } from './telemetry';
import type { ClaudeUnifiedDialogId } from './dialogRegistry';

/**
 * Canonical feature id that gates the Claude Unified TUI runtime-control controller (B15).
 *
 * The controller itself consumes a resolved boolean ({@link ClaudeTuiControlControllerDeps.featureEnabled})
 * so it stays testable in isolation and never reaches for ad-hoc env checks. The integration layer
 * (runner/launcher) resolves this id through the canonical feature system. Registering the id in
 * `packages/protocol/src/features/catalog.ts` + the exhaustive `uiFeatureRegistry.ts` leaf is a small
 * cross-lane follow-up (see lane-D.md) because those registries live outside this controller's folder.
 */
export const CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID =
  'providers.claude.unifiedTerminal.tuiRuntimeControl' as const;

export type ClaudeUnifiedTuiRuntimeControlFeatureId =
  typeof CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID;

/**
 * Probe-verified Claude TUI permission/plan mode cycle members. A hidden footer is unknown;
 * default requires its legacy shortcuts footer or explicit manual marker.
 * `auto`/`bypassPermissions` are model/account-gated and may be unreachable;
 * the controller must verify the marker after each cycle press rather than counting presses.
 */
export type ClaudeTuiModeMarker = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

export const CLAUDE_TUI_MODE_MARKERS: readonly ClaudeTuiModeMarker[] = Object.freeze([
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]);

/**
 * Desired runtime configuration, normalized from durable session metadata. Fields are the canonical
 * Happier control inputs; the controller maps them onto verified TUI controls.
 */
export type ClaudeDesiredRuntimeConfig = Readonly<{
  /** Claude-accepted model alias or full id (e.g. `sonnet`, `claude-sonnet-4-6`). */
  model?: string | undefined;
  /** Reasoning effort level (e.g. `low|medium|high|xhigh|max|auto|ultracode`). */
  reasoningEffort?: string | undefined;
  /** Canonical Happier permission mode (`default|acceptEdits|plan|bypassPermissions|dontAsk|auto`, plus aliases). */
  permissionMode?: string | undefined;
  /** Session mode id; `plan` selects plan mode through the verified cycle. */
  agentModeId?: string | null | undefined;
  /** Max thinking tokens; unsupported in Unified (no TUI control exists). */
  maxThinkingTokens?: number | undefined;
  /**
   * Session-only ultracode setting (already capability-gated upstream). Applied via
   * `/effort ultracode`; off re-selects an effort level (the `/effort` menu replaces
   * ultracode with the chosen level). Mapped onto the `launchOption` outcome change key
   * to stay protocol-compatible (no new change-key enum member).
   */
  ultracode?: boolean | undefined;
}>;

export type ClaudeUnifiedVerifiedRuntimeConfig = Readonly<{
  model: string | null;
  reasoningEffort: string | null;
  modeMarker: ClaudeTuiModeMarker | null;
  verifiedAtMs: number | null;
}>;

export type RuntimeConfigOutcomeScalar = string | number | boolean | null;

export type RuntimeConfigChangeOutcome = Readonly<{
  key: RuntimeConfigOutcomeChangeKeyV1;
  status: RuntimeConfigOutcomeStatusV1;
  timing?: RuntimeConfigOutcomeTimingV1 | undefined;
  requested?: RuntimeConfigOutcomeScalar | undefined;
  previous?: RuntimeConfigOutcomeScalar | undefined;
  effective?: RuntimeConfigOutcomeScalar | undefined;
  reason?: string | undefined;
}>;

export type RuntimeConfigApplyOutcome = Readonly<{
  /** Aggregate public status across all attempted changes. Always one of the five frozen statuses. */
  status: RuntimeConfigOutcomeStatusV1;
  timing?: RuntimeConfigOutcomeTimingV1 | undefined;
  changes: readonly RuntimeConfigChangeOutcome[];
  /**
   * False when a required control could not be made effective, so a dependent prompt MUST NOT be
   * injected under the wrong configuration. `requires_restart`/`unsupported` are non-blocking
   * fallbacks (the existing restart-notice path handles them); `failed`/`requires_interactive_control`
   * block the prompt.
   */
  promptMayProceed: boolean;
  message: string;
}>;

export type RuntimeConfigScheduleOutcome = Readonly<{
  status: RuntimeConfigOutcomeStatusV1;
  timing?: RuntimeConfigOutcomeTimingV1 | undefined;
  scheduled: boolean;
  message: string;
}>;

export type ApplyRuntimeConfigReason = 'before_prompt' | 'out_of_band' | 'in_flight_steer';

export type ApplyRuntimeConfigInput = Readonly<{
  desired: ClaudeDesiredRuntimeConfig;
  /**
   * `before_prompt` runs the controls immediately before a dependent prompt injection (model/effort
   * safe window). `out_of_band` is a no-prompt runtime change requested by the UI/CLI.
   * `in_flight_steer` (lane Q) applies a permission/plan mode delta DURING a running turn in the
   * probe-proven (Q-A) steer-safe generating window so a config-carrying message can still steer.
   */
  reason?: ApplyRuntimeConfigReason | undefined;
  /**
   * Internal integration control for split before-prompt applies: dependent permission/plan deltas
   * must not merge the controller's pending next-idle model/effort stash back into the prompt gate.
   * Defaults to true for all existing callers.
   */
  includePending?: boolean | undefined;
}>;

/** Mode-only desired config accepted by the in-flight steer apply path (lane Q). */
export type ClaudeDesiredInFlightModeConfig = Pick<ClaudeDesiredRuntimeConfig, 'permissionMode' | 'agentModeId'>;

/** Provider lifecycle evidence used to confirm verified runtime config (e.g. `UserPromptSubmit`). */
export type ClaudePromptSubmitMetadata = Readonly<{
  model?: string | undefined;
  permissionMode?: string | undefined;
  reasoningEffort?: string | undefined;
  effort?: string | undefined;
}>;

/**
 * Statusline-reported EFFECTIVE runtime facts (lane Y). The statusline is faster than
 * `UserPromptSubmit` and is the only live source of reasoning effort, so it acts as a second
 * effective-truth feed into `lastVerified`. Fields are optional because the payload shape is
 * Claude-owned (haiku omits effort); absent effort is retained only for the same model.
 */
export type ClaudeStatuslineRuntimeMetadata = Readonly<{
  model?: string | undefined;
  reasoningEffort?: string | undefined;
}>;

export interface ClaudeUnifiedTuiControlController {
  applyDesiredRuntimeConfig(input: ApplyRuntimeConfigInput): Promise<RuntimeConfigApplyOutcome>;
  /**
   * Lane Q: apply ONLY a permission/plan mode delta during a running turn (steer-safe generating
   * window, probe Q-A). Deliberately does NOT merge/flush the pending next-idle stash (model/effort
   * must never be typed mid-generation); a deferred mode result is re-stashed for the next prompt.
   */
  applyPermissionModeInFlight(desired: ClaudeDesiredInFlightModeConfig): Promise<RuntimeConfigApplyOutcome>;
  scheduleDesiredRuntimeConfig(input: ApplyRuntimeConfigInput): RuntimeConfigScheduleOutcome;
  reconcileAfterProviderPromptSubmit(metadata: ClaudePromptSubmitMetadata): void;
  /**
   * Lane Y: fold statusline-reported EFFECTIVE model/effort into `lastVerified` only. NEVER
   * writes desired-state surfaces and never types into the TUI — a statusline re-emit of an old
   * value only marks what IS effective, feeding the `already_effective` convergence.
   */
  reconcileFromStatusline(metadata: ClaudeStatuslineRuntimeMetadata): void;
  getLastVerifiedRuntimeConfig(): ClaudeUnifiedVerifiedRuntimeConfig;
  getPendingRuntimeConfig(): ClaudeDesiredRuntimeConfig;
  /** True while a control op holds the terminal lock; Lane E must not inject prompts while held. */
  isControlInFlight(): boolean;
  /** True only while a Happier-initiated slash control owns this registered follow-up dialog. */
  ownsDialog(dialogId: ClaudeUnifiedDialogId): boolean;
  /** Resolves once no control op holds the lock. Lane E awaits this before prompt injection. */
  whenControlIdle(): Promise<void>;
  dispose(): Promise<void>;
}

/** Tunable settle delays. Injected as a whole in tests so no real wall-clock time is spent. */
export type ClaudeTuiControlTimings = Readonly<{
  /** Delay after typing a slash command, before recapturing to check the slash picker. */
  slashPickerSettleMs: number;
  /** Delay after sending Enter, before recapturing to verify the command result/dialog. */
  commandSettleMs: number;
  /** Delay after a ShiftTab press, before recapturing the mode marker. */
  modeCycleSettleMs: number;
  /** Interval between post-Enter verification polls (L2: confirmation may render late). */
  verifyPollIntervalMs: number;
  /** Bounded total verification window before a submitted command is reported delivered-unverified. */
  verifyPollTimeoutMs: number;
}>;

export const DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS: ClaudeTuiControlTimings = Object.freeze({
  slashPickerSettleMs: 250,
  commandSettleMs: 350,
  modeCycleSettleMs: 200,
  verifyPollIntervalMs: 300,
  verifyPollTimeoutMs: 4_500,
});

export type ClaudeTuiControlControllerDeps = Readonly<{
  port: TerminalControlPort;
  /** Resolved feature-gate decision (B15). When false the controller returns fallback outcomes only. */
  featureEnabled: boolean;
  settingsGuard: SettingsGuard;
  telemetry?: ClaudeTuiControlTelemetrySink | undefined;
  nowMs?: (() => number) | undefined;
  wait?: ((ms: number) => Promise<void>) | undefined;
  timings?: Partial<ClaudeTuiControlTimings> | undefined;
  /** Bounded ShiftTab cycle attempts before declaring a mode unreachable. */
  maxModeCycleAttempts?: number | undefined;
  /**
   * Fired whenever the controller actually submits a slash command to the TUI (L3): the integration
   * layer registers it for JSONL transcript echo suppression so controller-typed `<command-name>…`
   * rows never surface as UI messages while genuine user-typed commands still do.
   */
  onControlCommandTyped?: ((commandText: string) => void) | undefined;
  /**
   * Fired at the verified pre-Enter boundary. Provider transcript ownership must be registered
   * here: type-time is too early (the command may abort), and post-Enter is too late (the JSONL
   * command row may already have arrived).
   */
  onControlCommandWillSubmit?: ((commandText: string) => string | null) | undefined;
  /** Resolves the exact pre-Enter registration with the terminal write disposition. */
  onControlCommandSubmissionResolved?: ((
    input: ClaudeUnifiedIndependentControlSubmissionResolution,
  ) => void) | undefined;
  /**
   * Fired the moment a slash command's text is WRITTEN into the composer, before verification or
   * Enter (incident cmq8y3nlx, RESUME2). The integration layer records it in the own-composer-text
   * registry so a typed-but-never-submitted leftover (e.g. after a TOCTOU abort whose cleanup
   * Escape failed to clear the text) is recognized as our own residue instead of being classified
   * as a foreign user draft that permanently blocks idle prompt injection.
   */
  onControlCommandTextEntered?: ((commandText: string) => void) | undefined;
}>;
