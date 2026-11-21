/** English presentation defaults shared by anonymous profiles and the app's localized catalogs.
 * Copy only: no publication, field policy, layout or transport authority lives here. */
export const PUBLIC_PROFILE_PAGE_COPY_EN = {
  since: ({ date }: {
    date: string;
  }) => `since ${date}`,
  periodDetail: ({ range, synced }: {
    range: string;
    synced: string;
  }) => `${range} · synced ${synced}`,
  empty: 'No blocks placed yet.',
  footerNote: 'Only selected information is public. Shared usage excludes prompts, files, private repositories and costs.',
  report: 'Report',
  madeWith: 'Made with Happier',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
  incomplete: 'Incomplete',
  blockUnavailable: 'Not recorded for this period.',
  activityLevel: 'Activity level',
};
export const PUBLIC_PROFILE_FIELD_COPY_EN = {
  name: 'Name', avatar: 'Photo', bio: 'Bio', links: 'Links', since: 'Member since',
  tokens: 'Tokens', activeDays: 'Active days', agentTime: 'Agent hours', mergedPrs: 'Merged pull requests',
  currentStreak: 'Current streak', bestStreak: 'Best streak in this period', peakParallel: 'Peak parallel', highlights: 'Highlights',
  calendar: 'Activity levels', punch: 'Hours of the week', agentMix: 'Agent mix', sourceSplit: 'Where agents ran',
  agentActiveDays: 'Days per agent', weeklyAgentMix: 'Weekly agent mix', weeklyPeakParallel: 'Weekly peaks',
  sessionDurations: 'Turn lengths', machineKinds: 'Kinds of machines', dayNightActivity: 'Day and night',
  projects: 'Projects', footprint: 'Footprint',
};
/** Shared private Usage and public-profile chart wording. */
export const PUBLIC_USAGE_CHART_COPY_EN = {
  showValues: "Exact values",
  hideValues: "Hide values",
  atOnceCount: ({ count }: {
    count: string | number;
  }) => `${count} at once`,
  upToAtOnce: ({ count }: {
    count: string | number;
  }) => `Up to ${count} at once`,
  daysCount: ({ count }: {
    count: string | number;
  }) => `${count} ${Number(count) === 1 ? 'day' : 'days'}`,
  daysOf: ({ count, total }: {
    count: string | number;
    total: string | number;
  }) => `${count} of ${total} days`,
  dayStreak: ({ count }: {
    count: string | number;
  }) => `${count}-day streak`,
  levelQuiet: "Quiet",
  levelSteady: "Steady",
  levelBusy: "Busy",
  levelBusiest: "Busiest",
  quieter: "Quieter",
  busier: "Busier",
  tie: "Tie",
  notAttributed: "Not attributed",
  noActivity: "No activity",
  notRecorded: "Not recorded",
  unknownAgent: "Unknown agent",
  dateColumn: "Day",
  leaderColumn: "Led by",
  weekdayColumn: "Weekday",
  hourColumn: "Hour",
  agentColumn: "Agent",
  spansColumn: "Worked",
  skyCaptionIntensity: ({ runs, band }: {
    runs: boolean;
    band: boolean;
  }) => `Higher, larger and brighter is a busier day.${runs && band ? ' Faint lines join runs of five days or more; the soft band is the 7-day average.' : runs ? ' Faint lines join runs of five days or more.' : band ? ' The soft band is the 7-day average.' : ''}`,
  streakBestOngoing: ({ count }: {
    count: string | number;
  }) => `${count}-day streak · best this period, still going`,
  streakBest: ({ count }: {
    count: string | number;
  }) => `Best · ${count} ${Number(count) === 1 ? 'day' : 'days'}`,
  streakNow: ({ count }: {
    count: string | number;
  }) => `Now · ${count} ${Number(count) === 1 ? 'day' : 'days'}`,
  streakShort: ({ count }: {
    count: string | number;
  }) => `${count}-day streak`,
  streakShortBest: ({ count }: {
    count: string | number;
  }) => `${count}-day streak · best`,
  nightWindow: ({ window }: {
    window: string;
  }) => `Night · ${window}`,
  nightWindowShare: ({ window, share }: {
    window: string;
    share: string;
  }) => `Night · ${window} · ${share}`,
  daylightCaptionNoPeak: "Each column is an hour of the day; taller is busier.",
  peakOnlyCaption: "Only the period peak is available; individual turn timings are not included.",
  atOnce: "At once",
  turns: "turns",
  agentTime: "Agent time",
  waitingForYou: "Waiting for you",
  lanesCaption: "Each lane is one agent's closed turns; hatched is waiting for you; the figure is its agent time that day (turns running together add up). The curve is turns running at once, so two turns of one agent count twice.",
  dialCaption: "Around the clock from 00 at the top. The filled shape is turns running at once (rings at 2, 4 and 6); each outer ring is one agent, solid while it worked; gaps are waits for you.",
  shareUnknown: ({ names }: {
    names: string;
  }) => `${names} · share unknown`,
  coverageContextOnlyShort: "Context only",
  shippedCount: ({ count }: {
    count: string | number;
  }) => `${count} merged pull requests linked to agent work`,
  noDate: "No date",
  mixed: "Mixed",
  noMergeDate: "No merge date",
  edgeSession: "Started a session",
  edgeRun: "Execution run · delegate, review, plan",
  edgeNative: "Native subagents",
  edgeNote: "Arrow: who started → who did it · width: how often",
  unknownStarts: ({ count }: {
    count: string | number;
  }) => `${count} sessions started by an agent we can't name`,
  planetLight: "Light",
  planetHalo: "Halo",
  planetTrail: "Trail",
  planetLightNote: "Grows with each active day in the period",
  planetLightRest: "Rests at half light",
  planetHaloNote: "Widens with the most work run at once (of 8)",
  planetHaloRest: "No halo",
  planetTrailNote: ({ count }: {
    count: string | number;
  }) => `Lengthens toward the best this period, ${count} ${Number(count) === 1 ? 'day' : 'days'}`,
  planetTrailNoteNoBest: "Lengthens with each day of the current streak",
  planetTrailRest: "No trail",
  runDetail: ({ p90, count }: {
    p90: string;
    count: string | number;
  }) => `p90 ${p90} · ${count}`,
  tickMinute: "1 min",
  tickTenMinutes: "10 min",
  tickHour: "1 h",
  tickFourHours: "4 h",
  runCaption: "Each dot is an equal share of that agent's closed turns. Bold is the median, thin is the 90th percentile. Wall time from start to finish, permission waits included.",
  median: "Median",
  p90: "90th percentile",
  recordPeak: "Most at once",
  recordLongestTurn: "Longest closed turn"
};
export const PUBLIC_USAGE_PLANET_COPY_EN = {
  levelColumn: 'How busy',
  weekColumn: 'Week',
  activeDaysColumn: 'Active days',
  shareColumn: 'Share',
  daysColumn: 'Days',
  peakColumn: 'At once',
  kindColumn: 'Machine',
  countColumn: 'How many',
  weekdayInitials: 'M,T,W,T,F,S,S',
  streakBestDays: ({ count }: {
    count: string | number;
  }) => `Best · ${count} ${Number(count) === 1 ? 'day' : 'days'}`,
  streakNowDays: ({ count }: {
    count: string | number;
  }) => `${count} ${Number(count) === 1 ? 'day' : 'days'} now`,
  streakOngoingBest: ({ count }: {
    count: string | number;
  }) => `${count} ${Number(count) === 1 ? 'day' : 'days'} · your longest in this period`,
  daysLit: ({ count, total }: {
    count: string | number;
    total: string | number;
  }) => `${count} of ${total} days lit`,
  partialWeek: ({ from, to }: {
    from: string;
    to: string;
  }) => `${from}–${to} · part week`, noStreakRings: 'No run of three days or more in this period',
  moonsCaption: 'Each agent is a moon; its size is its share.',
  moonsCaptionDays: 'Each agent is a moon; its size is its share, the lit part how many days it worked.',
  machinesUnavailable: 'Machine kinds aren’t recorded yet. They appear once Happier can tell which kind of machine each agent ran on.',
  machinesEmpty: 'No machine ran agents in this period.',
  machineKindUnknown: 'Unknown kind',
  projectsEmpty: 'No public projects linked yet.',
  atmosphereFirstWeek: 'Week 1',
  atmosphereCaption: 'The halo thickens in weeks with more agents at once; week 1 is at the top.',
  atmosphereCaptionPeak: ({ count }: {
    count: string | number;
  }) => `The halo thickens in weeks with more agents at once; up to ${count} at once this period.`,
};
export const PUBLIC_USAGE_ORIGINAL_COPY_EN = {
  page: {
    agentTime: "Agent time",
    executionHappier: "In Happier",
    executionOutside: "Outside Happier",
    executionUnknown: "Unknown execution",
    factIncomplete: "partial history",
    sourceKindMeasured: "Measured",
    sourceKindFromLogs: "From logs"
  },
  sources: {
    coverageAvailable: "Reported",
    coverageUnknown: "Coverage unknown"
  },
  widgets: {
    usage_sources: "Sources",
    usage_source_coverage: "Coverage"
  },
  howYouWork: {
    footprintNoUsageTitle: "No usage to estimate yet",
    footprintNoUsageReason: "The footprint lens reads the same usage as the rest of this page.",
    footprintInsufficientTitle: "Not enough to estimate energy or emissions",
    footprintInsufficientReason: "Published figures don't cover the models and serving conditions in your usage well enough to estimate energy or emissions.",
    footprintNoEstimate: "No estimate",
    footprintAccounted: "Accounted this period",
    footprintProxy: "A proxy",
    footprintProxyDetail: "tokens are not a measure of energy",
    footprintMethodTitle: "How an estimate would work",
    footprintMethodBody: "Tokens by model × a versioned, published per-token coefficient for that model's serving, with cache reads weighted separately and the grid mix of the serving region. It appears here, with its method, date and uncertainty range, once those facts exist for your models."
  },
};
