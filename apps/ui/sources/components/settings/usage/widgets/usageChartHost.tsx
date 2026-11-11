import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  usagePlanetMeridianWeight,
  type UsageChartAgent,
  type UsageChartPaint,
  type UsageChartValuesLabels,
  type UsagePlanetSlot,
  type UsagePlanetSpec,
} from '@happier-dev/plugin-ui/presentation';
import {
  createPlanetScene,
  planetLightForProgress,
} from '@happier-dev/brand/planet';
import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { getPreferredLanguage, t } from '@/text';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';
import { resolveUsageCalendarDateStart } from '@happier-dev/protocol/usage/usageCalendar';
import type {
  UsageQuery,
  UsagePresentationMetric,
} from '@happier-dev/protocol/inputs/usageQuery';
import { usageSignatureAccent } from '../usageAccent';
import {
  UsageAgentMark,
  usageAgentTitle,
  useUsagePluginTheme,
} from './usageBodyKit';
import { formatUsageDuration } from './usageHowYouWorkPresentation';
export {
  formatUsageChartClock as usageChartClock,
  formatUsageSharePercent as usageChartPercent,
} from '@happier-dev/protocol/usage/usageFormatting';

/**
 * The app's side of the shared Usage chart bodies: Agent identities from the catalog, the Usage accent and card
 * paper, the Brand planet through the canonical planet canvas, and localized wording. Bodies stay pure.
 */
export function useUsageChartHost(serverId: string | null): {
  theme: ReturnType<typeof useUsagePluginTheme>;
  paint: UsageChartPaint;
  agent: (agentId: string) => UsageChartAgent;
  renderPlanet: UsagePlanetSlot;
} {
  const { theme } = useUnistyles();
  const pluginTheme = useUsagePluginTheme();
  const paint = React.useMemo<UsageChartPaint>(
    () => ({
      accent: usageSignatureAccent(theme),
      paper: theme.colors.surface.base,
      dark: theme.dark,
    }),
    [theme],
  );
  const agent = React.useCallback(
    (agentId: string): UsageChartAgent => ({
      id: agentId,
      name: usageAgentTitle(agentId),
      color: getAgentIdentityColor(theme, agentId),
      mark: <UsageAgentMark agentId={agentId} serverId={serverId} size={16} />,
    }),
    [theme, serverId],
  );
  const renderPlanet = React.useCallback<UsagePlanetSlot>(
    (spec) => <UsageChartPlanet spec={spec} dark={theme.dark} />,
    [theme.dark],
  );
  return { theme: pluginTheme, paint, agent, renderPlanet };
}

/** A chart's Brand planet: the canonical planet canvas, a phase mark at small sizes, or the planet with data on its surface. */
function UsageChartPlanet({
  spec,
  dark,
}: Readonly<{ spec: UsagePlanetSpec; dark: boolean }>) {
  const theme = dark ? 'dark' : 'light';
  const light =
    spec.light === undefined ? undefined : planetLightForProgress(spec.light);
  const ink = spec.ink ? { ink: spec.ink } : {};
  const meridianKey = spec.meridians?.join(',');
  const scene = React.useMemo(() => {
    if (!meridianKey) return null;
    const base = createPlanetScene({
      theme,
      R: spec.radius,
      cx: spec.size / 2,
      cy: spec.size / 2,
      view: { w: spec.size, h: spec.size },
      rotate: spec.rotate,
      mirror: false,
      fullness: 1,
      halo: 0,
      tail: 0,
      style: spec.style,
      field: { around: 0, over: 0 },
      ...(light ? { light } : {}),
    });
    return {
      ...base,
      haze: [],
      body: base.body.map((dot) => ({
        ...dot,
        opacity: dot.opacity * usagePlanetMeridianWeight(spec, dot.x),
      })),
    };
    // The meridian weights are value-keyed; the spec object is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    meridianKey,
    theme,
    spec.radius,
    spec.size,
    spec.rotate,
    spec.style,
    spec.light,
  ]);
  if (scene)
    return (
      <PlanetCanvas
        width={spec.size}
        height={spec.size}
        scene={scene}
        {...ink}
      />
    );
  if (spec.mark)
    return (
      <PlanetCanvas
        width={spec.size}
        height={spec.size}
        {...ink}
        mark={{
          size: spec.size,
          theme,
          halo: spec.halo,
          ...(light ? { light } : {}),
        }}
      />
    );
  return (
    <PlanetCanvas
      width={spec.size}
      height={spec.size}
      {...ink}
      options={{
        theme,
        R: spec.radius,
        cx: spec.size / 2,
        cy: spec.size / 2,
        view: { w: spec.size, h: spec.size },
        rotate: spec.rotate,
        mirror: false,
        fullness: spec.night ?? 0,
        halo: spec.halo,
        tail: spec.tail,
        rise: spec.rise,
        style: spec.style,
        field: { around: 0, over: 0 },
        ...(light ? { light } : {}),
      }}
    />
  );
}

export const usageChartValuesLabels = (): UsageChartValuesLabels => ({
  show: t('usage.board.charts.showValues'),
  hide: t('usage.board.charts.hideValues'),
});

/** "Jul", "Tue 18 Aug", "13 Jul" on the query's own calendar. */
export function usageChartDateLabels(
  query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>,
) {
  const offset = query.timeZoneOffsetMinutes ?? 0;
  const at = (date: string) => resolveUsageCalendarDateStart(date, offset);
  const language = getPreferredLanguage();
  return {
    month: (date: string) =>
      formatUsageCalendarDate(at(date), offset, { month: 'short' }, language),
    day: (date: string) =>
      formatUsageCalendarDate(
        at(date),
        offset,
        { weekday: 'short', day: 'numeric', month: 'short' },
        language,
      ),
    short: (date: string) =>
      formatUsageCalendarDate(
        at(date),
        offset,
        { day: 'numeric', month: 'short' },
        language,
      ),
    weekday: (date: string) =>
      formatUsageCalendarDate(
        at(date),
        offset,
        { weekday: 'short', day: 'numeric' },
        language,
      ),
  };
}

/** Monday-first weekday names (the tide's rows). */
export function usageChartWeekdays(): readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
] {
  const name = (mondayIndex: number) =>
    formatUsageCalendarDate(Date.UTC(2024, 0, 1 + mondayIndex), 0, {
      weekday: 'short',
    });
  return [name(0), name(1), name(2), name(3), name(4), name(5), name(6)];
}

/** A presentation metric's value in its own unit; one formatter per unit, never another metric's. */
export type UsageChartMetric = UsagePresentationMetric;
export function formatUsageChartMetric(
  metric: UsageChartMetric,
  value: number,
): string {
  switch (metric) {
    case 'tokens':
      return formatTokenCount(value);
    case 'cost':
      return formatUsageCost(value, 'USD');
    case 'busy':
      return formatUsageDuration(value);
    case 'sessions':
      return t('usage.board.charts.sessionsCount', {
        count: Math.round(value),
      });
    case 'steering':
      return t('usage.board.charts.steersCount', { count: Math.round(value) });
    case 'peakParallel':
      return t('usage.board.charts.atOnceCount', { count: Math.round(value) });
  }
}

export function usageChartMetricName(metric: UsageChartMetric): string {
  return t(`usage.board.charts.metric_${metric}`);
}
