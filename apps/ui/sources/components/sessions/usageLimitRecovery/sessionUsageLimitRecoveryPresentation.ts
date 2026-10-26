import {
    buildUsageLimitIssueFingerprint,
    isSessionUsageLimitRecoveryForIssue,
    type ConnectedServiceQuotaRecoveryCreditsV1,
    type PrimaryTurnStatusV1,
    type SessionRuntimeIssueV1,
    type SessionUsageLimitRecoveryV1,
    type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';

import type { AgentInputStatusBadgeTone } from '@/components/sessions/agentInput/agentInputContracts';
import {
    summarizeConnectedServiceQuotaRecoveryCredits,
    type ConnectedServiceQuotaRecoveryCreditSummary,
} from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditSummary';
import { t, type TranslationParams } from '@/text';

export type UsageLimitRecoveryRememberedMode = 'ask' | 'auto_wait';
export type UsageLimitRecoveryOperationStatus = 'checking' | 'ready' | 'waiting' | 'exhausted' | 'inactive';

/** Control acknowledgements do not prove that the provider accepted another turn. */
export function resolveSessionUsageLimitRecoveryOperationStatus(
    status: SessionUsageLimitRecoveryOperationResultV1['status'] | undefined,
): UsageLimitRecoveryOperationStatus | 'cancelled' | null {
    switch (status) {
        case 'ready':
        case 'already_ready':
        case 'no_recovery_needed':
            return 'ready';
        case 'resumed':
        case 'switch_attempted':
        case 'switch_applied':
        case 'switch_observed':
        case 'waiting':
        case 'rate_limited':
            return 'waiting';
        case 'exhausted':
            return 'exhausted';
        case 'inactive':
            return 'inactive';
        case 'cancelled':
            return 'cancelled';
        default:
            return null;
    }
}

export type SessionUsageLimitRecoveryActionKind =
    | 'enable'
    | 'cancel'
    | 'check_now'
    | 'consume_reset_credit'
    | 'resume_now'
    | 'switch_fallback_now'
    | 'switch_account_now'
    | 'retry_temporary_throttle'
    | 'remember'
    | 'forget';

export type SessionUsageLimitRecoveryActionPresentation = Readonly<{
    kind: SessionUsageLimitRecoveryActionKind;
    label: string;
    accessibilityLabel: string;
    testID: string;
}>;

export type SessionUsageLimitRecoveryBannerPresentation = Readonly<{
    temporaryThrottle?: Readonly<{ nextCheckAtMs: number | null; attemptCount: number }>;
    actionsDisabled?: boolean;
    testID: string;
    title: string;
    body: string;
    primaryAction: SessionUsageLimitRecoveryActionPresentation;
    secondaryActions: ReadonlyArray<SessionUsageLimitRecoveryActionPresentation>;
}>;

export type SessionUsageLimitRecoveryPresentation = Readonly<{
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
    banner: SessionUsageLimitRecoveryBannerPresentation;
}>;

export type SessionUsageLimitStatusBadgePresentation = Readonly<{
    key: string;
    label: string;
    testID: string;
    accessibilityLabel: string;
    tone: AgentInputStatusBadgeTone;
}>;

export type SessionUsageLimitRecoveryTranslationKey =
    | 'session.usageLimitRecovery.overloadTitle'
    | 'session.usageLimitRecovery.overloadWaiting'
    | 'session.usageLimitRecovery.overloadDispatching'
    | 'session.usageLimitRecovery.overloadAwaiting'
    | 'session.usageLimitRecovery.overloadStopped'
    | 'session.usageLimitRecovery.overloadExhausted'
    | 'session.usageLimitRecovery.overloadOffline'
    | 'session.usageLimitRecovery.stopRetrying'
    | 'session.usageLimitRecovery.title'
    | 'session.usageLimitRecovery.readyTitle'
    | 'session.usageLimitRecovery.resetBody'
    | 'session.usageLimitRecovery.genericBody'
    | 'session.usageLimitRecovery.readyBody'
    | 'session.usageLimitRecovery.enableAction'
    | 'session.usageLimitRecovery.cancelAction'
    | 'session.usageLimitRecovery.checkNowAction'
    | 'session.usageLimitRecovery.consumeResetCreditAction'
    | 'session.usageLimitRecovery.resumeNowAction'
    | 'session.usageLimitRecovery.switchFallbackNowAction'
    | 'session.usageLimitRecovery.switchAccountNowAction'
    | 'session.usageLimitRecovery.retryTemporaryThrottleAction'
    | 'session.usageLimitRecovery.rememberAction'
    | 'session.usageLimitRecovery.forgetAction'
    | 'session.usageLimitRecovery.statusLimitReached'
    | 'session.usageLimitRecovery.statusTemporaryThrottle'
    | 'session.usageLimitRecovery.statusReady'
    | 'session.usageLimitRecovery.statusWaiting'
    | 'session.usageLimitRecovery.statusWaitingUntil'
    | 'session.usageLimitRecovery.statusWaitingResetUntil'
    | 'session.usageLimitRecovery.statusAccountRotationPending'
    | 'session.usageLimitRecovery.statusChecking'
    | 'session.usageLimitRecovery.statusPaused'
    | 'session.usageLimitRecovery.statusExhausted'
    | 'session.usageLimitRecovery.resetCreditBody'
    | 'session.usageLimitRecovery.resetCreditExpiresBody';

type SessionUsageLimitRecoveryTranslationParams = Readonly<{ count?: number; time?: string }>;

type SessionUsageLimitRecoveryParameterizedTranslationKey = {
    [K in SessionUsageLimitRecoveryTranslationKey]: [TranslationParams<K>] extends [never] ? never : K;
}[SessionUsageLimitRecoveryTranslationKey];

type SessionUsageLimitRecoveryStaticTranslationKey = Exclude<
    SessionUsageLimitRecoveryTranslationKey,
    SessionUsageLimitRecoveryParameterizedTranslationKey
>;

export type SessionUsageLimitRecoveryTranslate = (
    key: SessionUsageLimitRecoveryTranslationKey,
    params?: SessionUsageLimitRecoveryTranslationParams,
) => string;

const parameterizedSessionUsageLimitRecoveryTranslations = {
    'session.usageLimitRecovery.resetBody': (params: SessionUsageLimitRecoveryTranslationParams) => (
        t('session.usageLimitRecovery.resetBody', { time: params.time ?? '' })
    ),
    'session.usageLimitRecovery.statusWaitingUntil': (params: SessionUsageLimitRecoveryTranslationParams) => (
        t('session.usageLimitRecovery.statusWaitingUntil', { time: params.time ?? '' })
    ),
    'session.usageLimitRecovery.statusWaitingResetUntil': (params: SessionUsageLimitRecoveryTranslationParams) => (
        t('session.usageLimitRecovery.statusWaitingResetUntil', { time: params.time ?? '' })
    ),
    'session.usageLimitRecovery.resetCreditBody': (params: SessionUsageLimitRecoveryTranslationParams) => (
        t('session.usageLimitRecovery.resetCreditBody', { count: params.count ?? 0 })
    ),
    'session.usageLimitRecovery.resetCreditExpiresBody': (params: SessionUsageLimitRecoveryTranslationParams) => (
        t('session.usageLimitRecovery.resetCreditExpiresBody', {
            count: params.count ?? 0,
            time: params.time ?? '',
        })
    ),
} satisfies Record<
    SessionUsageLimitRecoveryParameterizedTranslationKey,
    (params: SessionUsageLimitRecoveryTranslationParams) => string
>;

function isParameterizedSessionUsageLimitRecoveryTranslationKey(
    key: SessionUsageLimitRecoveryTranslationKey,
): key is SessionUsageLimitRecoveryParameterizedTranslationKey {
    return key in parameterizedSessionUsageLimitRecoveryTranslations;
}

export const translateSessionUsageLimitRecovery: SessionUsageLimitRecoveryTranslate = (key, params) => {
    if (isParameterizedSessionUsageLimitRecoveryTranslationKey(key)) {
        return parameterizedSessionUsageLimitRecoveryTranslations[key](params ?? {});
    }
    return t(key);
};

type PresentationParams = Readonly<{
    machineReachable?: boolean;
    featureEnabled: boolean;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    issue: SessionRuntimeIssueV1 | null | undefined;
    recovery: SessionUsageLimitRecoveryV1 | null | undefined;
    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    /**
     * Absolute retry-allowed time for a probe rate-limit (`retryAfterMs`)
     * reported by the active operation. Display-only timing: it never feeds
     * the reset-elapsed readiness derivation.
     */
    operationRetryAtMs?: number | null;
    runtimeWorking?: boolean;
    hasActivityAfterRuntimeIssue?: boolean;
    hasInterruptedWorkToResume?: boolean;
    rememberedMode: UsageLimitRecoveryRememberedMode;
    checkNowSupported?: boolean;
    nowMs?: number | null;
    translate: SessionUsageLimitRecoveryTranslate;
    formatTime: (timeMs: number) => string;
}>;

function isUsageLimitIssue(issue: SessionRuntimeIssueV1 | null | undefined): issue is SessionRuntimeIssueV1 {
    return issue?.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed'
        && issue.source === 'usage_limit';
}

function isTemporaryThrottleIssue(issue: SessionRuntimeIssueV1 | null | undefined): boolean {
    return issue?.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed'
        && issue.temporaryThrottle?.v === 1
        && issue.temporaryThrottle.recoverability === 'retry';
}

function shouldSurfaceRecoveryIssue(params: Readonly<{
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    issue: SessionRuntimeIssueV1 | null | undefined;
    recovery?: SessionUsageLimitRecoveryV1 | null;
    runtimeWorking?: boolean;
    hasActivityAfterRuntimeIssue?: boolean;
}>): params is Readonly<{
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    issue: SessionRuntimeIssueV1;
    recovery?: SessionUsageLimitRecoveryV1 | null;
    runtimeWorking?: boolean;
    hasActivityAfterRuntimeIssue?: boolean;
}> {
    const hasRecoveryIssue = isUsageLimitIssue(params.issue) || isTemporaryThrottleIssue(params.issue);
    if (!hasRecoveryIssue) return false;
    if (isTemporaryThrottleIssue(params.issue)) {
        const hasProjection = params.recovery?.issueFingerprint.startsWith('temporary-throttle:');
        return params.latestTurnStatus !== 'completed' && (hasProjection || params.hasActivityAfterRuntimeIssue !== true);
    }
    // A cancelled durable recovery intent is a genuine terminal resolution: hide it.
    if (params.recovery?.status === 'cancelled') return false;
    // `runtimeWorking` only proves the runtime is live and ticking thinking/in-progress signals; it is
    // NOT proof that the provider accepted the recovered state or moved to a fresh quota. An unproven,
    // in-progress recovery (waiting-for-reset / provider-outcome-waiting / action-required / exhausted)
    // must stay visible even while the runtime resumes "working" after a local switch. Provider
    // activity only proves recovery once the current lifecycle has advanced to an in-progress turn;
    // terminal text emitted by the failed turn (including the provider's own limit notice) does not.
    if (params.hasActivityAfterRuntimeIssue === true && params.latestTurnStatus === 'in_progress') return false;
    if (
        params.latestTurnStatus != null
        && params.latestTurnStatus !== 'failed'
        && params.latestTurnStatus !== 'cancelled'
        && params.latestTurnStatus !== 'in_progress'
    ) return false;
    return true;
}

function readResetAtMs(
    issue: SessionRuntimeIssueV1,
    recovery: SessionUsageLimitRecoveryV1 | null | undefined,
): number | null {
    if (typeof recovery?.resetAtMs === 'number') return recovery.resetAtMs;
    const resetAtMs = issue.usageLimit?.resetAtMs;
    return typeof resetAtMs === 'number' ? resetAtMs : null;
}

function readWaitUntilMs(params: Readonly<{
    resetAtMs: number | null;
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    operationRetryAtMs?: number | null;
}>): number | null {
    if (params.resetAtMs !== null) return params.resetAtMs;
    // Probe rate-limit retry timing only applies while the throttled operation
    // state is active; it is display timing, not a provider reset promise.
    return params.operationStatus === 'waiting' && typeof params.operationRetryAtMs === 'number'
        ? params.operationRetryAtMs
        : null;
}

function appendRecoveryCreditSummaryBody(params: Readonly<{
    body: string;
    summary: ConnectedServiceQuotaRecoveryCreditSummary | null;
    translate: SessionUsageLimitRecoveryTranslate;
    formatTime: (timeMs: number) => string;
}>): string {
    if (!params.summary) return params.body;
    const creditBody = typeof params.summary.nextExpiresAtMs === 'number'
        ? params.translate('session.usageLimitRecovery.resetCreditExpiresBody', {
            count: params.summary.availableCount,
            time: params.formatTime(params.summary.nextExpiresAtMs),
        })
        : params.translate('session.usageLimitRecovery.resetCreditBody', {
            count: params.summary.availableCount,
        });
    return `${params.body}\n${creditBody}`;
}

function buildAction(
    kind: SessionUsageLimitRecoveryActionKind,
    labelKey: SessionUsageLimitRecoveryStaticTranslationKey,
    testID: string,
    translate: SessionUsageLimitRecoveryTranslate,
): SessionUsageLimitRecoveryActionPresentation {
    const label = translate(labelKey);
    return {
        kind,
        label,
        accessibilityLabel: label,
        testID,
    };
}

function isActiveRecovery(recovery: SessionUsageLimitRecoveryV1 | null | undefined): boolean {
    return recovery?.status === 'armed'
        || recovery?.status === 'waiting'
        || recovery?.status === 'checking'
        || recovery?.status === 'paused';
}

function isResetElapsed(resetAtMs: number | null, nowMs: number | null | undefined): boolean {
    return resetAtMs !== null
        && typeof nowMs === 'number'
        && Number.isFinite(nowMs)
        && nowMs >= resetAtMs;
}

function isReadyForResume(params: Readonly<{
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    resetAtMs: number | null;
    nowMs?: number | null;
    hasInterruptedWorkToResume?: boolean;
}>): boolean {
    return params.operationStatus === 'ready'
        || (
            params.hasInterruptedWorkToResume === true
            && isResetElapsed(params.resetAtMs, params.nowMs)
        );
}

function resolveVisibleRecoveryStatus(params: Readonly<{
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    recoveryStatus?: SessionUsageLimitRecoveryV1['status'] | null;
}>): SessionUsageLimitRecoveryV1['status'] | null {
    switch (params.operationStatus) {
        case 'checking':
            return 'checking';
        case 'waiting':
            return 'waiting';
        case 'exhausted':
            return 'exhausted';
        case 'inactive':
            return 'paused';
        case 'ready':
        case null:
        case undefined:
            return params.recoveryStatus ?? null;
    }
}

function isExhaustedGroupRecoveryForIssue(
    recovery: SessionUsageLimitRecoveryV1 | null | undefined,
    issue: SessionRuntimeIssueV1,
): boolean {
    if (recovery?.status !== 'exhausted' || recovery.selectedAuth.kind !== 'group') return false;
    if (
        recovery.lastProbeError !== 'no_eligible_member'
        && recovery.lastProbeError !== 'connected_service_group_no_eligible_member'
        && recovery.lastProbeError !== 'all_group_members_exhausted'
    ) return false;

    const connectedService = issue.usageLimit?.connectedService;
    if (!connectedService?.groupId) return false;

    return recovery.selectedAuth.serviceId === connectedService.serviceId
        && recovery.selectedAuth.groupId === connectedService.groupId;
}

function isAccountRotationPendingRecovery(
    recovery: SessionUsageLimitRecoveryV1 | null | undefined,
): boolean {
    if (recovery?.status !== 'waiting' || recovery.selectedAuth.kind !== 'group') return false;
    return recovery.lastProbeError === null
        || recovery.lastProbeError === 'no_eligible_member'
        || recovery.lastProbeError === 'connected_service_group_no_eligible_member'
        || recovery.lastProbeError === 'switch_limit_reached';
}

function resolvePrimaryRecoveryAction(params: Readonly<{
    issue: SessionRuntimeIssueV1;
    recovery: SessionUsageLimitRecoveryV1 | null | undefined;
    ready: boolean;
    activeRecovery: boolean;
    checkNowSupported: boolean;
    translate: SessionUsageLimitRecoveryTranslate;
}>): SessionUsageLimitRecoveryActionPresentation {
    if (params.ready) {
        return buildAction('resume_now', 'session.usageLimitRecovery.resumeNowAction', 'session-usageLimit-recovery-resumeNow', params.translate);
    }
    if (params.activeRecovery) {
        return buildAction('cancel', 'session.usageLimitRecovery.cancelAction', 'session-usageLimit-recovery-cancel', params.translate);
    }
    if (isTemporaryThrottleIssue(params.issue) && params.checkNowSupported) {
        return buildAction(
            'retry_temporary_throttle',
            'session.usageLimitRecovery.retryTemporaryThrottleAction',
            'session-usageLimit-recovery-retryTemporaryThrottle',
            params.translate,
        );
    }
    if (params.issue.usageLimit?.recoverability === 'switch_account') {
        const connectedService = params.issue.usageLimit.connectedService;
        const groupId = typeof connectedService?.groupId === 'string' && connectedService.groupId.trim()
            ? connectedService.groupId
            : null;
        return groupId && (
            connectedService?.groupExhausted === true
            || isExhaustedGroupRecoveryForIssue(params.recovery, params.issue)
        )
            ? buildAction(
                'switch_fallback_now',
                'session.usageLimitRecovery.switchFallbackNowAction',
                'session-usageLimit-recovery-switchFallbackNow',
                params.translate,
            )
            : buildAction(
                'switch_account_now',
                'session.usageLimitRecovery.switchAccountNowAction',
                'session-usageLimit-recovery-switchAccountNow',
                params.translate,
            );
    }
    return buildAction('enable', 'session.usageLimitRecovery.enableAction', 'session-usageLimit-recovery-enable', params.translate);
}

function shouldOfferCheckNowSecondary(params: Readonly<{
    ready: boolean;
    checkNowSupported: boolean;
    primaryAction: SessionUsageLimitRecoveryActionPresentation;
}>): boolean {
    // Switch primaries (incl. the exhausted-group dead-letter state) keep a
    // check-now secondary: a fresh quota probe can clear stale limiter fields
    // (F7) without attempting a switch. Temporary-throttle retries are already
    // a cheap re-probe, so a second probe button would be redundant there.
    return !params.ready
        && params.checkNowSupported
        && params.primaryAction.kind !== 'retry_temporary_throttle';
}

export function buildSessionUsageLimitRecoveryPresentation(
    params: PresentationParams,
): SessionUsageLimitRecoveryPresentation | null {
    if (isUsageLimitIssue(params.issue) && params.recovery
        && !isSessionUsageLimitRecoveryForIssue(params.issue, params.recovery)) {
        params = { ...params, recovery: null };
    }
    if (!params.featureEnabled || !shouldSurfaceRecoveryIssue(params)) return null;

    if (isTemporaryThrottleIssue(params.issue)) {
        const recovery = params.recovery?.issueFingerprint.startsWith('temporary-throttle:') ? params.recovery : null;
        const active = isActiveRecovery(recovery);
        const offline = params.machineReachable === false;
        const dispatching = recovery?.status === 'checking';
        const nextCheckAtMs = !offline && !dispatching && active ? recovery?.nextCheckAtMs ?? null : null;
        const primaryAction = active
            ? buildAction('cancel', 'session.usageLimitRecovery.stopRetrying', 'session-usageLimit-recovery-cancel', params.translate)
            : buildAction('retry_temporary_throttle', 'session.usageLimitRecovery.retryTemporaryThrottleAction', 'session-usageLimit-recovery-retryTemporaryThrottle', params.translate);
        return {
            issueFingerprint: recovery?.issueFingerprint ?? buildUsageLimitIssueFingerprint(params.issue),
            armedAtMs: recovery?.armedAtMs ?? params.issue.occurredAt,
            banner: {
                testID: 'session-usageLimit-recovery', title: params.translate('session.usageLimitRecovery.overloadTitle'),
                body: params.translate(offline ? 'session.usageLimitRecovery.overloadOffline'
                    : dispatching ? 'session.usageLimitRecovery.overloadDispatching'
                    : nextCheckAtMs !== null ? 'session.usageLimitRecovery.overloadWaiting'
                    : active ? 'session.usageLimitRecovery.overloadAwaiting'
                    : recovery?.status === 'exhausted' ? 'session.usageLimitRecovery.overloadExhausted'
                    : 'session.usageLimitRecovery.overloadStopped'),
                actionsDisabled: offline || (!active && params.checkNowSupported !== true),
                temporaryThrottle: { nextCheckAtMs, attemptCount: recovery?.attemptCount ?? 0 },
                primaryAction,
                secondaryActions: active && nextCheckAtMs !== null && params.checkNowSupported === true ? [
                    buildAction('retry_temporary_throttle', 'session.usageLimitRecovery.retryTemporaryThrottleAction', 'session-usageLimit-recovery-retryTemporaryThrottle', params.translate),
                ] : [],
            },
        };
    }

    const resetAtMs = readResetAtMs(params.issue, params.recovery);
    const ready = isReadyForResume({
        operationStatus: params.operationStatus,
        resetAtMs,
        nowMs: params.nowMs,
        hasInterruptedWorkToResume: params.hasInterruptedWorkToResume,
    });
    const activeRecovery = isActiveRecovery(params.recovery);
    const checkNowSupported = params.checkNowSupported === true;
    const recoveryCreditSummary = summarizeConnectedServiceQuotaRecoveryCredits(
        params.recoveryCredits ?? params.recovery?.recoveryCredits ?? null,
        params.nowMs,
    );
    const primaryAction = resolvePrimaryRecoveryAction({
        issue: params.issue,
        recovery: params.recovery,
        ready,
        activeRecovery,
        checkNowSupported,
        translate: params.translate,
    });
    const waitUntilMs = readWaitUntilMs({
        resetAtMs,
        operationStatus: params.operationStatus,
        operationRetryAtMs: params.operationRetryAtMs,
    });
    const body = ready
        ? params.translate('session.usageLimitRecovery.readyBody')
        : waitUntilMs !== null
        ? params.translate('session.usageLimitRecovery.resetBody', {
            time: params.formatTime(waitUntilMs),
        })
        : params.translate('session.usageLimitRecovery.genericBody');
    const bodyWithRecoveryCredits = appendRecoveryCreditSummaryBody({
        body,
        summary: ready ? null : recoveryCreditSummary,
        translate: params.translate,
        formatTime: params.formatTime,
    });

    return {
        issueFingerprint: params.recovery?.issueFingerprint ?? buildUsageLimitIssueFingerprint(params.issue),
        armedAtMs: params.recovery?.armedAtMs ?? params.issue.occurredAt,
        ...(params.recovery?.runtimeAuthRecoveryAttemptId
            ? { runtimeAuthRecoveryAttemptId: params.recovery.runtimeAuthRecoveryAttemptId }
            : {}),
        banner: {
            testID: 'session-usageLimit-recovery',
            title: ready
                ? params.translate('session.usageLimitRecovery.readyTitle')
                : params.translate('session.usageLimitRecovery.title'),
            body: bodyWithRecoveryCredits,
            primaryAction,
            secondaryActions: [
                ...(!ready && recoveryCreditSummary && checkNowSupported ? [
                    buildAction(
                        'consume_reset_credit',
                        'session.usageLimitRecovery.consumeResetCreditAction',
                        'session-usageLimit-recovery-consumeResetCredit',
                        params.translate,
                    ),
                ] : []),
                ...(shouldOfferCheckNowSecondary({ ready, checkNowSupported, primaryAction }) ? [
                    buildAction('check_now', 'session.usageLimitRecovery.checkNowAction', 'session-usageLimit-recovery-checkNow', params.translate),
                ] : []),
                params.rememberedMode === 'auto_wait'
                    ? buildAction('forget', 'session.usageLimitRecovery.forgetAction', 'session-usageLimit-recovery-forget', params.translate)
                    : buildAction('remember', 'session.usageLimitRecovery.rememberAction', 'session-usageLimit-recovery-remember', params.translate),
            ],
        },
    };
}

export function buildSessionUsageLimitStatusBadgePresentation(
    params: Omit<PresentationParams, 'rememberedMode'>,
): SessionUsageLimitStatusBadgePresentation | null {
    if (isUsageLimitIssue(params.issue) && params.recovery
        && !isSessionUsageLimitRecoveryForIssue(params.issue, params.recovery)) {
        params = { ...params, recovery: null };
    }
    if (!params.featureEnabled || !shouldSurfaceRecoveryIssue(params)) return null;

    const resetAtMs = readResetAtMs(params.issue, params.recovery);
    const waitUntilMs = readWaitUntilMs({
        resetAtMs,
        operationStatus: params.operationStatus,
        operationRetryAtMs: params.operationRetryAtMs,
    });
    const recoveryStatus = resolveVisibleRecoveryStatus({
        operationStatus: params.operationStatus,
        recoveryStatus: params.recovery?.status,
    });
    const label = isReadyForResume({
        operationStatus: params.operationStatus,
        resetAtMs,
        nowMs: params.nowMs,
        hasInterruptedWorkToResume: params.hasInterruptedWorkToResume,
    })
        ? params.translate('session.usageLimitRecovery.statusReady')
        : isTemporaryThrottleIssue(params.issue)
        ? params.translate('session.usageLimitRecovery.overloadTitle')
        : recoveryStatus === 'checking'
        ? params.translate('session.usageLimitRecovery.statusChecking')
        : recoveryStatus === 'waiting' && waitUntilMs !== null
            ? params.translate(
                resetAtMs !== null
                    ? 'session.usageLimitRecovery.statusWaitingResetUntil'
                    : 'session.usageLimitRecovery.statusWaitingUntil',
                { time: params.formatTime(waitUntilMs) },
            )
            : recoveryStatus === 'waiting' && isAccountRotationPendingRecovery(params.recovery)
                ? params.translate('session.usageLimitRecovery.statusAccountRotationPending')
            : recoveryStatus === 'waiting'
                ? params.translate('session.usageLimitRecovery.statusWaiting')
                : recoveryStatus === 'paused'
                    ? params.translate('session.usageLimitRecovery.statusPaused')
                    : recoveryStatus === 'exhausted'
                        ? params.translate('session.usageLimitRecovery.statusExhausted')
                        : params.translate('session.usageLimitRecovery.statusLimitReached');

    return {
        key: 'session-usage-limit-recovery',
        label,
        testID: 'session-usageLimit-status-badge',
        accessibilityLabel: label,
        tone: 'warning',
    };
}
