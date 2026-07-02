import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import type { AgentEvent } from '@/sync/typesRaw';

export const SESSION_INTENTIONAL_RESTART_FAILSAFE_MS = 30_000;

export type SessionIntentionalRestartReason =
    | 'manual_auth_switch'
    | 'runtime_auth_recovery'
    | 'refresh_auth_update'
    | 'usage_limit_account_switch';

export type SessionIntentionalRestartSignal = Readonly<{
    status: 'restarting' | 'pending_confirmation' | 'failed';
    attemptId: string;
    reason: SessionIntentionalRestartReason;
    startedAtMs: number;
}>;

export type SessionIntentionalRestartState = SessionIntentionalRestartSignal | null;

function readFiniteTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

export function resolveSessionIntentionalRestartRecoveryEvidenceAtMs(input: Readonly<{
    activeAt?: number | null;
    latestReadyEventAt?: number | null;
    latestTurnStatus?: string | null;
    latestTurnStatusObservedAt?: number | null;
    meaningfulActivityAt?: number | null;
}>): number | null {
    const candidates = [
        input.activeAt,
        input.latestReadyEventAt,
        input.latestTurnStatus === 'completed' ? input.latestTurnStatusObservedAt : null,
    ];
    let latest: number | null = null;
    for (const candidate of candidates) {
        const timestamp = readFiniteTimestamp(candidate);
        if (timestamp === null) continue;
        latest = latest === null ? timestamp : Math.max(latest, timestamp);
    }
    return latest;
}

export function createManualAuthSwitchRestartSignal(input: Readonly<{
    attemptId: number;
    startedAtMs: number;
}>): SessionIntentionalRestartSignal {
    return {
        status: 'restarting',
        attemptId: `manual-auth-switch:${input.attemptId}`,
        reason: 'manual_auth_switch',
        startedAtMs: input.startedAtMs,
    };
}

function applyRestartFailsafe(input: Readonly<{
    signal: SessionIntentionalRestartSignal;
    nowMs: number;
    failsafeMs: number;
}>): SessionIntentionalRestartSignal {
    if (
        input.signal.status !== 'restarting'
        || input.nowMs - input.signal.startedAtMs < input.failsafeMs
    ) {
        return input.signal;
    }
    return {
        ...input.signal,
        status: 'pending_confirmation',
    };
}

export function resolveSessionIntentionalRestartState(input: Readonly<{
    signals: ReadonlyArray<SessionIntentionalRestartSignal | null | undefined>;
    nowMs: number;
    failsafeMs?: number;
}>): SessionIntentionalRestartState {
    const failsafeMs = input.failsafeMs ?? SESSION_INTENTIONAL_RESTART_FAILSAFE_MS;
    const signal = input.signals.find((candidate): candidate is SessionIntentionalRestartSignal => Boolean(candidate));
    if (!signal) return null;
    return applyRestartFailsafe({
        signal,
        nowMs: input.nowMs,
        failsafeMs,
    });
}

export type SessionIntentionalRestartSourceEvent = Readonly<{
    event: AgentEvent;
    createdAtMs: number;
}>;

function mapConnectedServiceAccountSwitchReason(
    reason: Extract<AgentEvent, { type: 'connected-service-account-switch' }>['reason'],
): SessionIntentionalRestartReason {
    if (reason === 'refresh_failure') return 'refresh_auth_update';
    if (reason === 'auth_expired' || reason === 'account_changed') return 'runtime_auth_recovery';
    if (reason === 'manual') return 'manual_auth_switch';
    return 'usage_limit_account_switch';
}

function deriveRuntimeIssueRestartSignal(
    runtimeIssue: SessionRuntimeIssueV1 | null | undefined,
): SessionIntentionalRestartSignal | null {
    if (runtimeIssue?.source !== 'usage_limit') return null;
    if (runtimeIssue.usageLimit?.recoveryDecision !== 'switching') return null;
    return {
        status: 'restarting',
        attemptId: `usage-limit-account-switch:${Math.trunc(runtimeIssue.occurredAt)}`,
        reason: 'usage_limit_account_switch',
        startedAtMs: runtimeIssue.occurredAt,
    };
}

function deriveConnectedServiceEventRestartSignal(
    sourceEvent: SessionIntentionalRestartSourceEvent,
): SessionIntentionalRestartSignal | null {
    const event = sourceEvent.event;
    if (event.type !== 'connected-service-account-switch') return null;
    if (event.mode !== 'restart_resume') return null;
    return {
        status: 'restarting',
        attemptId: `connected-service-account-switch:${event.reason}:${Math.trunc(sourceEvent.createdAtMs)}`,
        reason: mapConnectedServiceAccountSwitchReason(event.reason),
        startedAtMs: sourceEvent.createdAtMs,
    };
}

export function deriveSessionIntentionalRestartSignals(input: Readonly<{
    runtimeIssue: SessionRuntimeIssueV1 | null | undefined;
    events: ReadonlyArray<SessionIntentionalRestartSourceEvent>;
    recoveryEvidenceAtMs?: number | null;
}>): ReadonlyArray<SessionIntentionalRestartSignal> {
    const recoveryEvidenceAtMs = typeof input.recoveryEvidenceAtMs === 'number' && Number.isFinite(input.recoveryEvidenceAtMs)
        ? input.recoveryEvidenceAtMs
        : null;
    const isSuperseded = (signal: SessionIntentionalRestartSignal): boolean => (
        recoveryEvidenceAtMs !== null && recoveryEvidenceAtMs > signal.startedAtMs
    );
    const signals: SessionIntentionalRestartSignal[] = [];
    const runtimeIssueSignal = deriveRuntimeIssueRestartSignal(input.runtimeIssue);
    if (runtimeIssueSignal && !isSuperseded(runtimeIssueSignal)) {
        signals.push(runtimeIssueSignal);
    }
    const latestEvent = input.events[input.events.length - 1];
    if (latestEvent) {
        const signal = deriveConnectedServiceEventRestartSignal(latestEvent);
        if (signal && !isSuperseded(signal)) signals.push(signal);
    }
    return signals;
}
