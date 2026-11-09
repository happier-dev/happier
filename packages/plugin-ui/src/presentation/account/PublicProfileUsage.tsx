import type { ReactNode } from 'react';
import type { PublicProfileUsagePresentation } from '../../components/publicProfileTypes.js';

import { useHappierUiTheme } from '../../environment/context.js';
import { HappierText } from '../text/Text.js';
import type { PublicUsageRecordKind, PublicUsageChartModels } from '../usage/charts/publicUsageChartModels.js';
import type { UsageChartAgent, UsageChartPaint } from '../usage/charts/chartKit.js';
import type { UsagePlanetSlot } from '../usage/charts/usagePlanetSlot.js';
import { UsageSkyOfDays, type UsageSkyLabels } from '../usage/charts/UsageSkyOfDays.js';
import { UsageDayInAgents, type UsageDayLabels } from '../usage/charts/UsageDayInAgents.js';
import { UsageDaylight, UsageWeekTide, type UsageDaylightLabels, type UsageWeekTideLabels } from '../usage/charts/UsageRhythmEncodings.js';
import {
  UsageAgentRiver, UsageConstellation, UsageCrew, UsageOrbit, UsageShipped,
  type UsageConstellationLabels, type UsageCrewLabels, type UsageOrbitLabels, type UsageRiverLabels, type UsageShippedLabels,
} from '../usage/charts/UsageAgentsCharts.js';
import { UsagePersonalRecords, UsagePlanetPortrait, UsageRunLength, type UsagePortraitLabels, type UsageRecordsModel, type UsageRunLengthLabels } from '../usage/charts/UsageWorkCharts.js';
import {
  UsageAroundThePeriod, UsageDaysOnSurface, UsageNinetyPlanets, UsageRingedByStreaks, UsageStreakThread, UsageWeeksSkyline,
  type UsageCalendarLabels,
} from '../usage/charts/UsageCalendarForms.js';
import {
  UsageAgentMoons, UsageAtmosphere, UsageMachines, UsageProjects,
  type UsageAtmosphereLabels, type UsageMachinesLabels, type UsageMoonsLabels, type UsageProjectsLabels,
} from '../usage/charts/UsagePlanetFamily.js';
import { publicProfileUsageOriginalBody, type PublicUsageMetricId, type PublicUsageOriginalLabels } from './PublicProfileUsageOriginal.js';
export type { PublicUsageOriginalLabels, PublicUsageMetricId } from './PublicProfileUsageOriginal.js';

/** Host localization for the same chart bodies used by private Usage. */
export type HappierPublicProfileUsageLabels = Readonly<{
  chartLabel: (widgetId: PublicProfileUsagePresentation['widgetId']) => string;
  unavailable: string;
  original?: PublicUsageOriginalLabels;
  sky?: UsageSkyLabels;
  parallel?: UsageDayLabels;
  records?: Readonly<{ format: (kind: PublicUsageRecordKind, value: number) => Omit<UsageRecordsModel[number], 'id'>; caption: string }>;
  weekTide?: UsageWeekTideLabels;
  daylight?: UsageDaylightLabels;
  orbit?: UsageOrbitLabels;
  crew?: UsageCrewLabels;
  river?: UsageRiverLabels;
  shipped?: UsageShippedLabels;
  constellation?: UsageConstellationLabels;
  planet?: UsagePortraitLabels;
  runLength?: UsageRunLengthLabels;
  /** The calendar Styles (Ninety planets, Streak thread, Weeks, Around the period, Days on the surface, Rings). */
  calendar?: UsageCalendarLabels & Readonly<{ lit: (active: number, days: number) => string; noRuns: string }>;
  moons?: UsageMoonsLabels;
  machines?: UsageMachinesLabels;
  projects?: UsageProjectsLabels;
  atmosphere?: UsageAtmosphereLabels;
}>;

export type HappierPublicProfileUsageHost = Readonly<{
  paint: UsageChartPaint;
  agent: (agentId: string) => UsageChartAgent;
  renderPlanet?: UsagePlanetSlot;
  /**
   * The host cannot measure (the server's cold page): each placed block draws at the width its cell has in the
   * page column and scales down with a narrower window. Interactive hosts measure the body instead.
   */
  cold?: boolean;
  labels: HappierPublicProfileUsageLabels;
}>;

export type PublicProfileUsageBodyProps = Readonly<{
  presentation: PublicProfileUsagePresentation;
  /** Already projected by projectPublicProfile; this adapter has no policy or query authority. */
  models: PublicUsageChartModels;
  records: UsageRecordsModel | null;
  host: HappierPublicProfileUsageHost;
  /** The block's drawing width on a cold host, from its place in the page column. */
  width?: number;
  /** The owner's own page only: each figure's in-place control and which figures visitors don't see. */
  figures?: HappierPublicProfileFigureControls;
  testID: string;
}>;

/** Owner-only, per figure: the host renders the control and keeps consent with its one policy owner. */
export type HappierPublicProfileFigureControls = Readonly<{
  hidden: ReadonlySet<PublicUsageMetricId>;
  render: (figure: PublicUsageMetricId) => ReactNode;
}>;

/** A thin model/host adapter; shared Usage bodies own all chart markup and geometry. */
export function PublicProfileUsageBody({ presentation, models, records, host, width, figures, testID }: PublicProfileUsageBodyProps) {
  const theme = useHappierUiTheme();
  const { labels } = host;
  const base = { theme, paint: host.paint, width, label: labels.chartLabel(presentation.widgetId), testID };
  const agents = (ids: readonly (string | null)[]) => [...new Set(ids)].flatMap(id => id === null ? [] : [host.agent(id)]);
  const original = publicProfileUsageOriginalBody({ presentation, models, records, host, width, figures, testID }, theme);
  if (original) return original;
  switch (presentation.widgetId) {
    case 'usage_recap':
      if (presentation.inputs.style === 'personalRecords' && records?.length && labels.records)
        return <UsagePersonalRecords {...base} model={records} caption={labels.records.caption} />;
      break;
    case 'usage_parallel':
      if (models.peak !== null && labels.parallel) return <UsageDayInAgents {...base}
        model={{ kind: 'peakOnly', count: models.peak }} agents={[]} style="lanes" labels={labels.parallel} />;
      break;
    case 'usage_rhythm':
      switch (presentation.inputs.style) {
        case 'sky':
          if (models.sky && labels.sky) return <UsageSkyOfDays {...base} model={models.sky} labels={labels.sky} agents={[]} />;
          break;
        case 'weekTide':
          if (models.weekHours && labels.weekTide) return <UsageWeekTide {...base} model={models.weekHours} labels={labels.weekTide} />;
          break;
        case 'daylight':
          if (models.daylight && labels.daylight) return <UsageDaylight {...base} model={models.daylight} labels={labels.daylight} />;
          break;
        default:
          if (models.calendarArt && labels.calendar) {
            const calendar = { ...base, model: models.calendarArt, labels: labels.calendar, renderPlanet: host.renderPlanet };
            switch (presentation.inputs.style) {
              case 'ninetyPlanets': return <UsageNinetyPlanets {...calendar} />;
              case 'streakThread': return <UsageStreakThread {...calendar} />;
              case 'weeksSkyline': return <UsageWeeksSkyline {...calendar} />;
              case 'daysOnSurface': return <UsageDaysOnSurface {...calendar} />;
              case 'ringedStreaks': return <UsageRingedByStreaks {...calendar} />;
              case 'aroundPeriod': return <UsageAroundThePeriod {...calendar} />;
            }
          }
      }
      break;
    case 'usage_breakdowns':
      if (presentation.inputs.style === 'crew' && models.agentShares && labels.crew)
        return <UsageCrew {...base} model={models.agentShares} labels={labels.crew} agents={agents(models.agentShares.map(row => row.agentId))} />;
      break;
    case 'usage_orbit':
      if (presentation.inputs.style === 'moons') {
        if (models.moons && labels.moons) return <UsageAgentMoons {...base} model={models.moons} labels={labels.moons}
          agents={agents(models.moons.agents.map(row => row.agentId))} renderPlanet={host.renderPlanet} />;
        break;
      }
      if (models.agentShares && labels.orbit) return <UsageOrbit {...base} model={models.agentShares} labels={labels.orbit}
        agents={agents(models.agentShares.map(row => row.agentId))} renderPlanet={host.renderPlanet} />;
      break;
    case 'usage_flow':
      if (models.river && labels.river) return <UsageAgentRiver {...base} model={models.river} labels={labels.river}
        agents={agents(models.river.weeks.flatMap(week => week.shares.map(row => row.agentId)))} />;
      break;
    case 'usage_outcomes':
      if (presentation.inputs.style === 'shipped' && models.shipped && labels.shipped)
        return <UsageShipped {...base} model={models.shipped} labels={labels.shipped} agents={[]} />;
      break;
    case 'usage_constellation':
      if (models.constellation && labels.constellation) return <UsageConstellation {...base} model={models.constellation} labels={labels.constellation}
        agents={agents(models.constellation.nodes.map(row => row.agentId))} renderPlanet={host.renderPlanet} />;
      break;
    case 'usage_planet':
      if (labels.planet) return <UsagePlanetPortrait {...base} model={models.portrait} labels={labels.planet} renderPlanet={host.renderPlanet} />;
      break;
    case 'usage_machines':
      if (labels.machines) return <UsageMachines {...base} model={models.machines} labels={labels.machines} renderPlanet={host.renderPlanet} />;
      break;
    case 'usage_projects':
      if (labels.projects) return <UsageProjects {...base} model={models.projects} labels={labels.projects} />;
      break;
    case 'usage_atmosphere':
      if (models.atmosphere && labels.atmosphere) return <UsageAtmosphere {...base} model={models.atmosphere} labels={labels.atmosphere} renderPlanet={host.renderPlanet} />;
      break;
    case 'usage_run_length':
      if (models.runLength && labels.runLength) return <UsageRunLength {...base} model={models.runLength} labels={labels.runLength}
        agents={agents(models.runLength.rows.flatMap(row => row.agentId === null ? [] : [row.agentId]))} />;
      break;
  }
  return <HappierText variant="body" tone="secondary" testID={`${testID}-unavailable`}>{labels.unavailable}</HappierText>;
}
