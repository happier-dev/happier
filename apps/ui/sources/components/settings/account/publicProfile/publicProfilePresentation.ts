import * as React from 'react';
import type { HappierPublicProfileLabels, HappierPublicProfileUsageHost } from '@happier-dev/plugin-ui/presentation';
import type { PublicPeriod, PublicProfileSnapshotV1 } from '@happier-dev/protocol/account/publicProfile';
import type { PublicProfileContextV1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { usageAtmosphereLabels, usageCrewLabels, usageMachinesLabels, usageMoonsLabels, usageOrbitLabels, usagePlanetLabels, usageProjectsLabels,
  usageRingsLabels, usageShippedLabels, usageSkyLabels, usageSurfaceLabels, usagePublicOriginalLabels } from '@/components/settings/usage/widgets/usageChartLabels';
import { useUsageChartHost } from '@/components/settings/usage/widgets/usageChartHost';
import { formatUsageCalendarDate, formatUsageCalendarPeriod } from '@/sync/domains/usage/usageCalendarPresentation';
import { t } from '@/text';
import type { PublicProfilePeriod } from './publicProfileDraft';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';

/**
 * The page's labels; the title names the period the shown snapshot was prepared for. Until a snapshot exists, the
 * period line says why (`pendingLine`), once, for the whole page; the blocks keep their slots quietly.
 */
export function publicProfilePageLabels(context: PublicProfileContextV1, snapshot: PublicProfileSnapshotV1 | null,
  credit: string | null, chosenPeriod: PublicProfilePeriod, pendingLine?: string): HappierPublicProfileLabels {
  const period = snapshot?.period;
  const since = context.identity.sinceMs === undefined ? null : formatUsageCalendarDate(context.identity.sinceMs,
    period?.timeZoneOffsetMinutes ?? 0, { month: 'long', year: 'numeric' });
  const supporter = context.identity.supporter;
  const recurring = supporter?.recurring;
  const tenure = recurring ? t('publicIdentity.page.supportingForMonths', { count: recurring.months,
    since: formatUsageCalendarDate(recurring.sinceMonthMs, 0, { month: 'long', year: 'numeric' }) })
    : supporter?.sinceYear !== undefined ? t('publicIdentity.page.supporterSinceYear', { year: supporter.sinceYear }) : undefined;
  return {
    identityLine: [context.identity.name && context.handle ? `@${context.handle}` : null, context.service?.displayName ?? null,
      since ? t('publicIdentity.page.since', { date: since }) : null].filter(Boolean).join(' · '),
    ...(supporter ? { supporter: { label: t('publicIdentity.publicData.fields.supporter'), ...(tenure ? { tenure } : {}) } } : {}),
    periodTitle: formatUsageCalendarPeriod({ relative: chosenPeriod }),
    periodDetail: snapshot && period ? t('publicIdentity.page.periodDetail', { range: formatUsageCalendarPeriod(period),
      synced: formatRelativeTime(snapshot.computedAtMs) }) : pendingLine ?? '',
    emptyLayout: t('publicIdentity.page.empty'), footerNote: t('publicIdentity.page.footerNote'), report: t('publicIdentity.page.report'),
    madeWith: t('publicIdentity.page.madeWith'), inert: { success: t('publicIdentity.page.success'), warning: t('publicIdentity.page.warning'),
      error: t('publicIdentity.page.error'), incomplete: t('publicIdentity.page.incomplete') },
    ...(credit ? { heroCredit: credit } : {}),
  };
}

/** "happier.dev/@leeroy", "github.com/leeroy": the scheme adds nothing a person reads or types. */
export function publicProfileLinkLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** The same chart host and wording as private Usage, read against the public snapshot's calendar. */
export function usePublicProfileUsageHost(serverId: string, period: PublicPeriod | null): HappierPublicProfileUsageHost {
  const host = useUsageChartHost(serverId);
  const timeZoneOffsetMinutes = period?.timeZoneOffsetMinutes ?? 0;
  const periodLabel = period ? formatUsageCalendarPeriod(period) : '';
  return React.useMemo(() => {
    const query = { timeZoneOffsetMinutes };
    return { paint: host.paint, agent: host.agent, renderPlanet: host.renderPlanet,
      labels: {
        chartLabel: (widgetId) => t(`usage.widgets.${widgetId}`), unavailable: t('publicIdentity.page.blockUnavailable'),
        original: usagePublicOriginalLabels(query, periodLabel),
        sky: usageSkyLabels({ query, metricName: t('publicIdentity.page.activityLevel'), formatValue: value => String(value), colourBy: 'intensity' }),
        crew: usageCrewLabels(null), orbit: usageOrbitLabels(), planet: usagePlanetLabels(), shipped: usageShippedLabels(query, 'accent'),
        calendar: { ...usageSurfaceLabels(query), noRuns: usageRingsLabels(query).noRuns }, moons: usageMoonsLabels(),
        machines: usageMachinesLabels(), projects: usageProjectsLabels(), atmosphere: usageAtmosphereLabels(query),
      },
    };
  }, [host.paint, host.agent, host.renderPlanet, timeZoneOffsetMinutes, periodLabel]);
}
