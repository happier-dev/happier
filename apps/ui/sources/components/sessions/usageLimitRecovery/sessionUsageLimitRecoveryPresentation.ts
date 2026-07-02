import type {
    PrimaryTurnStatusV1,
    SessionRuntimeIssueV1,
    SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol';

import type { AgentInputStatusBadge, AgentInputStatusBadgeTone } from '@/components/sessions/agentInput/agentInputContracts';

export const SESSION_USAGE_LIMIT_RECOVERY_BADGE_KEY = 'usage-limit-recovery';

export type SessionUsageLimitRecoveryState = SessionUsageLimitRecoveryV1;

export type UsageLimitRecoverySettings = Readonly<{
    v: 1;
    mode: 'ask' | 'auto_wait';
    promptMode?: 'standard';
    resumePromptMode?: 'standard' | 'off' | 'custom';
    customResumePrompt?: string;
}>;

export type UsageLimitRecoveryOperationStatus = 'checking' | 'ready' | 'waiting' | 'resumed' | 'exhausted' | 'inactive';

export type SessionUsageLimitRecoveryActionKind =
    | 'enable'
    | 'cancel'
    | 'check_now'
    | 'resume_now'
    | 'switch_fallback_now'
    | 'switch_account_now'
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
    | 'session.usageLimitRecovery.banner.title'
    | 'session.usageLimitRecovery.banner.body'
    | 'session.usageLimitRecovery.banner.waitingTitle'
    | 'session.usageLimitRecovery.banner.waitingBody'
    | 'session.usageLimitRecovery.banner.readyTitle'
    | 'session.usageLimitRecovery.banner.readyBody'
    | 'session.usageLimitRecovery.actions.enable'
    | 'session.usageLimitRecovery.actions.cancel'
    | 'session.usageLimitRecovery.actions.checkNow'
    | 'session.usageLimitRecovery.actions.resumeNow'
    | 'session.usageLimitRecovery.actions.switchFallbackNow'
    | 'session.usageLimitRecovery.actions.switchAccountNow'
    | 'session.usageLimitRecovery.actions.retryTemporaryThrottle'
    | 'session.usageLimitRecovery.actions.remember'
    | 'session.usageLimitRecovery.actions.forget'
    | 'session.usageLimitRecovery.status.ready'
    | 'session.usageLimitRecovery.status.resumeReady'
    | 'session.usageLimitRecovery.status.checking'
    | 'session.usageLimitRecovery.status.waiting'
    | 'session.usageLimitRecovery.status.temporaryThrottle';

export type SessionUsageLimitRecoveryBannerPresentation = Readonly<{
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
    waiting: boolean;
    banner: SessionUsageLimitRecoveryBannerPresentation;
    statusBadge: AgentInputStatusBadge;
}>;

type Translate = (key: SessionUsageLimitRecoveryTranslationKey) => string;

function isUsageLimitIssue(issue: SessionRuntimeIssueV1 | null | undefined): issue is SessionRuntimeIssueV1 {
    return issue?.source === 'usage_limit' || issue?.code === 'usage_limit';
}

function isTemporaryThrottleIssue(issue: SessionRuntimeIssueV1 | null | undefined): issue is SessionRuntimeIssueV1 {
    return issue?.temporaryThrottle?.v === 1 && issue.temporaryThrottle.recoverability === 'retry';
}

export function isSessionUsageLimitRecoveryCheckNowAction(kind: SessionUsageLimitRecoveryActionKind): boolean {
    return kind === 'check_now'
        || kind === 'switch_fallback_now'
        || kind === 'switch_account_now'
        || kind === 'retry_temporary_throttle';
}

export function isSessionUsageLimitRecoveryCheckingOperationAction(kind: SessionUsageLimitRecoveryActionKind): boolean {
    return kind === 'enable'
        || kind === 'cancel'
        || kind === 'check_now'
        || kind === 'resume_now'
        || kind === 'switch_fallback_now'
        || kind === 'switch_account_now'
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

export function readSessionUsageLimitRecoveryFromMetadata(metadata: unknown): SessionUsageLimitRecoveryState | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const raw = (metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1;
    const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

function buildIssueFingerprint(issue: SessionRuntimeIssueV1): string {
    const seq = typeof issue.sessionSeq === 'number' ? issue.sessionSeq : issue.occurredAt;
    return `usage-limit:${issue.provider ?? 'provider'}:${seq}`;
}

function resolveBadgeTone(waiting: boolean): AgentInputStatusBadgeTone {
    return waiting ? 'active' : 'warning';
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

function hasResetElapsed(resetAtMs: number | null, nowMs: number | null | undefined): boolean {
    return resetAtMs !== null
        && typeof nowMs === 'number'
        && Number.isFinite(nowMs)
        && nowMs >= resetAtMs;
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

export function buildSessionUsageLimitRecoveryPresentation(params: Readonly<{
    featureEnabled: boolean;
    lastRuntimeIssue: SessionRuntimeIssueV1 | null | undefined;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    recoveryState: SessionUsageLimitRecoveryState | null;
    operationStatus?: UsageLimitRecoveryOperationStatus | null;
    checkNowSupported?: boolean;
    runtimeWorking?: boolean;
    hasActivityAfterRuntimeIssue?: boolean;
    hasInterruptedWorkToResume?: boolean;
    nowMs?: number | null;
    settings: UsageLimitRecoverySettings;
    translate: Translate;
}>): SessionUsageLimitRecoveryPresentation | null {
    if (!params.featureEnabled) return null;
    // A live "thinking"/in-progress signal is NOT provider-outcome proof: after a local account
    // switch the runtime resumes "working" before the provider has confirmed recovery. Hiding the
    // banner on runtimeWorking made an unproven recovery look resolved. Hide only on genuine
    // provider-outcome proof (activity after the runtime issue boundary).
    if (params.hasActivityAfterRuntimeIssue === true) return null;
    if (params.latestTurnStatus != null && params.latestTurnStatus !== 'failed') return null;
    const lastRuntimeIssue = params.lastRuntimeIssue;
    const temporaryThrottle = isTemporaryThrottleIssue(lastRuntimeIssue);
    if (!isUsageLimitIssue(lastRuntimeIssue) && !temporaryThrottle) return null;

    const resetAtMs = readUsageLimitResetAtMs(lastRuntimeIssue, params.recoveryState);
    const ready = params.operationStatus === 'ready'
        || params.operationStatus === 'resumed'
        || (
            params.hasInterruptedWorkToResume === true
            && hasResetElapsed(resetAtMs, params.nowMs)
        );
    const checking = !ready && params.operationStatus === 'checking';
    const waiting = checking || (!ready && isActiveRecoveryStatus(params.recoveryState?.status));
    const checkNowSupported = params.checkNowSupported === true;
    const issueFingerprint = params.recoveryState?.issueFingerprint ?? buildIssueFingerprint(lastRuntimeIssue);
    const mode = resolvePrimaryAction({
        issue: lastRuntimeIssue,
        recoveryState: params.recoveryState,
        ready,
        waiting,
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
        ? params.translate('session.usageLimitRecovery.status.waiting')
        : temporaryThrottle
        ? params.translate('session.usageLimitRecovery.status.temporaryThrottle')
        : params.translate('session.usageLimitRecovery.status.ready');
    const tone = resolveBadgeTone(waiting);

    return {
        issueFingerprint,
        waiting,
        banner: {
            testID: 'session-usageLimit-recovery',
            actionTestID: actionTestIdForMode(mode),
            title,
            body,
            actionLabel,
            actionAccessibilityLabel: actionLabel,
            mode,
            secondaryActions: [
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
