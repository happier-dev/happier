import type { SessionUsageLimitRecoveryOperationResultV1 } from '@happier-dev/protocol/sessions/control/sessionUsageLimitRecoveryOperationResultV1';
import type {
    ConnectedServiceQuotaRecoveryCreditsV1} from '@happier-dev/protocol/connect/connected-service-schemas';
import type {
    PrimaryTurnStatusV1,
    SessionRuntimeIssueV1} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type {
    SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import {
    buildUsageLimitIssueFingerprint,
    isSessionUsageLimitRecoveryForIssue,
    isSessionUsageLimitIssueCurrentV1,
} from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
export { readSessionUsageLimitRecoveryFromMetadata } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';

import type { AgentInputStatusBadge, AgentInputStatusBadgeTone } from '@/components/sessions/agentInput/agentInputContracts';
import { summarizeConnectedServiceQuotaRecoveryCredits } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

export const SESSION_USAGE_LIMIT_RECOVERY_BADGE_KEY = 'usage-limit-recovery';

export type SessionUsageLimitRecoveryState = SessionUsageLimitRecoveryV1;

export type UsageLimitRecoverySettings = Readonly<{
    v: 1;
    mode: 'ask' | 'auto_wait';
    promptMode?: 'standard';
    resumePromptMode?: 'standard' | 'off' | 'custom';
    customResumePrompt?: string;
}>;

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
    | 'resume_now'
    | 'switch_fallback_now'
    | 'switch_account_now'
    | 'consume_reset_credit'
    | 'retry_temporary_throttle'
    | 'remember'
    | 'forget';

export type SessionUsageLimitRecoverySecondaryActionPresentation = Readonly<{
    kind: Exclude<SessionUsageLimitRecoveryActionKind, 'enable' | 'cancel'>;
    label: string;
    accessibilityLabel: string;
    testID: string;
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
    | 'session.usageLimitRecovery.banner.title'
    | 'session.usageLimitRecovery.banner.body'
    | 'session.usageLimitRecovery.banner.waitingTitle'
    | 'session.usageLimitRecovery.banner.waitingBody'
    | 'session.usageLimitRecovery.banner.readyTitle'
    | 'session.usageLimitRecovery.banner.readyBody'
    | 'session.usageLimitRecovery.banner.resetCreditSummary'
    | 'session.usageLimitRecovery.banner.retryAt'
    | 'session.usageLimitRecovery.actions.enable'
    | 'session.usageLimitRecovery.actions.cancel'
    | 'session.usageLimitRecovery.actions.checkNow'
    | 'session.usageLimitRecovery.actions.resumeNow'
    | 'session.usageLimitRecovery.actions.switchFallbackNow'
    | 'session.usageLimitRecovery.actions.switchAccountNow'
    | 'session.usageLimitRecovery.actions.consumeResetCredit'
    | 'session.usageLimitRecovery.actions.retryTemporaryThrottle'
    | 'session.usageLimitRecovery.actions.remember'
    | 'session.usageLimitRecovery.actions.forget'
    | 'session.usageLimitRecovery.status.ready'
    | 'session.usageLimitRecovery.status.resumeReady'
    | 'session.usageLimitRecovery.status.checking'
    | 'session.usageLimitRecovery.status.waiting'
    | 'session.usageLimitRecovery.status.waitingForQuotaReset'
    | 'session.usageLimitRecovery.status.accountRotationPending'
    | 'session.usageLimitRecovery.status.temporaryThrottle';

export type SessionUsageLimitRecoveryTranslationParams = Readonly<{
    'session.usageLimitRecovery.banner.resetCreditSummary': Readonly<{
        count: number;
        expiresAt: string | null;
    }>;
    'session.usageLimitRecovery.banner.retryAt': Readonly<{ time: string }>;
}>;

export type SessionUsageLimitRecoveryBannerPresentation = Readonly<{
    temporaryThrottle?: Readonly<{ nextCheckAtMs: number | null; attemptCount: number }>;
    actionsDisabled?: boolean;
    testID: string;
    actionTestID: string;
    title: string;
    body: string;
    actionLabel: string;
    actionAccessibilityLabel: string;
    mode: 'enable' | 'cancel' | 'resume_now' | 'switch_fallback_now' | 'switch_account_now' | 'retry_temporary_throttle';
    secondaryActions: readonly SessionUsageLimitRecoverySecondaryActionPresentation[];
}>;

export type SessionUsageLimitRecoveryPresentation = Readonly<{
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
    waiting: boolean;
    banner: SessionUsageLimitRecoveryBannerPresentation;
    statusBadge: AgentInputStatusBadge;
}>;

export type SessionUsageLimitRecoveryTranslate = <K extends SessionUsageLimitRecoveryTranslationKey>(
    key: K,
    ...params: K extends keyof SessionUsageLimitRecoveryTranslationParams
        ? [params: SessionUsageLimitRecoveryTranslationParams[K]]
        : []
) => string;

function isUsageLimitIssue(issue: SessionRuntimeIssueV1 | null | undefined): issue is SessionRuntimeIssueV1 {
    return issue?.source === 'usage_limit' || issue?.code === 'usage_limit';
}

function isTemporaryThrottleIssue(issue: SessionRuntimeIssueV1 | null | undefined): boolean {
    return issue?.temporaryThrottle?.v === 1 && issue.temporaryThrottle.recoverability === 'retry';
}

export function isSessionUsageLimitRecoveryCheckNowAction(kind: SessionUsageLimitRecoveryActionKind): boolean {
    return kind === 'check_now'
        || kind === 'switch_fallback_now'
        || kind === 'switch_account_now'
        || kind === 'consume_reset_credit'
        || kind === 'retry_temporary_throttle';
}

export function isSessionUsageLimitRecoveryCheckingOperationAction(kind: SessionUsageLimitRecoveryActionKind): boolean {
    return kind === 'enable'
        || kind === 'cancel'
        || kind === 'check_now'
        || kind === 'resume_now'
        || kind === 'switch_fallback_now'
        || kind === 'switch_account_now'
        || kind === 'consume_reset_credit'
        || kind === 'retry_temporary_throttle'
        || kind === 'remember'
        || kind === 'forget';
}

function readNumberField(value: unknown, key: string): number | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function isActiveRecoveryStatus(status: SessionUsageLimitRecoveryState['status'] | null | undefined): boolean {
    return status === 'armed'
        || status === 'waiting'
        || status === 'checking'
        || status === 'paused';
}

function resolveBadgeTone(waiting: boolean): AgentInputStatusBadgeTone {
    return waiting ? 'active' : 'warning';
}

function resolveWaitingStatusLabelKey(
    recoveryState: SessionUsageLimitRecoveryState | null,
    resetAtMs: number | null,
): SessionUsageLimitRecoveryTranslationKey {
    if (resetAtMs !== null) return 'session.usageLimitRecovery.status.waitingForQuotaReset';
    if (recoveryState?.selectedAuth.kind === 'group') return 'session.usageLimitRecovery.status.accountRotationPending';
    return 'session.usageLimitRecovery.status.waiting';
}

function readUsageLimitResetAtMs(
    issue: SessionRuntimeIssueV1,
    recoveryState: SessionUsageLimitRecoveryState | null,
): number | null {
    if (typeof recoveryState?.resetAtMs === 'number' && Number.isFinite(recoveryState.resetAtMs)) {
        return recoveryState.resetAtMs;
    }
    return readNumberField((issue as { usageLimit?: unknown }).usageLimit, 'resetAtMs');
}

export function hasSessionUsageLimitResetElapsed(resetAtMs: number | null, nowMs: number | null | undefined): boolean {
    return resetAtMs !== null
        && typeof nowMs === 'number'
        && Number.isFinite(nowMs)
        && nowMs >= resetAtMs;
}

function formatRecoveryTime(atMs: number): string {
    return new Date(atMs).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

function isExhaustedGroupRecoveryForIssue(
    recoveryState: SessionUsageLimitRecoveryState | null,
    issue: SessionRuntimeIssueV1,
): boolean {
    if (recoveryState?.status !== 'exhausted' || recoveryState.selectedAuth.kind !== 'group') return false;
    if (
        recoveryState.lastProbeError !== 'no_eligible_member'
        && recoveryState.lastProbeError !== 'connected_service_group_no_eligible_member'
        && recoveryState.lastProbeError !== 'all_group_members_exhausted'
    ) return false;

    const connectedService = issue.usageLimit?.connectedService;
    if (!connectedService?.groupId) return false;

    return recoveryState.selectedAuth.serviceId === connectedService.serviceId
        && recoveryState.selectedAuth.groupId === connectedService.groupId;
}

function resolvePrimaryAction(params: Readonly<{
    issue: SessionRuntimeIssueV1;
    recoveryState: SessionUsageLimitRecoveryState | null;
    ready: boolean;
    waiting: boolean;
    checkNowSupported: boolean;
}>): SessionUsageLimitRecoveryBannerPresentation['mode'] {
    if (params.ready) return 'resume_now';
    if (params.waiting) return 'cancel';
    if (isTemporaryThrottleIssue(params.issue) && params.checkNowSupported) {
        return 'retry_temporary_throttle';
    }
    const usageLimit = params.issue.usageLimit;
    if (usageLimit?.recoverability === 'switch_account') {
        const connectedService = usageLimit.connectedService;
        if (
            connectedService?.groupId
            && (
                connectedService.groupExhausted === true
                || isExhaustedGroupRecoveryForIssue(params.recoveryState, params.issue)
            )
        ) {
            return 'switch_fallback_now';
        }
        return 'switch_account_now';
    }
    return 'enable';
}

function actionLabelKeyForMode(mode: SessionUsageLimitRecoveryBannerPresentation['mode']): SessionUsageLimitRecoveryTranslationKey {
    if (mode === 'resume_now') return 'session.usageLimitRecovery.actions.resumeNow';
    if (mode === 'cancel') return 'session.usageLimitRecovery.actions.cancel';
    if (mode === 'switch_fallback_now') return 'session.usageLimitRecovery.actions.switchFallbackNow';
    if (mode === 'switch_account_now') return 'session.usageLimitRecovery.actions.switchAccountNow';
    if (mode === 'retry_temporary_throttle') return 'session.usageLimitRecovery.actions.retryTemporaryThrottle';
    return 'session.usageLimitRecovery.actions.enable';
}

function actionTestIdForMode(mode: SessionUsageLimitRecoveryBannerPresentation['mode']): string {
    if (mode === 'resume_now') return 'session-usageLimit-recovery-resumeNow';
    if (mode === 'cancel') return 'session-usageLimit-recovery-cancel';
    if (mode === 'switch_fallback_now') return 'session-usageLimit-recovery-switchFallbackNow';
    if (mode === 'switch_account_now') return 'session-usageLimit-recovery-switchAccountNow';
    if (mode === 'retry_temporary_throttle') return 'session-usageLimit-recovery-retryTemporaryThrottle';
    return 'session-usageLimit-recovery-enable';
}

/** The daemon's same-Session automatic retry, projected under its temporary-throttle fingerprint. */
function readDaemonRetryRecovery(recovery: SessionUsageLimitRecoveryState | null): SessionUsageLimitRecoveryState | null {
    return recovery?.issueFingerprint.startsWith('temporary-throttle:') ? recovery : null;
}

/** One card for an automatic retry: its real state, when it runs next, and Stop retrying / Retry now. */
function buildDaemonRetryPresentation(params: Readonly<{
    issue: SessionRuntimeIssueV1;
    recovery: SessionUsageLimitRecoveryState | null;
    /** A usage limit names its limit and the retry time; an overload counts down to the next attempt. */
    usageLimit: boolean;
    machineReachable?: boolean;
    checkNowSupported?: boolean;
    translate: SessionUsageLimitRecoveryTranslate;
}>): SessionUsageLimitRecoveryPresentation {
    const { recovery, translate } = params;
    const active = isActiveRecoveryStatus(recovery?.status);
    const offline = params.machineReachable === false;
    const dispatching = recovery?.status === 'checking';
    const nextCheckAtMs = !offline && !dispatching && active ? recovery?.nextCheckAtMs ?? null : null;
    const mode = active ? 'cancel' : 'retry_temporary_throttle';
    const actionLabel = translate(active ? 'session.usageLimitRecovery.stopRetrying' : 'session.usageLimitRecovery.actions.retryTemporaryThrottle');
    const retryLabel = translate('session.usageLimitRecovery.actions.retryTemporaryThrottle');
    const title = translate(params.usageLimit ? 'session.usageLimitRecovery.banner.title' : 'session.usageLimitRecovery.overloadTitle');
    const body = params.usageLimit && nextCheckAtMs !== null
        ? translate('session.usageLimitRecovery.banner.retryAt', { time: formatRecoveryTime(nextCheckAtMs) })
        : translate(offline ? 'session.usageLimitRecovery.overloadOffline'
            : dispatching ? 'session.usageLimitRecovery.overloadDispatching'
            : nextCheckAtMs !== null ? 'session.usageLimitRecovery.overloadWaiting'
            : active ? (params.usageLimit ? 'session.usageLimitRecovery.banner.waitingBody' : 'session.usageLimitRecovery.overloadAwaiting')
            : recovery?.status === 'exhausted' ? 'session.usageLimitRecovery.overloadExhausted'
            : 'session.usageLimitRecovery.overloadStopped');
    const badgeLabel = params.usageLimit
        ? translate(active ? 'session.usageLimitRecovery.status.waiting' : 'session.usageLimitRecovery.status.ready')
        : title;
    return {
        issueFingerprint: recovery?.issueFingerprint ?? buildUsageLimitIssueFingerprint(params.issue),
        armedAtMs: recovery?.armedAtMs ?? params.issue.occurredAt,
        waiting: active,
        banner: {
            testID: 'session-usageLimit-recovery', actionTestID: actionTestIdForMode(mode),
            title, body, mode, actionLabel, actionAccessibilityLabel: actionLabel,
            actionsDisabled: offline || (!active && params.checkNowSupported !== true),
            ...(params.usageLimit ? {} : { temporaryThrottle: { nextCheckAtMs, attemptCount: recovery?.attemptCount ?? 0 } }),
            secondaryActions: active && nextCheckAtMs !== null && params.checkNowSupported === true ? [{
                kind: 'retry_temporary_throttle', label: retryLabel, accessibilityLabel: retryLabel,
                testID: 'session-usageLimit-recovery-retryTemporaryThrottle',
            }] : [],
        },
        statusBadge: { key: SESSION_USAGE_LIMIT_RECOVERY_BADGE_KEY, label: badgeLabel,
            testID: 'session-usageLimit-status-badge', tone: active && !offline ? 'active' : 'warning' },
    };
}

export function buildSessionUsageLimitRecoveryPresentation(params: Readonly<{
    featureEnabled: boolean;
    lastRuntimeIssue: SessionRuntimeIssueV1 | null | undefined;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    recoveryState: SessionUsageLimitRecoveryState | null;
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    checkNowSupported?: boolean;
    recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1 | null;
    runtimeWorking?: boolean;
    machineReachable?: boolean;
    hasActivityAfterRuntimeIssue?: boolean;
    hasInterruptedWorkToResume?: boolean;
    nowMs?: number | null;
    settings: UsageLimitRecoverySettings;
    translate: SessionUsageLimitRecoveryTranslate;
}>): SessionUsageLimitRecoveryPresentation | null {
    if (!params.featureEnabled) return null;
    // A live "thinking"/in-progress signal is NOT provider-outcome proof: after a local account
    // switch the runtime resumes "working" before the provider has confirmed recovery. Hiding the
    // banner on runtimeWorking made an unproven recovery look resolved. Hide only on genuine
    // provider-outcome proof (activity after the runtime issue boundary).
    const lastRuntimeIssue = params.lastRuntimeIssue;
    if (!lastRuntimeIssue) return null;
    const temporaryThrottle = isTemporaryThrottleIssue(lastRuntimeIssue);
    if (!isUsageLimitIssue(lastRuntimeIssue) && !temporaryThrottle) return null;
    const daemonRetry = readDaemonRetryRecovery(params.recoveryState);
    if (temporaryThrottle) {
        if (params.latestTurnStatus === 'completed' || (!daemonRetry && params.hasActivityAfterRuntimeIssue === true)) return null;
        return buildDaemonRetryPresentation({ ...params, issue: lastRuntimeIssue, recovery: daemonRetry, usageLimit: false });
    }
    // A usage limit the daemon is already retrying on its own (a limit not scoped to the account) is
    // presented as that retry: offering an opt-in wait here contradicted the retry already scheduled.
    if (daemonRetry && isActiveRecoveryStatus(daemonRetry.status)) {
        if (!isSessionUsageLimitIssueCurrentV1({ issue: lastRuntimeIssue, recovery: null,
            latestTurnStatus: params.latestTurnStatus, hasActivityAfterRuntimeIssue: params.hasActivityAfterRuntimeIssue })) return null;
        return buildDaemonRetryPresentation({ ...params, issue: lastRuntimeIssue, recovery: daemonRetry, usageLimit: true });
    }
    if (params.recoveryState && !isSessionUsageLimitRecoveryForIssue(lastRuntimeIssue, params.recoveryState)) {
        params = { ...params, recoveryState: null };
    }
    if (!isSessionUsageLimitIssueCurrentV1({ issue: lastRuntimeIssue,
        recovery: params.recoveryState, latestTurnStatus: params.latestTurnStatus,
        hasActivityAfterRuntimeIssue: params.hasActivityAfterRuntimeIssue })) return null;

    const resetAtMs = readUsageLimitResetAtMs(lastRuntimeIssue, params.recoveryState);
    const ready = params.operationStatus === 'ready'
        || (
            params.hasInterruptedWorkToResume === true
            && hasSessionUsageLimitResetElapsed(resetAtMs, params.nowMs)
        );
    const checking = !ready && params.operationStatus === 'checking';
    const waiting = checking || (!ready && (params.operationStatus === 'waiting' || isActiveRecoveryStatus(params.recoveryState?.status)));
    const checkNowSupported = params.checkNowSupported === true;
    const recoveryCreditSummary = summarizeConnectedServiceQuotaRecoveryCredits(
        params.recoveryCredits ?? params.recoveryState?.recoveryCredits ?? null,
        typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now(),
    );
    const issueFingerprint = params.recoveryState?.issueFingerprint ?? buildUsageLimitIssueFingerprint(lastRuntimeIssue);
    const mode = resolvePrimaryAction({
        issue: lastRuntimeIssue,
        recoveryState: params.recoveryState,
        ready,
        waiting: isActiveRecoveryStatus(params.recoveryState?.status),
        checkNowSupported,
    });
    const title = ready
        ? params.translate('session.usageLimitRecovery.banner.readyTitle')
        : waiting
        ? params.translate('session.usageLimitRecovery.banner.waitingTitle')
        : params.translate('session.usageLimitRecovery.banner.title');
    const body = ready
        ? params.translate('session.usageLimitRecovery.banner.readyBody')
        : waiting
        ? params.translate('session.usageLimitRecovery.banner.waitingBody')
        : params.translate('session.usageLimitRecovery.banner.body');
    const actionLabel = params.translate(actionLabelKeyForMode(mode));
    const checkNowLabel = params.translate('session.usageLimitRecovery.actions.checkNow');
    const consumeResetCreditLabel = params.translate('session.usageLimitRecovery.actions.consumeResetCredit');
    const bodyWithRecoveryCreditSummary = recoveryCreditSummary
        ? `${body}\n${params.translate('session.usageLimitRecovery.banner.resetCreditSummary', {
            count: recoveryCreditSummary.availableCount,
            expiresAt: recoveryCreditSummary.nextExpiresAtMs === null ? null : formatRecoveryTime(recoveryCreditSummary.nextExpiresAtMs),
        })}`
        : body;
    const rememberActionKind = params.settings.mode === 'auto_wait' ? 'forget' : 'remember';
    const rememberLabel = params.translate(
        rememberActionKind === 'forget'
            ? 'session.usageLimitRecovery.actions.forget'
            : 'session.usageLimitRecovery.actions.remember',
    );
    const statusLabel = ready
        ? params.translate('session.usageLimitRecovery.status.resumeReady')
        : checking
        ? params.translate('session.usageLimitRecovery.status.checking')
        : waiting
        ? params.translate(resolveWaitingStatusLabelKey(params.recoveryState, resetAtMs))
        : temporaryThrottle
        ? params.translate('session.usageLimitRecovery.status.temporaryThrottle')
        : params.translate('session.usageLimitRecovery.status.ready');
    const tone = resolveBadgeTone(waiting);

    return {
        issueFingerprint,
        armedAtMs: params.recoveryState?.armedAtMs ?? lastRuntimeIssue.occurredAt,
        ...(params.recoveryState?.runtimeAuthRecoveryAttemptId
            ? { runtimeAuthRecoveryAttemptId: params.recoveryState.runtimeAuthRecoveryAttemptId }
            : {}),
        waiting,
        banner: {
            testID: 'session-usageLimit-recovery',
            actionTestID: actionTestIdForMode(mode),
            title,
            body: bodyWithRecoveryCreditSummary,
            actionLabel,
            actionAccessibilityLabel: actionLabel,
            mode,
            secondaryActions: [
                ...(recoveryCreditSummary && !ready && checkNowSupported ? [{
                    kind: 'consume_reset_credit' as const,
                    label: consumeResetCreditLabel,
                    accessibilityLabel: consumeResetCreditLabel,
                    testID: 'session-usageLimit-recovery-consumeResetCredit',
                }] : []),
                ...(!ready && checkNowSupported && !isSessionUsageLimitRecoveryCheckNowAction(mode) ? [{
                    kind: 'check_now' as const,
                    label: checkNowLabel,
                    accessibilityLabel: checkNowLabel,
                    testID: 'session-usageLimit-recovery-checkNow',
                }] : []),
                {
                    kind: rememberActionKind,
                    label: rememberLabel,
                    accessibilityLabel: rememberLabel,
                    testID: rememberActionKind === 'forget'
                        ? 'session-usageLimit-recovery-forget'
                        : 'session-usageLimit-recovery-remember',
                },
            ],
        },
        statusBadge: {
            key: SESSION_USAGE_LIMIT_RECOVERY_BADGE_KEY,
            label: statusLabel,
            testID: 'session-usageLimit-status-badge',
            tone,
        },
    };
}
