import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  isClaudeUltracodeSupportedModelId,
  resolveClaudeEffectiveEffortForModel,
} from '../../reasoningEffort.js';
import type { ClaudeProviderConfigurationOutcome } from '../../providerOperations.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';
import type {
  ClaudeDesiredRuntimeConfig,
  RuntimeConfigApplyOutcome,
  RuntimeConfigChangeOutcome,
  RuntimeConfigOutcomeChangeKeyV1,
  RuntimeConfigOutcomeScalar,
  RuntimeConfigOutcomeStatusV1,
  RuntimeConfigOutcomeTimingV1,
} from './tuiControls/index.js';

/**
 * Runtime-control integration bridge for the Claude Unified terminal.
 *
 * Connects the host's `updateProviderConfiguration` updates (the override-synchronizer surface) to
 * the TUI runtime-control controller and owns the `runtime-config-outcome` session-event emission:
 *
 * - Map a {@link RuntimeTurnConfigUpdate}-shaped record onto {@link ClaudeDesiredRuntimeConfig}.
 *   Directives the controller cannot own (fallback model, model reset-to-default, unknown keys)
 *   resolve to `not_controllable` so the caller keeps the legacy non-applied outcome.
 * - Map controller apply outcomes back onto the typed provider-configuration outcome the
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
    /** Exact Provider model facts when this is a Provider-bound Claude session. */
    providerModel?: AgentSessionProviderBinding['model'];
    /** Installed Claude CLI exposes the effort control surface. */
    supportsEffort: boolean;
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
    if (key === 'permissionMode') {
      const permissionMode = readNonEmptyString(value);
      if (permissionMode === null) continue;
      desired.permissionMode = permissionMode;
      continue;
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
        if (!context.supportsEffort) {
          return { kind: 'not_controllable', reason: 'effort_unsupported_by_installed_cli' };
        }
        const ultracode = readBooleanValue(option.value);
        if (ultracode === null) return { kind: 'not_controllable', reason: 'malformed_config_option' };
        if (ultracode && !isClaudeUltracodeSupportedModelId(
          desired.model ?? context.effectiveModelId,
          context.providerModel,
        )) {
          return { kind: 'not_controllable', reason: 'ultracode_unsupported_for_model' };
        }
        desired.ultracode = ultracode;
      } else {
        if (!context.supportsEffort) {
          return { kind: 'not_controllable', reason: 'effort_unsupported_by_installed_cli' };
        }
        const effort = readNonEmptyString(option.value);
        if (effort === null) return { kind: 'not_controllable', reason: 'malformed_config_option' };
        const effectiveEffort = resolveClaudeEffectiveEffortForModel({
          modelId: desired.model ?? context.effectiveModelId,
          effort,
          ...(context.providerModel ? { providerModel: context.providerModel } : {}),
        });
        if (!effectiveEffort) {
          return { kind: 'not_controllable', reason: 'effort_unsupported_for_model' };
        }
        desired.reasoningEffort = effectiveEffort;
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
 * Project a controller apply outcome onto the typed `updateProviderConfiguration` return the
 * override-synchronizer consumes. Still-pending deferral timings keep the override pending
 * (`isRuntimeConfigUpdateOutcomeApplied` treats them as not-applied), so the synchronizer
 * re-attempts at the next boundary instead of marking the override swallowed-but-applied.
 */
export function mapApplyOutcomeToUpdateOutcome(
  outcome: RuntimeConfigApplyOutcome,
): ClaudeProviderConfigurationOutcome {
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
  agentId: typeof CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID;
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
  emit(outcome: RuntimeConfigApplyOutcome): Promise<void>;
  dispose(): void;
}>;

/**
 * Single owner of the `runtime-config-outcome` session-event emission. Groups the per-change
 * outcomes by their public status so each emitted event's single status is accurate, and dedups
 * per (key,requested) on the (status,timing,reason) signature so re-attempted blocked applies
 * emit only on transitions.
 */
export function createClaudeUnifiedRuntimeConfigOutcomeEmitter(params: Readonly<{
  sendSessionEvent: (
    event: ClaudeUnifiedRuntimeConfigOutcomeSessionEvent,
  ) => Promise<Readonly<{ status: 'custodied' }>>;
}>): ClaudeUnifiedRuntimeConfigOutcomeEmitter {
  const lastEmittedChangeSignatures = new Map<string, string>();

  function changeSignature(change: RuntimeConfigChangeOutcome): string {
    return [change.status, change.timing ?? '', change.reason ?? ''].join('|');
  }

  return {
    async emit(outcome: RuntimeConfigApplyOutcome): Promise<void> {
      const transitionedChanges = outcome.changes.filter((change) => {
        const dedupKey = `${change.key}:${String(change.requested)}`;
        const signature = changeSignature(change);
        if (lastEmittedChangeSignatures.get(dedupKey) === signature) return false;
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
        await params.sendSessionEvent({
          type: 'runtime-config-outcome',
          agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
          runtime: 'claude-unified-terminal',
          status,
          ...(sharedTiming !== undefined ? { timing: sharedTiming } : {}),
          ...(sharedReason !== undefined ? { reason: sharedReason } : {}),
          message: describeGroup(status, emittedChanges),
          changes: emittedChanges,
        });
        for (const change of changes) {
          const dedupKey = `${change.key}:${String(change.requested)}`;
          lastEmittedChangeSignatures.set(dedupKey, changeSignature(change));
        }
      }
    },
    dispose(): void {
      lastEmittedChangeSignatures.clear();
    },
  };
}
