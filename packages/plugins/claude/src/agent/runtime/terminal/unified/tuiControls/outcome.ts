import type {
  RuntimeConfigOutcomeChangeKeyV1,
  RuntimeConfigOutcomeStatusV1,
  RuntimeConfigOutcomeTimingV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';

import type {
  RuntimeConfigApplyOutcome,
  RuntimeConfigChangeOutcome,
  RuntimeConfigOutcomeScalar,
} from './types.js';

/**
 * Low-level result of attempting a single control. These are NOT the five public statuses; the
 * mapping to {@link RuntimeConfigOutcomeStatusV1} lives in {@link controlResultToChangeOutcome} so no
 * call site can mint a status outside the frozen contract.
 */
export type ControlScheduleTiming =
  | 'scheduled_for_next_prompt'
  | 'queued_until_safe_window'
  | 'next_idle'
  | 'before_next_prompt';

export type ControlAttemptResult =
  | Readonly<{
      kind: 'applied';
      effective?: RuntimeConfigOutcomeScalar | undefined;
      timing?: RuntimeConfigOutcomeTimingV1 | undefined;
      /** Detail such as `delivered_unverified`: delivered but not yet confirmed on-screen. */
      reason?: string | undefined;
    }>
  | Readonly<{ kind: 'already_effective'; effective?: RuntimeConfigOutcomeScalar | undefined }>
  | Readonly<{ kind: 'scheduled'; timing: ControlScheduleTiming; reason?: string | undefined }>
  | Readonly<{ kind: 'unreachable'; reason: string }>
  | Readonly<{ kind: 'requires_restart'; reason?: string | undefined }>
  | Readonly<{ kind: 'unsupported'; reason?: string | undefined }>
  | Readonly<{ kind: 'failed'; reason: string }>;

const PUBLIC_STATUSES: ReadonlySet<RuntimeConfigOutcomeStatusV1> = new Set([
  'applied',
  'requires_restart',
  'requires_interactive_control',
  'unsupported',
  'failed',
]);

export function isPublicRuntimeConfigStatus(value: string): value is RuntimeConfigOutcomeStatusV1 {
  return PUBLIC_STATUSES.has(value as RuntimeConfigOutcomeStatusV1);
}

export function controlResultToChangeOutcome(params: Readonly<{
  key: RuntimeConfigOutcomeChangeKeyV1;
  requested?: RuntimeConfigOutcomeScalar | undefined;
  previous?: RuntimeConfigOutcomeScalar | undefined;
  result: ControlAttemptResult;
}>): RuntimeConfigChangeOutcome {
  const { key, requested, previous, result } = params;
  const base = { key, requested, previous } as const;

  switch (result.kind) {
    case 'applied':
      return { ...base, status: 'applied', timing: result.timing ?? 'current_window', effective: result.effective, reason: result.reason };
    case 'already_effective':
      return { ...base, status: 'applied', timing: 'skipped_already_effective', effective: result.effective };
    case 'scheduled':
      return { ...base, status: 'applied', timing: result.timing, reason: result.reason };
    case 'unreachable':
      return { ...base, status: 'requires_interactive_control', reason: result.reason };
    case 'requires_restart':
      return { ...base, status: 'requires_restart', reason: result.reason };
    case 'unsupported':
      return { ...base, status: 'unsupported', reason: result.reason };
    case 'failed':
      return { ...base, status: 'failed', reason: result.reason };
  }
}

function isBlockingStatus(status: RuntimeConfigOutcomeStatusV1): boolean {
  return status === 'failed' || status === 'requires_interactive_control';
}

// Timings that mean "not yet effective" — a dependent prompt must NOT be injected under the old config.
const DEFERRED_TIMINGS: ReadonlySet<RuntimeConfigOutcomeTimingV1> = new Set([
  'scheduled_for_next_prompt',
  'queued_until_safe_window',
  'next_idle',
]);

function isDeferredTiming(timing: RuntimeConfigOutcomeTimingV1 | undefined): boolean {
  return timing !== undefined && DEFERRED_TIMINGS.has(timing);
}

function blocksPrompt(change: RuntimeConfigChangeOutcome): boolean {
  return isBlockingStatus(change.status) || isDeferredTiming(change.timing);
}

function aggregateStatus(changes: readonly RuntimeConfigChangeOutcome[]): RuntimeConfigOutcomeStatusV1 {
  if (changes.some((c) => c.status === 'failed')) return 'failed';
  if (changes.some((c) => c.status === 'requires_interactive_control')) return 'requires_interactive_control';
  if (changes.some((c) => c.status === 'requires_restart')) return 'requires_restart';
  if (changes.some((c) => c.status === 'applied')) return 'applied';
  if (changes.some((c) => c.status === 'unsupported')) return 'unsupported';
  return 'applied';
}

function aggregateTiming(changes: readonly RuntimeConfigChangeOutcome[]): RuntimeConfigOutcomeTimingV1 | undefined {
  if (changes.length === 0) return 'not_applicable';
  if (changes.length === 1) return changes[0].timing;
  const allApplied = changes.every((c) => c.status === 'applied');
  if (!allApplied) return undefined;
  const timings = new Set(changes.map((c) => c.timing));
  return timings.size === 1 ? changes[0].timing : undefined;
}

function describeOutcome(status: RuntimeConfigOutcomeStatusV1, changes: readonly RuntimeConfigChangeOutcome[]): string {
  if (changes.length === 0) return 'No runtime config changes were requested.';
  const keys = changes.map((c) => c.key).join(', ');
  switch (status) {
    case 'applied':
      return `Applied runtime config controls: ${keys}.`;
    case 'requires_restart':
      return `Some runtime config changes require a session restart: ${keys}.`;
    case 'requires_interactive_control':
      return `Some runtime config changes need interactive control: ${keys}.`;
    case 'unsupported':
      return `Some runtime config changes are unsupported for Claude Unified: ${keys}.`;
    case 'failed':
      return `Failed to apply some runtime config controls: ${keys}.`;
  }
}

export function aggregateApplyOutcome(
  changes: readonly RuntimeConfigChangeOutcome[],
): RuntimeConfigApplyOutcome {
  const status = aggregateStatus(changes);
  const timing = aggregateTiming(changes);
  const promptMayProceed = !changes.some((c) => blocksPrompt(c));
  return {
    status,
    timing,
    changes,
    promptMayProceed,
    message: describeOutcome(status, changes),
  };
}
