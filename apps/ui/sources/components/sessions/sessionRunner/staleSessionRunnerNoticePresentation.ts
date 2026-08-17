import type {
    RestartSessionRunnerResultV1,
    SessionRunnerRuntimeStateV1,
} from '@happier-dev/protocol';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';

export const STALE_SESSION_RUNNER_STATUS_BADGE_KEY = 'stale-session-runner';

export type StaleSessionRunnerTranslationKey =
    | 'session.staleRunner.banner.title'
    | 'session.staleRunner.banner.body'
    | 'session.staleRunner.banner.pendingBody'
    | 'session.staleRunner.banner.busyBody'
    | 'session.staleRunner.banner.failedBody'
    | 'session.staleRunner.banner.unavailableBody'
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

function resolveBodyKey(
    state: SessionRunnerRuntimeStateV1,
    status: StaleSessionRunnerOperationStatus | null,
): StaleSessionRunnerTranslationKey {
    if (status?.kind === 'pending') return 'session.staleRunner.banner.pendingBody';
    if (status?.kind === 'result') {
        if (status.result.status === 'busy') return 'session.staleRunner.banner.busyBody';
        if (status.result.ok === false) return 'session.staleRunner.banner.failedBody';
    }
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
    const restartAvailable = isRestartAvailable(input.runtimeState);
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
