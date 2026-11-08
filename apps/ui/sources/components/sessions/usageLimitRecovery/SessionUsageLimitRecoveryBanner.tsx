import * as React from 'react';
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
    surfaceFocused: boolean;
    runtimeIssue?: SessionRuntimeIssueV1 | null;
    onUseAnotherAccount?: () => void;
    accountRecoveryIsPrimary?: boolean;
    /** The Session presenter's recovery for input blocked behind this limit; the card offers it, not a second line. */
    deliveryRecovery?: SessionActivationFailureRecovery | null;
    /** The limited account's name, said with its reset in the description. */
    accountLabel?: string | null;
}>;

// The clock subscription belongs to this leaf; a tick never rerenders SessionView or its transcript.
export function SessionUsageLimitRecoveryBanner({ temporaryThrottle, surfaceFocused, runtimeIssue, onUseAnotherAccount, accountRecoveryIsPrimary, deliveryRecovery, accountLabel, ...props }: Props) {
    const issue = presentSessionRuntimeIssue(runtimeIssue);
    // The title owns the limit; a cause line only adds a localized cause, never the runtime's generic preview.
    const localizedCause = runtimeIssue ? presentSessionStartupFailureCause(runtimeIssue.code, runtimeIssue) : null;
    const accountRecoveryLabel = issue.recovery
        ?? (deliveryRecovery === 'choose_account' ? t('session.pendingActivation.actions.chooseAccount') : null);
    const disclosure = useCoreDisclosureToggleBinding();
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const viewed = useViewed();
    const deadline = temporaryThrottle?.nextCheckAtMs ?? null;
    const enabled = viewed && surfaceFocused && deadline !== null;
    const readSeconds = React.useCallback(() => deadline === null ? 0 : Math.max(0, Math.ceil((deadline - nowServerMs()) / 1_000)), [deadline]);
    const subscribe = React.useCallback((notify: () => void) => {
        if (!enabled || readSeconds() === 0) return () => {};
        const timer = setInterval(() => {
            notify();
            if (readSeconds() === 0) clearInterval(timer);
        }, 1_000);
        return () => clearInterval(timer);
    }, [enabled, readSeconds]);
    const seconds = React.useSyncExternalStore(subscribe, readSeconds, readSeconds);
    const attempt = (temporaryThrottle?.attemptCount ?? 0) + (deadline !== null ? 1 : 0);
    const accountLine = [accountLabel ? t('session.usageLimitRecovery.banner.accountReached', { account: accountLabel }) : null, issue.reset]
        .filter(Boolean).join(' · ');
    const body = [localizedCause !== props.title ? localizedCause : null, accountLine, props.body].filter(Boolean).join('\n');
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
        title={deadline !== null && seconds > 0
            ? t('session.usageLimitRecovery.overloadCountdown', { seconds, attempt })
            : props.title}
        body={temporaryThrottle && (deadline === null || seconds === 0) && attempt > 0
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
