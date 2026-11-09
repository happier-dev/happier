import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { AgentEvent } from "@happier-dev/session-core/raw";

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

export function resolveSessionIntentionalRestartState(input: Readonly<{
    signals: ReadonlyArray<SessionIntentionalRestartSignal | null | undefined>;
    recoveryEvidenceAtMs?: number | null;
}>): SessionIntentionalRestartState {
    let latest: SessionIntentionalRestartState = null;
    for (const signal of input.signals) {
        if (signal && (!latest || signal.startedAtMs >= latest.startedAtMs)) latest = signal;
    }
    const recoveredAtMs = readFiniteTimestamp(input.recoveryEvidenceAtMs);
    return latest && recoveredAtMs !== null && recoveredAtMs > latest.startedAtMs ? null : latest;
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
    if (event.type === 'connected-service-account-switch-attempt') {
        if (event.attemptedContinuityMode !== 'restart' && event.action !== 'restart_requested') return null;
        if (event.outcome !== 'failed' && event.outcome !== 'terminal') return null;
        return {
            status: 'failed',
            attemptId: `connected-service-account-switch-attempt:${Math.trunc(sourceEvent.createdAtMs)}`,
            reason: 'runtime_auth_recovery',
            startedAtMs: sourceEvent.createdAtMs,
        };
    }
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
}>): ReadonlyArray<SessionIntentionalRestartSignal> {
    const signals: SessionIntentionalRestartSignal[] = [];
    const runtimeIssueSignal = deriveRuntimeIssueRestartSignal(input.runtimeIssue);
    if (runtimeIssueSignal) signals.push(runtimeIssueSignal);
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const signal = deriveConnectedServiceEventRestartSignal(input.events[index]);
        if (signal) {
            signals.push(signal);
            break;
        }
    }
    return signals;
}
