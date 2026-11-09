import { isTerminalProviderOutcomeProof } from '../recovery/providerOutcomeProof';
import {
    readRuntimeAuthRecoverySwitchResult,
    resolveRuntimeAuthRecoveryProof,
    isLocallyCompleteWithoutProof,
    isProvenRuntimeAuthRecoverySuccess,
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
export const DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS = 600_000;
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
    | Readonly<{ kind: 'provider_outcome_proven' }>
    | Readonly<{ kind: 'local_completion'; targetChanged: boolean }>
    | Readonly<{ kind: 'temporary_retry_handoff'; status: 'temporary_retry_armed' | 'temporary_retry_unavailable'; ready: boolean }>
    | Readonly<{
        kind: 'durable_wait';
        nextRetryAtMs: number;
        reason: 'no_eligible_member' | 'quota_proof_unavailable' | 'awaiting_limit_reset';
    }>
    | Readonly<{ kind: 'terminal'; reason: string }>;

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
    return resolveEarliestFutureWaitCandidateMs([input.classificationResetsAtMs], input.nowMs)
        ?? (actionReason === 'usage_limit' ? input.nowMs + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS : null);
}

/** Canonical wait/terminal decision shared by retry, intake, and projection. */
export function resolveRuntimeAuthRecoveryResultDisposition(input: Readonly<{
    result: unknown;
    classificationResetsAtMs: number | null;
    classificationProfileId?: string | null;
    classificationFailureKind?: string | null;
    additionalWaitCandidatesMs?: ReadonlyArray<number | null>;
    unknownNoEligibleMemberBackoffMs?: number | null;
    nowMs: number;
}>): RuntimeAuthRecoveryResultDisposition | null {
    const switchResult = readRuntimeAuthRecoverySwitchResult(input.result);
    if (!switchResult) return null;
    const additionalCandidates = input.additionalWaitCandidatesMs ?? [];
    const unknownQuotaRetryAtMs = input.nowMs + Math.max(
        GROUP_EXHAUSTED_WAIT_FLOOR_MS,
        readNonNegativeNumber(input.unknownNoEligibleMemberBackoffMs) ?? 0,
    );
    if (isProvenRuntimeAuthRecoverySuccess(input.result)) return { kind: 'provider_outcome_proven' };
    const outer = isRecord(input.result) ? input.result : null;
    if (outer?.status === 'temporary_retry_armed' || outer?.status === 'temporary_retry_unavailable') {
        return { kind: 'temporary_retry_handoff', status: outer.status, ready: isLocallyCompleteWithoutProof(input.result) };
    }

    // An entitlement refusal has no reset to wait for: when no member can serve
    // the requested model, the typed refusal surfaces instead of a durable wait.
    const currentMemberHasIndependentWait = readString(switchResult.activeProfileId) !== null
        && readString(switchResult.activeProfileId) !== readString(input.classificationProfileId)
        && Array.isArray(switchResult.excluded)
        && switchResult.excluded.some(entry => isRecord(entry)
            && entry.profileId === switchResult.activeProfileId
            && entry.reason !== 'plan_unavailable'
            && resolveEarliestFutureWaitCandidateMs([readNonNegativeNumber(entry.retryAtMs)], input.nowMs) !== null);
    if (switchResult.status === 'no_eligible_member' && input.classificationFailureKind === 'plan'
        && !currentMemberHasIndependentWait) {
        return { kind: 'terminal', reason: 'no_eligible_member' };
    }
    if (switchResult.status === 'quota_proof_unavailable') {
        return { kind: 'durable_wait', reason: 'quota_proof_unavailable', nextRetryAtMs: resolveEarliestFutureWaitCandidateMs([readNonNegativeNumber(switchResult.retryAtMs)], input.nowMs)
            ?? unknownQuotaRetryAtMs };
    }
    if (switchResult.status === 'no_eligible_member' && switchResult.groupExhausted === true) {
        const transientAlternative = Array.isArray(switchResult.excluded)
            && switchResult.excluded.some((entry) => isRecord(entry) && entry.reason === 'credential_unavailable');
        const switchEvidenceCandidate = resolveEarliestFutureWaitCandidateMs([
            readNonNegativeNumber(switchResult.retryAtMs),
            readNonNegativeNumber(switchResult.resetsAtMs),
            ...readExcludedMemberRetryAtMsCandidates(switchResult),
            // Retryable alternatives use the scheduler's bounded backoff, not the exhausted
            // account's weekly reset or a second retry owner.
            transientAlternative ? unknownQuotaRetryAtMs : null,
        ], input.nowMs);
        const classificationResetApplies = !('activeProfileId' in switchResult)
            || (readString(switchResult.activeProfileId) !== null
                && readString(switchResult.activeProfileId) === readString(input.classificationProfileId));
        const fallbackCandidate = resolveEarliestFutureWaitCandidateMs([
            // A current-member observation cannot borrow another member's reset or prior wait.
            ...(classificationResetApplies ? [input.classificationResetsAtMs, ...additionalCandidates] : []),
        ], input.nowMs);
        return {
            kind: 'durable_wait',
            reason: 'no_eligible_member',
            nextRetryAtMs: switchEvidenceCandidate ?? fallbackCandidate ?? unknownQuotaRetryAtMs,
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
        const nextRetryAtMs = resetAtMs ?? (input.classificationFailureKind === 'usage_limit'
            ? input.nowMs + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS : null);
        if (nextRetryAtMs !== null) {
            return {
                kind: 'durable_wait',
                reason: 'awaiting_limit_reset',
                nextRetryAtMs,
            };
        }
    }
    const proof = resolveRuntimeAuthRecoveryProof(input.result);
    if (isTerminalProviderOutcomeProof(proof)) return { kind: 'terminal', reason: proof };
    if (isLocallyCompleteWithoutProof(input.result)) return { kind: 'local_completion', targetChanged: outer?.status === 'switch_attempted' };
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
