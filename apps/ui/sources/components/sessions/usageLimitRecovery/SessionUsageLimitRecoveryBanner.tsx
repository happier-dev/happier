import * as React from 'react';
import { ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER } from '@/components/settings/connectedServices/account/accountBlockFormatters';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatResetCountdown, readResetCountdownWakeAtMs } from '@/sync/domains/connectedServices/formatResetCountdown';
import { formatMoment } from '@/utils/datetime/formatMoment';

const ALWAYS_FOCUSED = Object.freeze({ get: () => true, subscribe: () => () => {} });
import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { DisclosedCodeText, useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { presentSessionRuntimeIssue, presentSessionStartupFailureCause, type SessionActivationFailureRecovery } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { nowServerMs } from '@/sync/runtime/time';
import { t } from '@/text';
import { useHostActivelyViewed as useViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useUsageLimitAccountLabel } from './useUsageLimitAccountLabel';

type Props = React.ComponentProps<typeof WarningActionBanner> & Readonly<{
    temporaryThrottle?: Readonly<{ nextCheckAtMs: number | null; attemptCount: number }>;
    quotaRetryAtMs?: number | null;
    /** The surface's focus, followed by subscription; the countdown ticks only while focused. Absent means focused. */
    surfaceFocus?: Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;
    runtimeIssue?: SessionRuntimeIssueV1 | null;
    onUseAnotherAccount?: () => void;
    accountRecoveryIsPrimary?: boolean;
    /** The Session presenter's recovery for input blocked behind this limit; the card offers it, not a second line. */
    deliveryRecovery?: SessionActivationFailureRecovery | null;
    /** The limited account's name, said with its reset in the description. */
    accountLabel?: string | null;
}>;

// The clock subscription belongs to this leaf; a tick never rerenders SessionView or its transcript.
export function SessionUsageLimitRecoveryBanner({ temporaryThrottle, quotaRetryAtMs = null, surfaceFocus = ALWAYS_FOCUSED, runtimeIssue, onUseAnotherAccount, accountRecoveryIsPrimary, deliveryRecovery, accountLabel, ...props }: Props) {
    const issue = presentSessionRuntimeIssue(runtimeIssue);
    // The title owns the limit; a cause line only adds a localized cause, never the runtime's generic preview.
    const localizedCause = runtimeIssue ? presentSessionStartupFailureCause(runtimeIssue.code, runtimeIssue) : null;
    const accountRecoveryLabel = issue.recovery
        ?? (deliveryRecovery === 'choose_account' ? t('session.pendingActivation.actions.chooseAccount') : null);
    const disclosure = useCoreDisclosureToggleBinding();
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const viewed = useViewed();
    const focused = React.useSyncExternalStore(surfaceFocus.subscribe, surfaceFocus.get, surfaceFocus.get);
    const overloadDeadline = temporaryThrottle?.nextCheckAtMs ?? null;
    const deadline = overloadDeadline ?? quotaRetryAtMs;
    const serverOffsetMs = nowServerMs() - Date.now();
    const readNextWake = React.useCallback((localNowMs: number) => {
        if (deadline === null) return null;
        const remainingMs = deadline - (localNowMs + serverOffsetMs);
        if (remainingMs <= 0) return null;
        if (overloadDeadline !== null) return localNowMs + (remainingMs % 1_000 || 1_000);
        const nextWakeAtMs = readResetCountdownWakeAtMs(localNowMs + serverOffsetMs, deadline);
        return nextWakeAtMs === null ? null : nextWakeAtMs - serverOffsetMs;
    }, [deadline, overloadDeadline, serverOffsetMs]);
    const localNowMs = useSessionListRuntimeDeadlineNowMs(readNextWake,
        viewed && focused && deadline !== null && deadline > nowServerMs());
    const nowMs = localNowMs + serverOffsetMs;
    const seconds = overloadDeadline === null ? 0 : Math.max(0, Math.ceil((overloadDeadline - nowMs) / 1_000));
    const attempt = (temporaryThrottle?.attemptCount ?? 0) + (overloadDeadline !== null ? 1 : 0);
    const quotaDuration = quotaRetryAtMs !== null && quotaRetryAtMs > nowMs
        ? formatResetCountdown(nowMs, quotaRetryAtMs, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER)
        : null;
    const retryBody = quotaRetryAtMs !== null && quotaDuration !== null
        ? t('session.usageLimitRecovery.banner.retryAt', { time: formatMoment(quotaRetryAtMs, nowMs), duration: quotaDuration })
        : props.body;
    const accountLine = [accountLabel ? t('session.usageLimitRecovery.banner.accountReached', { account: accountLabel }) : null, issue.reset]
        .filter(Boolean).join(' · ');
    const body = [localizedCause !== props.title ? localizedCause : null, accountLine, retryBody].filter(Boolean).join('\n');
    // One primary and one secondary: the account recovery when offered, else the first recovery the caller
    // ranked. The quiet Hide is the composer banner's own dismissal, not a recovery.
    const accountAction = accountRecoveryLabel && onUseAnotherAccount && !accountRecoveryIsPrimary ? {
        key: 'use-another-account', label: accountRecoveryLabel, accessibilityLabel: accountRecoveryLabel,
        testID: `${props.testID}-switch-account`, disabled: props.disabled, onPress: onUseAnotherAccount,
    } : null;
    const callerActions = props.secondaryActions ?? [];
    const recoveryActions = callerActions.filter(action => action.key !== 'hide');
    const secondaryActions = [...callerActions.filter(action => action.key === 'hide'),
        ...(accountAction ? [accountAction] : recoveryActions.slice(0, 1))];
    return <WarningActionBanner
        {...props}
        content={<>{props.content}{issue.details ? <>
            <HappierDisclosureToggle testID={`${props.testID}-details-toggle`} label={t('common.details')}
                open={detailsOpen} onPress={() => setDetailsOpen(open => !open)}
                caret={disclosure.renderCaret(detailsOpen)} renderLabel={disclosure.renderLabel} focusColor={disclosure.focusColor} />
            {detailsOpen ? <DisclosedCodeText testID={`${props.testID}-details-code`}>{issue.details}</DisclosedCodeText> : null}
        </> : null}</>}
        onActionPress={accountRecoveryIsPrimary && onUseAnotherAccount ? onUseAnotherAccount : props.onActionPress}
        secondaryActions={secondaryActions}
        title={overloadDeadline !== null && seconds > 0
            ? t('session.usageLimitRecovery.overloadCountdown', { seconds, attempt })
            : props.title}
        body={temporaryThrottle && seconds === 0 && attempt > 0
            ? `${body} · ${t('session.usageLimitRecovery.overloadAttempt', { attempt })}`
            : body}
    />;
}

/**
 * The card as the Session mounts it: the limited account is named by the shared target presenter here,
 * in the leaf that exists only while the card shows.
 */
export function SessionUsageLimitRecoveryCard({ serverId, ...props }: Omit<Props, 'accountLabel'> & Readonly<{ serverId: string | null | undefined }>) {
    const accountLabel = useUsageLimitAccountLabel(props.runtimeIssue, serverId);
    return <SessionUsageLimitRecoveryBanner {...props} accountLabel={accountLabel} />;
}
