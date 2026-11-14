import type { UsageAgentShare, UsageConstellationModel, UsageRiverModel, UsageShippedModel } from './UsageAgentsCharts.js';
import type { UsageDaylightModel, UsageWeekHourModel } from './UsageRhythmEncodings.js';
import type { UsageSkyModel } from './UsageSkyOfDays.js';
import type { UsagePortraitModel, UsageRunLengthModel } from './UsageWorkCharts.js';

/** Display facts supplied by the caller, with no query or disclosure policy. */
export type UsageChartCoverage = Readonly<{
  status: 'complete_for_supplied_facts' | 'partial' | 'unknown' | 'unavailable';
  method: 'runtime' | 'logs' | 'context_only' | 'mixed' | 'unknown';
}>;
export type UsageChartPeriod = Readonly<{ startMs: number; endMs: number; timeZoneOffsetMinutes: number }>;

/** Shared private/public calendar art: ordinal levels only, never daily amounts or Agent winners. */
export type UsageCalendarArtModel = Readonly<{
  period: UsageChartPeriod;
  days: readonly Readonly<{ date: string; level: 0 | 1 | 2 | 3 | 4 | null }>[];
  /** Numeric annotations are independent of the calendar, which itself reveals run positions. */
  currentStreakDays?: number;
  bestStreakDays?: number;
}>;
export type UsageNinetyPlanetsModel = UsageCalendarArtModel;
export type UsageStreakThreadModel = UsageCalendarArtModel;
export type UsageDaysOnSurfaceModel = UsageCalendarArtModel;
export type UsageRingedStreaksModel = UsageCalendarArtModel;
export type UsageAroundPeriodModel = UsageCalendarArtModel;
/** The shared skyline body arranges these ordinal days into calendar weeks, retaining unknown marks. */
export type UsageWeeksSkylineModel = UsageCalendarArtModel;
export type UsageMoonsModel = Readonly<{
  agents: readonly UsageAgentShare[];
  /** Phase denominator is the public period's calendar-day count, never a hidden activeDays value. */
  periodDays: number;
}>;
export type UsageMachinesModel = Readonly<{
  /** Null is unavailable evidence, [] is a witnessed empty population; no machine identities. */
  kinds: readonly Readonly<{ kind: string; count: number; agentTimeShare: number; coverage: UsageChartCoverage }>[] | null;
  coverage: UsageChartCoverage;
}>;
export type UsageProjectsModel = Readonly<{
  /** Already SCM-admitted links only. Equal stars carry no per-project metric. */
  links: readonly Readonly<{ label: string; url: string }>[] | null;
}>;
export type UsageAtmosphereModel = Readonly<{
  weeks: readonly Readonly<{ startMs: number; endMs: number; peak: number; coverage: UsageChartCoverage }>[];
  /** Absent means no separately disclosed period figure, not zero. */
  peakParallel?: number;
}>;
/** Same anonymous observations/distribution as Run length, without private chronological order. */
export type UsageGalaxyModel = UsageRunLengthModel;

export type PublicUsageRecordKind = 'activeDays' | 'currentStreakDays' | 'bestStreakDays' | 'peakParallel' | 'longestTurnMs';

export type PublicUsageChartModels = Readonly<{
  /** Null is shared but unavailable evidence; an absent key is not shared. */
  summary: Readonly<Partial<Record<'tokens' | 'activeDays' | 'agentTimeMs' | 'mergedPrs' | 'currentStreakDays' | 'bestStreakDays' | 'peakParallel', number | null>>>;
  tokensFromParts?: true;
  coverage: UsageChartCoverage;
  highlights: readonly Readonly<{ kind: 'merged_prs' | 'peak_parallel' | 'active_days'; count: number }>[] | null;
  footprint: Readonly<{ accountedTokens?: number; tokensFromParts?: true }> | null;
  sourceShares: readonly Readonly<{ execution: 'happier' | 'outside' | 'unknown'; share: number; tokens?: number; tokensFromParts?: true }>[] | null;
  agentMix: readonly Readonly<{ agentId: string; share: number; tokens?: number; tokensFromParts?: true; coverage: UsageChartCoverage }>[] | null;
  sky: UsageSkyModel | null;
  weekHours: UsageWeekHourModel | null;
  daylight: UsageDaylightModel | null;
  agentShares: readonly UsageAgentShare[] | null;
  river: UsageRiverModel | null;
  shipped: UsageShippedModel | null;
  constellation: UsageConstellationModel | null;
  portrait: UsagePortraitModel;
  runLength: UsageRunLengthModel | null;
  calendarArt: UsageCalendarArtModel | null;
  moons: UsageMoonsModel | null;
  machines: UsageMachinesModel;
  projects: UsageProjectsModel;
  atmosphere: UsageAtmosphereModel | null;
  galaxy: UsageGalaxyModel | null;
  /** Only the approved aggregate. There is no public day, lane, clock or peak attribution. */
  peak: number | null;
}>;
