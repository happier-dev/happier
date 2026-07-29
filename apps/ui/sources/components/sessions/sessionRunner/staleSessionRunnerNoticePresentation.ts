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
    | 'session.staleRunner.actions.restart'
    | 'session.staleRunner.actions.restarting'
    | 'session.staleRunner.actions.hideBanner'
    | 'session.staleRunner.actions.showBanner'
    | 'session.staleRunner.status.stale'
    | 'session.staleRunner.status.restarting'
    | 'session.staleRunner.status.busy'
    | 'session.staleRunner.status.failed';

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
        state.plannedRestart.eligible ? 'eligible' : state.plannedRestart.disabledReason ?? 'ineligible',
    ].join(':');
}

function isActionableStaleRuntimeState(state: SessionRunnerRuntimeStateV1): boolean {
    return state.versionState === 'stale'
        && state.plannedRestart.supported === true
        && state.plannedRestart.eligible === true;
}

function resolveBodyKey(status: StaleSessionRunnerOperationStatus | null): StaleSessionRunnerTranslationKey {
    if (status?.kind === 'pending') return 'session.staleRunner.banner.pendingBody';
    if (status?.kind === 'result') {
        if (status.result.status === 'busy') return 'session.staleRunner.banner.busyBody';
        if (status.result.ok === false) return 'session.staleRunner.banner.failedBody';
    }
    return 'session.staleRunner.banner.body';
}

function resolveBadgeLabelKey(status: StaleSessionRunnerOperationStatus | null): StaleSessionRunnerTranslationKey {
    if (status?.kind === 'pending') return 'session.staleRunner.status.restarting';
    if (status?.kind === 'result') {
        if (status.result.status === 'busy') return 'session.staleRunner.status.busy';
        if (status.result.ok === false) return 'session.staleRunner.status.failed';
    }
    return 'session.staleRunner.status.stale';
}

export function buildStaleSessionRunnerNoticePresentation(input: Readonly<{
    runtimeState: SessionRunnerRuntimeStateV1;
    operationStatus: StaleSessionRunnerOperationStatus | null;
    translate: StaleSessionRunnerTranslate;
}>): StaleSessionRunnerNoticePresentation | null {
    if (!isActionableStaleRuntimeState(input.runtimeState)) return null;

    const pending = input.operationStatus?.kind === 'pending';
    const labelKey = resolveBadgeLabelKey(input.operationStatus);
    return {
        fingerprint: buildStaleSessionRunnerFingerprint(input.runtimeState),
        banner: {
            testID: 'session-staleRunner-version',
            actionTestID: 'session-staleRunner-restart',
            title: input.translate('session.staleRunner.banner.title'),
            body: input.translate(resolveBodyKey(input.operationStatus)),
            actionLabel: pending
                ? input.translate('session.staleRunner.actions.restarting')
                : input.translate('session.staleRunner.actions.restart'),
            actionAccessibilityLabel: pending
                ? input.translate('session.staleRunner.actions.restarting')
                : input.translate('session.staleRunner.actions.restart'),
            disabled: pending,
        },
        statusBadge: {
            key: STALE_SESSION_RUNNER_STATUS_BADGE_KEY,
            label: input.translate(labelKey),
            testID: 'session-staleRunner-status-badge',
            accessibilityLabel: input.translate('session.staleRunner.status.stale'),
            tone: 'warning',
            emphasis: 'prominent',
        },
    };
}
