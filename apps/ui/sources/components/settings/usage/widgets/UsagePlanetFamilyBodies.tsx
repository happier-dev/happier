import * as React from 'react';
import { View } from 'react-native';
import {
  UsageAgentMoons,
  UsageAroundThePeriod,
  UsageAtmosphere,
  UsageDaysOnSurface,
  UsageMachines,
  UsageNinetyPlanets,
  UsageProjects,
  UsageRingedByStreaks,
  UsageStreakThread,
  UsageWeeksSkyline,
} from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import type { UsageBodyProps } from './usageBodyKit';
import { useUsageChartHost } from './usageChartHost';
import {
  usageAtmosphereLabels,
  usageCalendarLabels,
  usageMachinesLabels,
  usageMoonsLabels,
  usageProjectsLabels,
  usageRingsLabels,
  usageSurfaceLabels,
} from './usageChartLabels';
import { projectUsagePlanetFamilyModels } from './usageChartModels';
import {
  UsageChartPending,
  UsageOrbitBody,
  useStyleCaption,
} from './UsageChartStyleBodies';

/**
 * The app's side of the calendar and planet-family bodies: one private producer (`projectUsagePlanetFamilyModels`)
 * feeds the shared bodies with the app's Agent identities, Brand planet and wording.
 */

export type UsageCalendarArtStyle =
  | 'ninetyPlanets'
  | 'streakThread'
  | 'weeksSkyline'
  | 'daysOnSurface'
  | 'ringedStreaks'
  | 'aroundPeriod';
export const USAGE_CALENDAR_ART_STYLES: readonly UsageCalendarArtStyle[] = [
  'ninetyPlanets',
  'streakThread',
  'weeksSkyline',
  'daysOnSurface',
  'ringedStreaks',
  'aroundPeriod',
];
export function isUsageCalendarArtStyle(
  style: string | undefined,
): style is UsageCalendarArtStyle {
  return (
    style !== undefined &&
    (USAGE_CALENDAR_ART_STYLES as readonly string[]).includes(style)
  );
}

/** The Style's own name, shared with its option in the Style input. */
const CALENDAR_STYLE_NAME = {
  ninetyPlanets: 'usage.board.charts.inputPlanets',
  streakThread: 'usage.board.charts.inputThread',
  weeksSkyline: 'usage.board.charts.inputSkyline',
  daysOnSurface: 'usage.board.charts.inputSurface',
  ringedStreaks: 'usage.board.charts.inputRings',
  aroundPeriod: 'usage.board.charts.inputPeriodOrbit',
} as const satisfies Record<UsageCalendarArtStyle, string>;

function usePlanetFamilyModels(props: UsageBodyProps) {
  const calendar = props.slice.howYouWork?.agentCalendar ?? null;
  return React.useMemo(
    () =>
      calendar
        ? projectUsagePlanetFamilyModels(calendar, props.slice, Date.now())
        : null,
    [calendar, props.slice],
  );
}

function Pending(props: UsageBodyProps) {
  return (
    <UsageChartPending
      slice={props.slice}
      onRetry={props.model.refresh}
      testID={props.testID}
      title={t('usage.board.charts.needsDataTitle')}
      reason={t('usage.board.charts.needsCalendarReason')}
    />
  );
}

/** Rhythm · the calendar Styles: one model, several readings. */
export function UsageCalendarArtStyleBody(
  props: UsageBodyProps & Readonly<{ style: UsageCalendarArtStyle }>,
) {
  const styleName = t(CALENDAR_STYLE_NAME[props.style]);
  useStyleCaption(styleName);
  const host = useUsageChartHost(props.serverId);
  const models = usePlanetFamilyModels(props);
  if (!models) return <Pending {...props} />;
  const base = {
    theme: host.theme,
    paint: host.paint,
    model: models.calendarArt,
    renderPlanet: host.renderPlanet,
    testID: `${props.testID}.${props.style}`,
    label: styleName,
  };
  switch (props.style) {
    case 'ninetyPlanets':
      return (
        <UsageNinetyPlanets
          {...base}
          labels={usageCalendarLabels(props.query)}
        />
      );
    case 'streakThread':
      return (
        <UsageStreakThread
          {...base}
          labels={usageCalendarLabels(props.query)}
        />
      );
    case 'weeksSkyline':
      return (
        <UsageWeeksSkyline
          {...base}
          labels={usageCalendarLabels(props.query)}
        />
      );
    case 'aroundPeriod':
      return (
        <UsageAroundThePeriod
          {...base}
          labels={usageCalendarLabels(props.query)}
        />
      );
    case 'daysOnSurface':
      return (
        <UsageDaysOnSurface
          {...base}
          labels={usageSurfaceLabels(props.query)}
        />
      );
    case 'ringedStreaks':
      return (
        <UsageRingedByStreaks
          {...base}
          labels={usageRingsLabels(props.query)}
        />
      );
  }
}

/** Orbit · Style Moons. */
export function UsageMoonsBody(props: UsageBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const models = usePlanetFamilyModels(props);
  if (!models) return <Pending {...props} />;
  const agents = models.moons.agents.flatMap((member) =>
    member.agentId === null ? [] : [host.agent(member.agentId)],
  );
  return (
    <UsageAgentMoons
      theme={host.theme}
      paint={host.paint}
      model={models.moons}
      agents={agents}
      renderPlanet={host.renderPlanet}
      labels={usageMoonsLabels()}
      label={t('usage.widgets.usage_orbit')}
      testID={`${props.testID}.moons`}
    />
  );
}

export function UsageMachinesBody(props: UsageBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const models = usePlanetFamilyModels(props);
  if (!models) return <Pending {...props} />;
  return (
    <UsageMachines
      theme={host.theme}
      paint={host.paint}
      model={models.machines}
      renderPlanet={host.renderPlanet}
      labels={usageMachinesLabels()}
      label={t('usage.widgets.usage_machines')}
      testID={`${props.testID}.machines`}
    />
  );
}

export function UsageProjectsBody(props: UsageBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const models = usePlanetFamilyModels(props);
  if (!models) return <Pending {...props} />;
  return (
    <UsageProjects
      theme={host.theme}
      paint={host.paint}
      model={models.projects}
      labels={usageProjectsLabels()}
      label={t('usage.widgets.usage_projects')}
      testID={`${props.testID}.projects`}
    />
  );
}

export function UsageAtmosphereBody(props: UsageBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const models = usePlanetFamilyModels(props);
  if (!models?.atmosphere) return <Pending {...props} />;
  return (
    <View testID={`${props.testID}.atmosphere`}>
      <UsageAtmosphere
        theme={host.theme}
        paint={host.paint}
        model={models.atmosphere}
        renderPlanet={host.renderPlanet}
        labels={usageAtmosphereLabels(props.query)}
        label={t('usage.widgets.usage_atmosphere')}
        testID={`${props.testID}.atmosphereChart`}
      />
    </View>
  );
}

/** Orbit's own Style: the original orbit, or the same Agent mix as moons. */
export function UsageOrbitStyleBody(props: UsageBodyProps) {
  return props.presentation?.style === 'moons' ? (
    <UsageMoonsBody {...props} />
  ) : (
    <UsageOrbitBody {...props} />
  );
}
