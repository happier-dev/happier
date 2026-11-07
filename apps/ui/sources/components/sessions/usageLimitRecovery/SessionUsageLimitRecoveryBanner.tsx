import * as React from 'react';
import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { DisclosedCodeText, useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { presentSessionRuntimeIssue } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { nowServerMs } from '@/sync/runtime/time';
import { t } from '@/text';
import { useHostActivelyViewed as useViewed } from '@/utils/runtime/useHostActivelyViewed';

type Props = React.ComponentProps<typeof WarningActionBanner> & Readonly<{
    temporaryThrottle?: Readonly<{ nextCheckAtMs: number | null; attemptCount: number }>;
    surfaceFocused: boolean;
    runtimeIssue?: SessionRuntimeIssueV1 | null;
    onUseAnotherAccount?: () => void;
    accountRecoveryIsPrimary?: boolean;
}>;

// The clock subscription belongs to this leaf; a tick never rerenders SessionView or its transcript.
export function SessionUsageLimitRecoveryBanner({ temporaryThrottle, surfaceFocused, runtimeIssue, onUseAnotherAccount, accountRecoveryIsPrimary, ...props }: Props) {
    const issue = presentSessionRuntimeIssue(runtimeIssue);
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
    const body = [issue.cause !== props.title ? issue.cause : null, issue.reset, props.body].filter(Boolean).join('\n');
    return <WarningActionBanner
        {...props}
        content={<>{props.content}{issue.details ? <>
            <HappierDisclosureToggle testID={`${props.testID}-details-toggle`} label={t('common.details')}
                open={detailsOpen} onPress={() => setDetailsOpen(open => !open)}
                caret={disclosure.renderCaret(detailsOpen)} renderLabel={disclosure.renderLabel} focusColor={disclosure.focusColor} />
            {detailsOpen ? <DisclosedCodeText testID={`${props.testID}-details-code`}>{issue.details}</DisclosedCodeText> : null}
        </> : null}</>}
        onActionPress={accountRecoveryIsPrimary && onUseAnotherAccount ? onUseAnotherAccount : props.onActionPress}
        secondaryActions={issue.recovery && onUseAnotherAccount && !accountRecoveryIsPrimary ? [...(props.secondaryActions ?? []), {
            key: 'use-another-account', label: issue.recovery, accessibilityLabel: issue.recovery,
            testID: `${props.testID}-switch-account`, disabled: props.disabled, onPress: onUseAnotherAccount,
        }] : props.secondaryActions}
        title={deadline !== null && seconds > 0
            ? t('session.usageLimitRecovery.overloadCountdown', { seconds, attempt })
            : props.title}
        body={temporaryThrottle && (deadline === null || seconds === 0) && attempt > 0
            ? `${body} · ${t('session.usageLimitRecovery.overloadAttempt', { attempt })}`
            : body}
    />;
}
