import type { TerminalControlPort } from '@happier-dev/agents';

import type { ClaudeTuiModeMarker } from '../screenState.js';
import type {
  ClaudeProviderConfigurationOutcomeStatus,
  ClaudeProviderConfigurationOutcomeTiming,
} from '../../../providerOperations.js';
import type { SettingsGuard } from './settingsGuard.js';
import type { ClaudeTuiControlTelemetrySink } from './telemetry.js';

export type RuntimeConfigOutcomeStatusV1 = ClaudeProviderConfigurationOutcomeStatus;
export type RuntimeConfigOutcomeTimingV1 = ClaudeProviderConfigurationOutcomeTiming;
export type RuntimeConfigOutcomeChangeKeyV1 =
  | 'model'
  | 'fallbackModel'
  | 'permissionMode'
  | 'reasoningEffort'
  | 'maxThinkingTokens'
  | 'launchOption'
  | 'sessionMode';

/**
 * Canonical feature id that gates the Claude Unified TUI runtime-control controller.
 *
 * The controller itself consumes a resolved boolean ({@link ClaudeTuiControlControllerDeps.featureEnabled})
 * so it stays testable in isolation and never reaches for ad-hoc env checks. The integration layer
 * resolves this id through the canonical feature system (`ctx.features.isEnabled`); the id is
 * registered in `packages/protocol/src/features/catalog.ts` (fail-closed, default OFF).
 */
export const CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID =
  'agents.claude.unifiedTerminal.tuiRuntimeControl' as const;

export type ClaudeUnifiedTuiRuntimeControlFeatureId =
  typeof CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL_FEATURE_ID;

export type { ClaudeTuiModeMarker } from '../screenState.js';

/**
 * Probe-verified Claude TUI permission/plan mode cycle members. `default` is detected by the ABSENCE
 * of a status-bar marker. `auto`/`bypassPermissions` are model/account-gated and may be unreachable;
 * the controller must verify the marker after each cycle press rather than counting presses.
 */
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
  /** Reasoning effort level (e.g. `low|medium|high|xhigh|max|ultracode`). */
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
   * `in_flight_steer` applies a permission/plan mode delta DURING a running turn in the
   * probe-proven (Q-A) steer-safe generating window so a config-carrying message can still steer.
   */
  reason?: ApplyRuntimeConfigReason | undefined;
}>;

/** Mode-only desired config accepted by the in-flight steer apply path. */
export type ClaudeDesiredInFlightModeConfig = Pick<ClaudeDesiredRuntimeConfig, 'permissionMode' | 'agentModeId'>;

/** Provider lifecycle evidence used to confirm verified runtime config (e.g. `UserPromptSubmit`). */
export type ClaudePromptSubmitMetadata = Readonly<{
  model?: string | undefined;
  permissionMode?: string | undefined;
  reasoningEffort?: string | undefined;
  effort?: string | undefined;
}>;

/**
 * Statusline-reported EFFECTIVE runtime facts. The statusline is faster than `UserPromptSubmit`
 * and is the only live source of reasoning effort, so it acts as a second effective-truth feed
 * into `lastVerified`. Fields are optional because the payload shape is Claude-owned (haiku omits
 * effort); absent fields must be ignored, never reset.
 */
export type ClaudeStatuslineRuntimeMetadata = Readonly<{
  model?: string | undefined;
  reasoningEffort?: string | undefined;
}>;

export interface ClaudeUnifiedTuiControlController {
  applyDesiredRuntimeConfig(input: ApplyRuntimeConfigInput): Promise<RuntimeConfigApplyOutcome>;
  /**
   * Apply ONLY a permission/plan mode delta during a running turn (steer-safe generating window,
   * probe Q-A). Deliberately does NOT merge/flush the pending next-idle stash (model/effort must
   * never be typed mid-generation); a deferred mode result is re-stashed for the next prompt.
   */
  applyPermissionModeInFlight(desired: ClaudeDesiredInFlightModeConfig): Promise<RuntimeConfigApplyOutcome>;
  scheduleDesiredRuntimeConfig(input: ApplyRuntimeConfigInput): RuntimeConfigScheduleOutcome;
  reconcileAfterProviderPromptSubmit(metadata: ClaudePromptSubmitMetadata): void;
  /**
   * Fold statusline-reported EFFECTIVE model/effort into `lastVerified` only. NEVER writes
   * desired-state surfaces and never types into the TUI — a statusline re-emit of an old value
   * only marks what IS effective, feeding the `already_effective` convergence.
   */
  reconcileFromStatusline(metadata: ClaudeStatuslineRuntimeMetadata): void;
  getLastVerifiedRuntimeConfig(): ClaudeUnifiedVerifiedRuntimeConfig;
  /** True while a control op holds the terminal lock; prompt injection must not run while held. */
  isControlInFlight(): boolean;
  /** Resolves once no control op holds the lock. Prompt injection awaits this. */
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
  /** Interval between post-Enter verification polls (confirmations may render late). */
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
  /** Resolved feature-gate decision. When false the controller returns fallback outcomes only. */
  featureEnabled: boolean;
  settingsGuard: SettingsGuard;
  telemetry?: ClaudeTuiControlTelemetrySink | undefined;
  nowMs?: (() => number) | undefined;
  wait?: ((ms: number) => Promise<void>) | undefined;
  timings?: Partial<ClaudeTuiControlTimings> | undefined;
  /** Bounded ShiftTab cycle attempts before declaring a mode unreachable. */
  maxModeCycleAttempts?: number | undefined;
  /**
   * Fired whenever the controller actually submits a slash command to the TUI: the integration
   * layer registers it for transcript echo suppression so controller-typed command rows never
   * surface as UI messages while genuine user-typed commands still do.
   */
  onControlCommandTyped?: ((commandText: string) => void) | undefined;
  /**
   * Fired the moment a slash command's text is WRITTEN into the composer, before verification or
   * Enter (ported S-7 / RESUME2). The integration layer records it in the own-injected-text
   * registry so a typed-but-never-submitted leftover (e.g. after a TOCTOU abort whose cleanup
   * Escape failed to clear the text) is recognized as our own residue instead of being classified
   * as a foreign user draft that permanently blocks idle prompt injection. Echo suppression must
   * stay on the SUBMIT hook only: suppressing a never-submitted text could swallow a real message.
   */
  onControlCommandTextEntered?: ((commandText: string) => void) | undefined;
}>;
