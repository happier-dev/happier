import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { UsageMeterRow as PresentationUsageMeterRow } from '@happier-dev/plugin-ui/presentation';
import type { UsageMeterSize } from '@happier-dev/plugin-ui/presentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

import type { MeterTone } from '@/components/ui/lists/MeterBar';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { formatResetCountdown, formatResetCountdownPhrase, readResetCountdownWakeAtMs } from '@/sync/domains/connectedServices/formatResetCountdown';
import { t } from '@/text';
import { formatResetAtTime } from '@/utils/time/formatResetAtTime';

import { ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER } from '../account/accountBlockFormatters';

export { UsageMeterStack, USAGE_METER_METRICS, type UsageMeterSize } from '@happier-dev/plugin-ui/presentation';

export type UsageMeterRowProps = Readonly<{
    /** The window's name as the provider reports it ("5-hour", "Weekly"). */
    label: string;
    /** What is left, 0–100, or null when the provider reported nothing for the window. */
    remainingPct: number | null;
    resetsAt: number | null;
    /** From `resolveQuotaTone`/`resolveQuotaMeterTone`, the one threshold owner. */
    tone: MeterTone;
    /** A fixed time for specimens and snapshots. Visible live meters use the shared clock. */
    now?: number;
    /** The value is still being read: the row keeps its place with a quiet placeholder. */
    loading?: boolean;
    /**
     * `inline` (default): one line — name, bar, what is left, reset time — in the shared columns.
     * `stacked`: for a narrow card (Home's usage grid): name and what is left above the bar, then
     * "resets …" beneath it.
     */
    layout?: 'inline' | 'stacked';
    /** Column widths for where the meter sits; `wide` also names the clock time of the reset. */
    size?: UsageMeterSize;
    /** A pool's aggregate reads "next in …": the earliest of its members' resets. */
    resetPrefix?: 'next';
    /** A window without a countdown names its period instead ("monthly"). */
    resetText?: string;
    /**
     * An amount the provider reported ("$4.20", "$7.00 of $10.00 left"), shown in place of "% left". `null`
     * means it reported none, which reads as unavailable. An amount without `remainingPct` has no cap, so the
     * row draws no bar at all rather than an empty one that would read as exhausted.
     */
    amount?: string | null;
    /** The provider estimated the value: it reads "~58% left". */
    estimated?: boolean;
    /**
     * The B pace owner's facts on this meter's own "left" axis: a tick where an even pace would leave
     * the window now, and the share this pace uses before the reset drawn hatched. Absent means none.
     */
    pace?: Readonly<{ evenPaceRemainingFraction: number; projectedRemainingFraction: number }>;
    testID?: string;
}>;

/** Domain adapter: quota facts and localized wording stay with connected services. */
export const UsageMeterRow = React.memo(function UsageMeterRow(props: UsageMeterRowProps) {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const known = props.remainingPct !== null && Number.isFinite(props.remainingPct);
    const remaining = known ? Math.max(0, Math.min(100, Math.round(props.remainingPct!))) : null;
    const left = remaining !== null
        ? ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER.remaining({ percent: `${remaining}%` })
        : null;
    const amountMode = props.amount !== undefined;
    const valueKnown = amountMode ? props.amount !== null : left !== null;
    const reported = amountMode ? props.amount ?? null : left;
    const value = reported === null
        ? t('common.unavailable')
        : props.estimated ? t('connectedServicesCollection.meterEstimated', { value: reported }) : reported;
    const viewed = useHostActivelyViewed();
    const presented = useLayoutPresentationActive();
    const deadline = props.loading || props.resetText !== undefined ? null : props.resetsAt;
    const readNextWake = React.useCallback((nowMs: number) => readResetCountdownWakeAtMs(nowMs, deadline), [deadline]);
    const clockNow = useSessionListRuntimeDeadlineNowMs(readNextWake,
        props.now === undefined && viewed && presented && deadline !== null && deadline >= Date.now());
    const now = props.now ?? clockNow;
    const countdown = formatResetCountdown(now, props.resetsAt, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER);
    const relative = formatResetCountdownPhrase(now, props.resetsAt, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER, (time) =>
        props.resetPrefix === 'next'
            ? t('connectedServicesCollection.meterNextResetIn', { time })
            : t('connectedServicesCollection.meterResetsIn', { time }));
    const resetAt = props.resetText ?? relative ?? '';
    const wideResetAt = props.resetText ?? (props.size === 'wide' && relative !== null && props.resetsAt !== null
        ? t('connectedServicesCollection.meterResetsAt', { countdown: relative, time: formatResetAtTime(props.resetsAt, now) })
        : resetAt);
    const paceLabel = props.pace && remaining !== null ? t('usage.board.plans.meterPaceAccessibility', {
        even: `${Math.round(props.pace.evenPaceRemainingFraction * 100)}%`,
        projected: `${Math.round(props.pace.projectedRemainingFraction * 100)}%`,
    }) : null;
    const baseAccessibilityLabel = props.loading
        ? props.label
        : !amountMode && remaining !== null && countdown
        ? [props.label, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER.remainingWithReset({ percent: `${remaining}%`, reset: countdown }), props.resetText].filter(Boolean).join(', ')
        : `${props.label}, ${value}${resetAt ? `, ${resetAt}` : ''}`;
    const accessibilityLabel = paceLabel ? `${baseAccessibilityLabel}; ${paceLabel}` : baseAccessibilityLabel;
    const wideAccessibilityLabel = !props.loading && (amountMode || remaining === null || !countdown)
        ? `${props.label}, ${value}${wideResetAt ? `, ${wideResetAt}` : ''}${paceLabel ? `; ${paceLabel}` : ''}`
        : accessibilityLabel;
    return <PresentationUsageMeterRow theme={presentationTheme} label={props.label} remainingPct={remaining}
        value={value} valueKnown={valueKnown} amount={amountMode} resetText={resetAt} wideResetText={wideResetAt}
        accessibilityLabel={accessibilityLabel} wideAccessibilityLabel={wideAccessibilityLabel}
        tone={props.tone} loading={props.loading} layout={props.layout} size={props.size} pace={props.pace}
        neutralFillColor={theme.colors.state.neutral.foreground}
        trackColor={theme.dark ? theme.colors.surface.pressedOverlay : theme.colors.border.default}
        placeholderColor={theme.colors.surface.pressedOverlay} testID={props.testID} />;
});
