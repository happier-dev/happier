import * as React from 'react';
import { SessionWarningActionBanner } from '@/components/sessions/shell/SessionWarningActionBanner';
import { nowServerMs } from '@/sync/runtime/time';
import { t } from '@/text';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { isTauriMainWindowActivelyViewed } from '@/desktop/window/isTauriMainWindowActivelyViewed';
import { useDeadlineSeconds } from '@/hooks/time/useDeadlineSeconds';
import { formatResetCountdown } from '@/sync/domains/connectedServices/formatResetCountdown';
import { QUOTA_RESET_COUNTDOWN_FORMATTER } from '@/components/settings/connectedServices/useLiveQuotaMeterLabel';
import type { SessionUsageLimitRecoveryBannerPresentation } from './sessionUsageLimitRecoveryPresentation';

function readViewed() { return isRuntimeActive() && (!isTauriDesktop() || isTauriMainWindowActivelyViewed()); }
function useViewed() { return React.useSyncExternalStore(subscribeToRuntimeActiveChange, readViewed, readViewed); }

type Props = React.ComponentProps<typeof SessionWarningActionBanner> & Readonly<{
    temporaryThrottle?: Readonly<{ nextCheckAtMs: number | null; attemptCount: number }>;
    quotaWait?: SessionUsageLimitRecoveryBannerPresentation['quotaWait'];
    surfaceFocused: boolean;
}>;

// The clock subscription belongs to this leaf; a tick never rerenders SessionView or its transcript.
export function SessionUsageLimitRecoveryBanner({ temporaryThrottle, quotaWait, surfaceFocused, ...props }: Props) {
    const viewed = useViewed();
    const overloadDeadline = temporaryThrottle?.nextCheckAtMs ?? null;
    const deadline = overloadDeadline ?? quotaWait?.deadlineMs ?? null;
    const seconds = useDeadlineSeconds(deadline, viewed && surfaceFocused, nowServerMs, !temporaryThrottle);
    const quotaDuration = quotaWait && seconds > 0
        ? formatResetCountdown(0, seconds * 1_000, QUOTA_RESET_COUNTDOWN_FORMATTER)
        : null;
    const attempt = (temporaryThrottle?.attemptCount ?? 0) + (overloadDeadline !== null ? 1 : 0);
    return <SessionWarningActionBanner
        {...props}
        title={overloadDeadline !== null && seconds > 0
            ? t('session.usageLimitRecovery.overloadCountdown', { seconds, attempt })
            : props.title}
        body={temporaryThrottle && (overloadDeadline === null || seconds === 0) && attempt > 0
            ? `${props.body ?? ''} · ${t('session.usageLimitRecovery.overloadAttempt', { attempt })}`
            : quotaDuration && quotaWait ? quotaWait.renderBody(quotaDuration) : props.body}
    />;
}
