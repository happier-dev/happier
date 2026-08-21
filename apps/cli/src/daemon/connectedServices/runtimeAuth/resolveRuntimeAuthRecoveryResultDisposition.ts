import { isTerminalProviderOutcomeProof } from '../recovery/providerOutcomeProof';
import {
  readRuntimeAuthRecoverySwitchResult,
  resolveRuntimeAuthRecoveryProof,
} from './resolveRuntimeAuthRecoveryOutcome';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

const GROUP_EXHAUSTED_WAIT_FLOOR_MS = 30_000;
const SWITCH_LIMIT_WAIT_FLOOR_MS = 5 * 60_000;

const WAITABLE_ACTION_REQUIRED_KINDS: ReadonlySet<string> = new Set([
  'profile_action_required',
  'connected_service_required',
]);
const WAITABLE_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'usage_limit',
  'rate_limit',
  'temporary_throttle',
]);

export type RuntimeAuthRecoveryResultDisposition =
  | Readonly<{
      kind: 'durable_wait';
      nextRetryAtMs: number;
      reason: 'no_eligible_member' | 'switch_limit_reached' | 'awaiting_limit_reset';
    }>
  | Readonly<{
      kind: 'terminal';
      reason: string;
    }>;

function resolveEarliestFutureWaitCandidateMs(
  candidates: ReadonlyArray<number | null>,
  nowMs: number,
): number | null {
  const future = candidates.filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > nowMs
  ));
  return future.length === 0 ? null : Math.min(...future);
}

function readExcludedMemberRetryAtMsCandidates(
  switchResult: Readonly<Record<string, unknown>>,
): ReadonlyArray<number | null> {
  if (!Array.isArray(switchResult.excluded)) return [];
  return switchResult.excluded.map((entry) => (
    isRecord(entry) ? readNonNegativeNumber(entry.retryAtMs) : null
  ));
}

function resolveActionRequiredWaitCandidateMs(input: Readonly<{
  switchResult: Readonly<Record<string, unknown>>;
  classificationResetsAtMs: number | null;
  nowMs: number;
}>): number | null {
  if (input.switchResult.status !== 'recovery_action_required') return null;
  const action = isRecord(input.switchResult.action) ? input.switchResult.action : null;
  const actionKind = readString(action?.kind);
  const actionReason = readString(action?.reason);
  if (!actionKind || !WAITABLE_ACTION_REQUIRED_KINDS.has(actionKind)) return null;
  if (!actionReason || !WAITABLE_FAILURE_REASONS.has(actionReason)) return null;
  return resolveEarliestFutureWaitCandidateMs([input.classificationResetsAtMs], input.nowMs);
}

/**
 * Canonical disposition for a completed runtime-auth recovery result. It owns
 * the distinction between a durable wait and a terminal policy outcome so the
 * scheduler, in-band intake path, and session metadata cannot disagree.
 */
export function resolveRuntimeAuthRecoveryResultDisposition(input: Readonly<{
  result: unknown;
  classificationResetsAtMs: number | null;
  classificationFailureKind?: string | null;
  additionalWaitCandidatesMs?: ReadonlyArray<number | null>;
  unknownNoEligibleMemberBackoffMs?: number | null;
  nowMs: number;
}>): RuntimeAuthRecoveryResultDisposition | null {
  const switchResult = readRuntimeAuthRecoverySwitchResult(input.result);
  if (!switchResult) return null;
  const additionalCandidates = input.additionalWaitCandidatesMs ?? [];

  if (switchResult.status === 'no_eligible_member' && switchResult.groupExhausted === true) {
    const switchEvidenceCandidate = resolveEarliestFutureWaitCandidateMs([
      readNonNegativeNumber(switchResult.retryAtMs),
      readNonNegativeNumber(switchResult.resetsAtMs),
      ...readExcludedMemberRetryAtMsCandidates(switchResult),
    ], input.nowMs);
    const fallbackCandidate = resolveEarliestFutureWaitCandidateMs([
      input.classificationResetsAtMs,
      ...additionalCandidates,
    ], input.nowMs);
    return {
      kind: 'durable_wait',
      reason: 'no_eligible_member',
      nextRetryAtMs: switchEvidenceCandidate ?? fallbackCandidate ?? input.nowMs + Math.max(
        GROUP_EXHAUSTED_WAIT_FLOOR_MS,
        readNonNegativeNumber(input.unknownNoEligibleMemberBackoffMs) ?? 0,
      ),
    };
  }

  if (switchResult.status === 'switch_limit_reached') {
    const candidate = resolveEarliestFutureWaitCandidateMs([
      input.classificationResetsAtMs,
      ...additionalCandidates,
    ], input.nowMs);
    return {
      kind: 'durable_wait',
      reason: 'switch_limit_reached',
      nextRetryAtMs: candidate ?? input.nowMs + SWITCH_LIMIT_WAIT_FLOOR_MS,
    };
  }

  const actionRequiredCandidate = resolveActionRequiredWaitCandidateMs({
    switchResult,
    classificationResetsAtMs: input.classificationResetsAtMs,
    nowMs: input.nowMs,
  });
  if (actionRequiredCandidate !== null) {
    return {
      kind: 'durable_wait',
      reason: 'awaiting_limit_reset',
      nextRetryAtMs: actionRequiredCandidate,
    };
  }
  if (
    switchResult.status === 'not_group_selection'
    && input.classificationFailureKind
    && WAITABLE_FAILURE_REASONS.has(input.classificationFailureKind)
  ) {
    const resetAtMs = resolveEarliestFutureWaitCandidateMs([
      input.classificationResetsAtMs,
    ], input.nowMs);
    if (resetAtMs !== null) {
      return {
        kind: 'durable_wait',
        reason: 'awaiting_limit_reset',
        nextRetryAtMs: resetAtMs,
      };
    }
  }

  const proof = resolveRuntimeAuthRecoveryProof(input.result);
  if (isTerminalProviderOutcomeProof(proof)) {
    return { kind: 'terminal', reason: proof };
  }

  const status = readString(switchResult.status);
  if (
    status === 'auto_switch_disabled'
    || status === 'switch_reason_disabled'
    || status === 'manual_strategy'
    || status === 'recovery_action_required'
    || (status === 'no_eligible_member' && switchResult.groupExhausted !== true)
  ) {
    return { kind: 'terminal', reason: status };
  }
  return null;
}
