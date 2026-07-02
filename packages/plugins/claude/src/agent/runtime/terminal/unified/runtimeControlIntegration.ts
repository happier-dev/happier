import type {
  RuntimeConfigOutcomeChangeKeyV1,
  RuntimeConfigOutcomeStatusV1,
  RuntimeConfigOutcomeTimingV1,
} from '@happier-dev/protocol';
import type { RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';

import { isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';
import type {
  ClaudeDesiredRuntimeConfig,
  RuntimeConfigApplyOutcome,
  RuntimeConfigChangeOutcome,
  RuntimeConfigOutcomeScalar,
} from './tuiControls/index.js';

/**
 * Runtime-control integration bridge for the Claude Unified terminal.
 *
 * Connects the host's `updateSessionRuntimeConfig` updates (the override-synchronizer surface) to
 * the TUI runtime-control controller and owns the `runtime-config-outcome` session-event emission:
 *
 * - Map a {@link RuntimeTurnConfigUpdate}-shaped record onto {@link ClaudeDesiredRuntimeConfig}.
 *   Directives the controller cannot own (fallback model, model reset-to-default, unknown keys)
 *   resolve to `not_controllable` so the caller keeps the legacy non-applied outcome.
 * - Map controller apply outcomes back onto the typed `RuntimeConfigUpdateOutcomeV1` the
 *   synchronizer consumes (still-pending deferrals keep the override pending and re-attempted).
 * - Emit protocol `runtime-config-outcome` transcript events grouped by per-change public status
 *   with (status,timing,reason)-transition dedup so a re-attempted blocked apply does not spam
 *   the transcript. The `sessionMode` change key is emitted directly (dev protocol ships it).
 */

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBooleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export type ClaudeUnifiedDesiredUpdateResolution =
  | Readonly<{ kind: 'desired'; desired: ClaudeDesiredRuntimeConfig }>
  | Readonly<{ kind: 'not_controllable'; reason: string }>;

const CONTROLLABLE_CONFIG_OPTION_IDS = new Set(['reasoning_effort', 'effort', 'ultracode']);

/**
 * Map a host runtime-config update onto the controller's desired-config shape. Conservative:
 * any directive the controller cannot own fails the WHOLE update over to the legacy
 * `requires_interactive_control` path (a partially-applied update would let the synchronizer
 * mark unhonored directives as applied).
 */
export function mapRuntimeConfigUpdateToDesired(
  update: Readonly<Record<string, unknown>>,
  context: Readonly<{
    /** Effective permission mode the session launched with (plan-exit cycles back to it). */
    launchPermissionMode: string | null;
    /** Verified-or-launch model id used to capability-gate ultracode requests. */
    effectiveModelId: string | null;
  }>,
): ClaudeUnifiedDesiredUpdateResolution {
  const desired: {
    model?: string;
    reasoningEffort?: string;
    permissionMode?: string;
    agentModeId?: string | null;
    ultracode?: boolean;
  } = {};

  for (const key of Object.keys(update)) {
    const value = update[key];
    if (value === undefined || value === null) continue;
    if (key === 'modelId') {
      const modelId = readNonEmptyString(value);
      if (modelId === null) continue;
      if (modelId === 'default') {
        // "default" = reset-to-no-override; `/model` cannot prove what default resolves to.
        return { kind: 'not_controllable', reason: 'model_default_reset_not_controllable' };
      }
      desired.model = modelId;
      continue;
    }
    if (key === 'fallbackModel') {
      // No TUI control exists for the fallback model; launch-arg only.
      return { kind: 'not_controllable', reason: 'fallback_model_launch_only' };
    }
    if (key === 'configOption') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { kind: 'not_controllable', reason: 'malformed_config_option' };
      }
      const option = value as Record<string, unknown>;
      const optionId = readNonEmptyString(option.id);
      if (optionId === null || !CONTROLLABLE_CONFIG_OPTION_IDS.has(optionId)) {
        return { kind: 'not_controllable', reason: `unknown_config_option:${optionId ?? 'missing'}` };
      }
      if (optionId === 'ultracode') {
        const ultracode = readBooleanValue(option.value);
        if (ultracode === null) return { kind: 'not_controllable', reason: 'malformed_config_option' };
        // Capability-gate so the controller never types `/effort ultracode` at a model that does
        // not offer it (conservative: an unhonorable ON request resolves to OFF).
        desired.ultracode = ultracode && isClaudeUltracodeSupportedModelId(context.effectiveModelId);
      } else {
        const effort = readNonEmptyString(option.value);
        if (effort === null) return { kind: 'not_controllable', reason: 'malformed_config_option' };
        desired.reasoningEffort = effort;
      }
      continue;
    }
    if (key === 'configOptions') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { kind: 'not_controllable', reason: 'malformed_config_options' };
      }
      const options = value as Record<string, unknown>;
      for (const optionId of Object.keys(options)) {
        if (!CONTROLLABLE_CONFIG_OPTION_IDS.has(optionId)) {
          return { kind: 'not_controllable', reason: `unknown_config_option:${optionId}` };
        }
      }
      const effort = readNonEmptyString(options.reasoning_effort) ?? readNonEmptyString(options.effort);
      if (effort !== null) desired.reasoningEffort = effort;
      const ultracode = readBooleanValue(options.ultracode);
      if (ultracode !== null) {
        desired.ultracode = ultracode && isClaudeUltracodeSupportedModelId(context.effectiveModelId);
      }
      continue;
    }
    if (key === 'modeId') {
      const modeId = readNonEmptyString(value);
      if (modeId === null) continue;
      if (modeId === 'plan') {
        desired.agentModeId = 'plan';
      } else {
        // Leaving plan (or any non-plan agent mode): hand control back to the launch-effective
        // permission mode through the verified cycle.
        desired.agentModeId = null;
        desired.permissionMode = context.launchPermissionMode ?? 'default';
      }
      continue;
    }
    // Unknown directive: never partially honor an update we do not fully understand.
    return { kind: 'not_controllable', reason: `unknown_directive:${key}` };
  }

  if (
    desired.model === undefined
    && desired.reasoningEffort === undefined
    && desired.ultracode === undefined
    && desired.permissionMode === undefined
    && desired.agentModeId === undefined
  ) {
    return { kind: 'not_controllable', reason: 'no_controllable_directives' };
  }
  return { kind: 'desired', desired };
}

/**
 * Project a controller apply outcome onto the typed `updateSessionRuntimeConfig` return the
 * override-synchronizer consumes. Still-pending deferral timings keep the override pending
 * (`isRuntimeConfigUpdateOutcomeApplied` treats them as not-applied), so the synchronizer
 * re-attempts at the next boundary instead of marking the override swallowed-but-applied.
 */
export function mapApplyOutcomeToUpdateOutcome(outcome: RuntimeConfigApplyOutcome): RuntimeConfigUpdateOutcomeV1 {
  const reason = outcome.changes.find((change) => change.reason !== undefined)?.reason;
  return Object.freeze({
    status: outcome.status,
    ...(outcome.timing !== undefined ? { timing: outcome.timing } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
}

export type ClaudeUnifiedRuntimeConfigOutcomeChange = Readonly<{
  key: RuntimeConfigOutcomeChangeKeyV1;
  requested?: RuntimeConfigOutcomeScalar | undefined;
  previous?: RuntimeConfigOutcomeScalar | undefined;
  effective?: RuntimeConfigOutcomeScalar | undefined;
  reason?: string | undefined;
}>;

export type ClaudeUnifiedRuntimeConfigOutcomeSessionEvent = Readonly<{
  type: 'runtime-config-outcome';
  provider: typeof CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID;
  runtime: 'claude-unified-terminal';
  status: RuntimeConfigOutcomeStatusV1;
  timing?: RuntimeConfigOutcomeTimingV1;
  reason?: string;
  message: string;
  changes: ClaudeUnifiedRuntimeConfigOutcomeChange[];
}>;

function describeGroupEntry(change: ClaudeUnifiedRuntimeConfigOutcomeChange): string {
  const value = change.effective ?? change.requested;
  if (value === undefined || value === null || value === '') return change.key;
  return `${change.key} → ${String(value)}`;
}

function describeGroup(
  status: RuntimeConfigOutcomeStatusV1,
  changes: readonly ClaudeUnifiedRuntimeConfigOutcomeChange[],
): string {
  const joined = changes.map(describeGroupEntry).join(', ');
  switch (status) {
    case 'applied':
      return `Applied Claude Unified runtime controls: ${joined}.`;
    case 'requires_restart':
      return `Claude Unified runtime changes require a session restart: ${joined}.`;
    case 'requires_interactive_control':
      return `Claude Unified runtime changes need interactive control: ${joined}.`;
    case 'unsupported':
      return `Claude Unified runtime changes are unsupported: ${joined}.`;
    case 'failed':
      return `Failed to apply Claude Unified runtime controls: ${joined}.`;
  }
}

export type ClaudeUnifiedRuntimeConfigOutcomeEmitter = Readonly<{
  emit(outcome: RuntimeConfigApplyOutcome): void;
  dispose(): void;
}>;

/**
 * Single owner of the `runtime-config-outcome` session-event emission. Groups the per-change
 * outcomes by their public status so each emitted event's single status is accurate, and dedups
 * per (key,requested) on the (status,timing,reason) signature so re-attempted blocked applies
 * emit only on transitions.
 */
export function createClaudeUnifiedRuntimeConfigOutcomeEmitter(params: Readonly<{
  sendSessionEvent: (event: ClaudeUnifiedRuntimeConfigOutcomeSessionEvent) => void;
}>): ClaudeUnifiedRuntimeConfigOutcomeEmitter {
  const lastEmittedChangeSignatures = new Map<string, string>();

  function changeSignature(change: RuntimeConfigChangeOutcome): string {
    return [change.status, change.timing ?? '', change.reason ?? ''].join('|');
  }

  return {
    emit(outcome: RuntimeConfigApplyOutcome): void {
      const transitionedChanges = outcome.changes.filter((change) => {
        const dedupKey = `${change.key}:${String(change.requested)}`;
        const signature = changeSignature(change);
        if (lastEmittedChangeSignatures.get(dedupKey) === signature) return false;
        lastEmittedChangeSignatures.set(dedupKey, signature);
        return true;
      });
      const grouped = new Map<RuntimeConfigOutcomeStatusV1, RuntimeConfigChangeOutcome[]>();
      for (const change of transitionedChanges) {
        const list = grouped.get(change.status) ?? [];
        list.push(change);
        grouped.set(change.status, list);
      }
      for (const [status, changes] of grouped) {
        const timings = new Set(changes.map((c) => c.timing));
        const sharedTiming = timings.size === 1 ? changes[0].timing : undefined;
        const sharedReason = changes.find((c) => c.reason !== undefined)?.reason;
        const emittedChanges: ClaudeUnifiedRuntimeConfigOutcomeChange[] = changes.map((change) => ({
          key: change.key,
          ...(change.requested !== undefined ? { requested: change.requested } : {}),
          ...(change.previous !== undefined ? { previous: change.previous } : {}),
          ...(change.effective !== undefined ? { effective: change.effective } : {}),
          ...(change.reason !== undefined ? { reason: change.reason } : {}),
        }));
        params.sendSessionEvent({
          type: 'runtime-config-outcome',
          provider: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
          runtime: 'claude-unified-terminal',
          status,
          ...(sharedTiming !== undefined ? { timing: sharedTiming } : {}),
          ...(sharedReason !== undefined ? { reason: sharedReason } : {}),
          message: describeGroup(status, emittedChanges),
          changes: emittedChanges,
        });
      }
    },
    dispose(): void {
      lastEmittedChangeSignatures.clear();
    },
  };
}
