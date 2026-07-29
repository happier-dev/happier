import {
    SessionUsageLimitRecoveryV1Schema,
    type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

type UsageLimitRecoveryIdentity = Pick<
    SessionUsageLimitRecoveryV1,
    'issueFingerprint' | 'armedAtMs' | 'runtimeAuthRecoveryAttemptId'
>;

/**
 * Canonical lifecycle identity. Legacy/non-runtime records retain tuple identity,
 * while a runtime-auth-linked record can match only the exact immutable attempt.
 */
export function hasSameUsageLimitRecoveryIdentity(
    left: UsageLimitRecoveryIdentity,
    right: UsageLimitRecoveryIdentity,
): boolean {
    if (
        left.issueFingerprint !== right.issueFingerprint
        || left.armedAtMs !== right.armedAtMs
    ) return false;
    if (left.runtimeAuthRecoveryAttemptId || right.runtimeAuthRecoveryAttemptId) {
        return left.runtimeAuthRecoveryAttemptId === right.runtimeAuthRecoveryAttemptId;
    }
    return true;
}

export function mergeUsageLimitRecoveryIntent(
    current: unknown,
    candidate: unknown,
): SessionUsageLimitRecoveryV1 | null {
    const parsedCurrent = SessionUsageLimitRecoveryV1Schema.safeParse(current);
    const parsedCandidate = SessionUsageLimitRecoveryV1Schema.safeParse(candidate);
    if (!parsedCurrent.success) return parsedCandidate.success ? parsedCandidate.data : null;
    if (!parsedCandidate.success) return parsedCurrent.data;

    const left = parsedCurrent.data;
    const right = parsedCandidate.data;
    if (!hasSameUsageLimitRecoveryIdentity(left, right)) {
        return right.armedAtMs > left.armedAtMs ? right : left;
    }
    const selected = compareUsageLimitRecoveryIntents(left, right) >= 0 ? left : right;
    return {
        ...selected,
        attemptCount: Math.max(left.attemptCount, right.attemptCount),
        maxAttempts: mergeUsageLimitRecoveryMaxAttempts(left.maxAttempts, right.maxAttempts),
    };
}

/**
 * Arrival-time merge for an already allocated recovery lifecycle. A distinct
 * lifecycle may replace durable current state only when its creation epoch is
 * strictly newer; equal epochs are ambiguous and retain current fail-closed.
 */
export function mergeUsageLimitRecoverySchedule(
    current: SessionUsageLimitRecoveryV1 | null,
    incoming: SessionUsageLimitRecoveryV1,
): SessionUsageLimitRecoveryV1 {
    if (!current) return incoming;
    return mergeUsageLimitRecoveryIntent(current, incoming) ?? current;
}

export function mergeUsageLimitRecoveryMaxAttempts(left: number, right: number): number {
    if (left <= 0) return right;
    if (right <= 0) return left;
    return Math.min(left, right);
}

export function mergeUsageLimitRecoveryRearm(
    previous: SessionUsageLimitRecoveryV1 | null,
    next: SessionUsageLimitRecoveryV1,
): SessionUsageLimitRecoveryV1 {
    if (!previous) return next;
    if (previous.issueFingerprint !== next.issueFingerprint) {
        return { ...next, armedAtMs: Math.max(next.armedAtMs, previous.armedAtMs + 1) };
    }
    if (previous.status === 'paused') {
        return {
            ...next,
            armedAtMs: Math.max(next.armedAtMs, previous.armedAtMs + 1),
            maxAttempts: mergeUsageLimitRecoveryMaxAttempts(previous.maxAttempts, next.maxAttempts),
        };
    }
    if (previous.status === 'cancelled' || previous.status === 'exhausted') return previous;
    const nextCheckAtMs = previous.nextCheckAtMs === null
        ? next.nextCheckAtMs
        : next.nextCheckAtMs === null
            ? previous.nextCheckAtMs
            : Math.min(previous.nextCheckAtMs, next.nextCheckAtMs);
    return {
        ...next,
        status: previous.status,
        armedAtMs: previous.armedAtMs,
        attemptCount: previous.attemptCount,
        nextCheckAtMs,
        lastProbeError: previous.lastProbeError,
        maxAttempts: mergeUsageLimitRecoveryMaxAttempts(previous.maxAttempts, next.maxAttempts),
    };
}

export function mergeUsageLimitRecoveryExplicitRearm(
    previous: SessionUsageLimitRecoveryV1 | null,
    next: SessionUsageLimitRecoveryV1,
): SessionUsageLimitRecoveryV1 {
    if (previous?.status !== 'cancelled') return mergeUsageLimitRecoveryRearm(previous, next);
    return {
        ...next,
        armedAtMs: Math.max(next.armedAtMs, previous.armedAtMs + 1),
        maxAttempts: mergeUsageLimitRecoveryMaxAttempts(previous.maxAttempts, next.maxAttempts),
    };
}

const terminalStatuses = new Set<SessionUsageLimitRecoveryV1['status']>(['paused', 'exhausted', 'cancelled']);
const statusTieRank: Record<SessionUsageLimitRecoveryV1['status'], number> = {
    armed: 0,
    checking: 1,
    waiting: 2,
    paused: 3,
    exhausted: 4,
    cancelled: 5,
};

function compareText(left: string, right: string): number {
    return left === right ? 0 : left < right ? -1 : 1;
}

function stringifyIntentContentForTie(intent: SessionUsageLimitRecoveryV1): string {
    return JSON.stringify({
        ...intent,
        attemptCount: 0,
        maxAttempts: 0,
    });
}

function compareUsageLimitRecoveryIntents(
    left: SessionUsageLimitRecoveryV1,
    right: SessionUsageLimitRecoveryV1,
): number {
    if (left.issueFingerprint !== right.issueFingerprint) {
        if (left.armedAtMs !== right.armedAtMs) return left.armedAtMs - right.armedAtMs;
        return compareText(left.issueFingerprint, right.issueFingerprint);
    }
    if (left.armedAtMs !== right.armedAtMs) return left.armedAtMs - right.armedAtMs;
    const leftTerminal = terminalStatuses.has(left.status);
    const rightTerminal = terminalStatuses.has(right.status);
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    if (!leftTerminal && left.attemptCount !== right.attemptCount) {
        return left.attemptCount - right.attemptCount;
    }
    if (statusTieRank[left.status] !== statusTieRank[right.status]) {
        return statusTieRank[left.status] - statusTieRank[right.status];
    }
    if (left.attemptCount !== right.attemptCount) return left.attemptCount - right.attemptCount;
    const leftNextCheck = left.nextCheckAtMs ?? -1;
    const rightNextCheck = right.nextCheckAtMs ?? -1;
    if (leftNextCheck !== rightNextCheck) return leftNextCheck - rightNextCheck;
    return compareText(stringifyIntentContentForTie(left), stringifyIntentContentForTie(right));
}
