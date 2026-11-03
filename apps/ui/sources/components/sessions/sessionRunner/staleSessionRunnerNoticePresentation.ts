import type {
    RestartSessionRunnerResultV1} from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import type {
    SessionRunnerRuntimeStateV1,
} from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';

export const STALE_SESSION_RUNNER_STATUS_BADGE_KEY = 'stale-session-runner';

export type StaleSessionRunnerTranslationKey =
    | 'session.staleRunner.banner.title'
    | 'session.staleRunner.banner.body'
    | 'session.staleRunner.banner.pendingBody'
    | 'session.staleRunner.banner.busyBody'
    | 'session.staleRunner.banner.failedBody'
    | 'session.staleRunner.banner.unavailableBody'
    | 'session.staleRunner.banner.stopAndResumeBody'
    | 'session.staleRunner.banner.runnerUnavailableBody'
    | 'session.staleRunner.banner.updateDaemonBody'
    | 'session.staleRunner.banner.statusFailedBody'
    | 'session.staleRunner.actions.restart'
    | 'session.staleRunner.actions.restarting'
    | 'session.staleRunner.actions.hideBanner'
    | 'session.staleRunner.actions.showBanner'
    | 'session.staleRunner.status.stale'
    | 'session.staleRunner.status.restarting'
    | 'session.staleRunner.status.busy'
    | 'session.staleRunner.status.failed'
    | 'common.unavailable';

export type StaleSessionRunnerTranslate = (key: StaleSessionRunnerTranslationKey) => string;

export type StaleSessionRunnerOperationStatus =
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'result'; result: RestartSessionRunnerResultV1 }>;

export type StaleSessionRunnerNoticePresentation = Readonly<{
    fingerprint: string;
    banner: Readonly<{
        testID: string;
        actionTestID: string;
        title: string;
        body: string;
        actionLabel: string;
        actionAccessibilityLabel: string;
        actionBusy: boolean;
        disabled: boolean;
    }>;
    statusBadge: AgentInputStatusBadge;
}>;

function readIdentityPart(value: unknown): string {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'unknown';
}

export function buildStaleSessionRunnerFingerprint(state: SessionRunnerRuntimeStateV1): string {
    return [
        'session-runner',
        state.sessionId,
        state.runner.pid ?? 'unknown',
        readIdentityPart(state.runner.processCommandHash),
        readIdentityPart(state.runner.runtimeId ?? state.runner.entrypointVersion),
        readIdentityPart(state.daemon.currentEntrypointVersion),
    ].join(':');
}

function isRestartAvailable(state: SessionRunnerRuntimeStateV1): boolean {
    return state.plannedRestart.supported === true
        && state.plannedRestart.eligible === true
        && !state.plannedRestart.disabledReason;
}

function isRestartBusy(state: SessionRunnerRuntimeStateV1): boolean {
    return state.plannedRestart.disabledReason === 'turn_in_progress'
        || state.plannedRestart.disabledReason === 'approval_pending'
        || state.plannedRestart.disabledReason === 'restart_already_running';
}

function isStopAndResumeResult(result: RestartSessionRunnerResultV1): boolean {
    return result.status === 'restart_admission_unsupported' || result.reasonCode === 'restart_admission_unsupported';
}

function requiresStopAndResume(state: SessionRunnerRuntimeStateV1, status: StaleSessionRunnerOperationStatus | null): boolean {
    return state.plannedRestart.disabledReason === 'restart_admission_unsupported'
        || (status?.kind === 'result' && isStopAndResumeResult(status.result));
}

/** What a refused or failed restart says, for the banner and for any alert that reports the same result. */
export function readRestartResultBodyKey(result: RestartSessionRunnerResultV1): StaleSessionRunnerTranslationKey | null {
    if (isStopAndResumeResult(result)) return 'session.staleRunner.banner.stopAndResumeBody';
    if (result.status === 'busy') return 'session.staleRunner.banner.busyBody';
    if (result.status === 'runner_not_active' || result.status === 'not_found' || result.status === 'not_tracked') {
        return 'session.staleRunner.banner.runnerUnavailableBody';
    }
    if (result.status === 'unsupported_daemon') return 'session.staleRunner.banner.updateDaemonBody';
    if (result.status === 'partial_failure') return 'session.staleRunner.banner.statusFailedBody';
    if (result.ok === false) return 'session.staleRunner.banner.failedBody';
    return null;
}

function resolveBodyKey(
    state: SessionRunnerRuntimeStateV1,
    status: StaleSessionRunnerOperationStatus | null,
): StaleSessionRunnerTranslationKey {
    if (status?.kind === 'pending') return 'session.staleRunner.banner.pendingBody';
    if (requiresStopAndResume(state, status)) return 'session.staleRunner.banner.stopAndResumeBody';
    const resultBodyKey = status?.kind === 'result' ? readRestartResultBodyKey(status.result) : null;
    if (resultBodyKey) return resultBodyKey;
    if (isRestartBusy(state)) return 'session.staleRunner.banner.busyBody';
    if (!isRestartAvailable(state)) return 'session.staleRunner.banner.unavailableBody';
    return 'session.staleRunner.banner.body';
}

function resolveBadgeLabelKey(
    state: SessionRunnerRuntimeStateV1,
    status: StaleSessionRunnerOperationStatus | null,
): StaleSessionRunnerTranslationKey {
    if (status?.kind === 'pending') return 'session.staleRunner.status.restarting';
    if (status?.kind === 'result') {
        if (status.result.status === 'busy') return 'session.staleRunner.status.busy';
        if (status.result.ok === false) return 'session.staleRunner.status.failed';
    }
    if (isRestartBusy(state)) return 'session.staleRunner.status.busy';
    return 'session.staleRunner.status.stale';
}

export function buildStaleSessionRunnerNoticePresentation(input: Readonly<{
    runtimeState: SessionRunnerRuntimeStateV1;
    operationStatus: StaleSessionRunnerOperationStatus | null;
    translate: StaleSessionRunnerTranslate;
}>): StaleSessionRunnerNoticePresentation | null {
    if (input.runtimeState.versionState !== 'stale') return null;

    const pending = input.operationStatus?.kind === 'pending';
    const restartAvailable = isRestartAvailable(input.runtimeState)
        && !requiresStopAndResume(input.runtimeState, input.operationStatus);
    const restartBusy = isRestartBusy(input.runtimeState);
    const labelKey = resolveBadgeLabelKey(input.runtimeState, input.operationStatus);
    const actionLabelKey = pending
        ? 'session.staleRunner.actions.restarting'
        : restartAvailable || restartBusy
            ? 'session.staleRunner.actions.restart'
            : 'common.unavailable';
    return {
        fingerprint: buildStaleSessionRunnerFingerprint(input.runtimeState),
        banner: {
            testID: 'session-staleRunner-version',
            actionTestID: 'session-staleRunner-restart',
            title: input.translate('session.staleRunner.banner.title'),
            body: input.translate(resolveBodyKey(input.runtimeState, input.operationStatus)),
            actionLabel: input.translate(actionLabelKey),
            actionAccessibilityLabel: input.translate(actionLabelKey),
            actionBusy: pending,
            disabled: pending || !restartAvailable,
        },
        statusBadge: {
            key: STALE_SESSION_RUNNER_STATUS_BADGE_KEY,
            label: input.translate(labelKey),
            testID: 'session-staleRunner-status-badge',
            accessibilityLabel: input.translate(labelKey),
            tone: 'warning',
            emphasis: 'prominent',
        },
    };
}
