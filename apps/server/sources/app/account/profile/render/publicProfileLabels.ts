import { formatTokenCount, formatTokenCountLong, formatUsageCalendarDate, formatUsageCalendarRange,
    formatUsageDurationCompact } from '@happier-dev/protocol/usage/usageFormatting';
import type { PublicProfileReadResultV1, PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { PUBLIC_PROFILE_FIELD_COPY_EN, PUBLIC_PROFILE_PAGE_COPY_EN } from '@happier-dev/protocol/account/publicProfilePublication';
import { USAGE_RELATIVE_PERIOD_LABELS_EN } from '@happier-dev/protocol/inputs/usageQuery';
import type { HappierPublicProfileBrand, HappierPublicProfileLabels } from '@happier-dev/plugin-ui/presentation';
import type { PublicProfileAssetLabels, PublicProfileAssetMetric } from './publicProfileSvg';

/** Anonymous delivery has one explicit default locale, independent of the server OS. */
export const PUBLIC_PROFILE_LOCALE = 'en-US';
export const PUBLIC_PROFILE_STATE_LABELS = { paused: 'Profile paused', unavailable: 'Profile unavailable' } as const;
const metricLabels: Record<PublicProfileAssetMetric, string> = {
    tokens: 'tokens', 'agent-time': 'agent time', 'merged-prs': 'merged PRs', streak: 'day streak',
    'peak-parallel': 'peak parallel', 'active-days': 'active days',
};

function publicProfileSupporterLabels(supporter: NonNullable<PublicProfileViewV1['identity']['supporter']>) {
    const label = PUBLIC_PROFILE_FIELD_COPY_EN.supporter;
    const { recurring, sinceYear } = supporter;
    if (!recurring) return { label, tenure: sinceYear === undefined ? undefined : `Supporter since ${sinceYear}` };
    const date = formatUsageCalendarDate(recurring.sinceMonthMs, 0, { month: 'long', year: 'numeric' }, PUBLIC_PROFILE_LOCALE);
    return { label, tenure: `Supporting for ${recurring.months} ${recurring.months === 1 ? 'month' : 'months'} · since ${date}` };
}

export const PUBLIC_PROFILE_ASSET_LABELS: PublicProfileAssetLabels = {
    brand: 'Happier', ...PUBLIC_PROFILE_STATE_LABELS, empty: 'Public profile',
    supporter: identity => {
        const copy = publicProfileSupporterLabels(identity);
        if (identity.recurring && copy.tenure) return `${copy.label} · ${copy.tenure}`;
        return copy.tenure ?? copy.label;
    },
    period: period => formatUsageCalendarRange(period.startMs, period.endMs, period.timeZoneOffsetMinutes, PUBLIC_PROFILE_LOCALE),
    synced: computedAtMs => `Synced ${formatUsageCalendarDate(computedAtMs, 0, { year: 'numeric', month: 'short', day: 'numeric', timeZoneName: 'short' }, PUBLIC_PROFILE_LOCALE)}`,
    metricLabel: metric => metricLabels[metric],
    formatMetric: (metric, value) => metric === 'agent-time' ? formatUsageDurationCompact(value, PUBLIC_PROFILE_LOCALE)
        : metric === 'tokens' ? formatTokenCount(value) : formatTokenCountLong(value, PUBLIC_PROFILE_LOCALE),
};

/** Where "What is Happier?" leads from every visitor page, whichever service it is published on. */
export const PUBLIC_PROFILE_ABOUT_URL = 'https://happier.dev';

/** The visitor page's brand bar: Happier, the service the page is on, and what Happier is. */
export function publicProfileBrand(service: string | undefined): HappierPublicProfileBrand {
    return { name: 'Happier', ...(service ? { service } : {}), about: { label: 'What is Happier?', href: PUBLIC_PROFILE_ABOUT_URL } };
}

/** One page for not found, unpublished, removed and feature off, so a handle can't be probed (lab `ppstate-X`). */
export function publicProfileWithdrawalLabels(result: Exclude<PublicProfileReadResultV1, { kind: 'published' }>, service: string | undefined) {
    if (result.kind === 'unavailable') return { title: 'No public profile here',
        body: 'Profiles on Happier are opt-in and shared by link. This one doesn’t exist, or isn’t public.' };
    const name = result.identity.name ?? `@${result.handle}`;
    return { title: `${name} paused this profile`, body: `Its numbers come back when ${name} resumes it. Badges read “paused” until then.`,
        identityLine: [...(result.identity.name ? [`@${result.handle}`] : []), ...(service ? [service] : [])].join(' · ') };
}

/** How long ago the page's facts were prepared, in the app's English words and minute/hour/day steps. */
export function publicProfileSyncedAge(computedAtMs: number, nowMs: number): string {
    const minutes = Math.floor((nowMs - computedAtMs) / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;
    return minutes < 1 ? 'just now' : minutes < 60 ? plural(minutes, 'minute') : hours < 24 ? plural(hours, 'hour') : plural(days, 'day');
}

export function publicProfilePageLabels(view: PublicProfileViewV1, nowMs = Date.now()): HappierPublicProfileLabels {
    const copy = PUBLIC_PROFILE_PAGE_COPY_EN;
    const since = view.identity.sinceMs === undefined ? '' : ` · ${copy.since({ date: formatUsageCalendarDate(view.identity.sinceMs,
        view.snapshot.period.timeZoneOffsetMinutes, { month: 'long', year: 'numeric' }, PUBLIC_PROFILE_LOCALE) })}`;
    // The preset the owner chose names the period, as on the owner's page; a view without one keeps the neutral title.
    return { identityLine: `${view.identity.name ? `@${view.handle} · ` : ''}${view.service.displayName}${since}`,
        ...(view.identity.supporter ? { supporter: publicProfileSupporterLabels(view.identity.supporter) } : {}),
        periodTitle: view.relativePeriod ? USAGE_RELATIVE_PERIOD_LABELS_EN[view.relativePeriod] : 'Public activity',
        periodDetail: copy.periodDetail({ range: PUBLIC_PROFILE_ASSET_LABELS.period(view.snapshot.period),
            synced: publicProfileSyncedAge(view.snapshot.computedAtMs, nowMs) }),
        emptyLayout: copy.empty, footerNote: copy.footerNote, report: copy.report, madeWith: copy.madeWith,
        inert: { success: copy.success, warning: copy.warning, error: copy.error, incomplete: copy.incomplete } };
}
