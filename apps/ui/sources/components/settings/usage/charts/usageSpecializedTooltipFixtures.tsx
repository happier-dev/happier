import {
    UsageAgentMoons, UsageAroundThePeriod, UsageAtmosphere, UsageDayInAgents, UsageDaylight, UsageDaysOnSurface,
    UsageMachines, UsageNinetyPlanets, UsageProjects, UsageRingedByStreaks, UsageSkyOfDays, UsageStreakThread,
    UsageWeekTide, UsageWeeksSkyline,
    type UsageCalendarLabels, type UsageDayLabels, type UsageSkyLabels,
} from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { usageSignatureAccent } from '../usageAccent';

const base = {
    theme: projectPluginUiTheme(lightTheme), width: 480, label: 'Activity',
    paint: { accent: usageSignatureAccent(lightTheme), paper: lightTheme.colors.surface.base, dark: false },
};
const values = { show: 'Values', hide: 'Hide' };
const agents = [{ id: 'codex', name: 'Codex', color: base.paint.accent }];
const levels = ['No activity', 'Quiet', 'Steady', 'Busy', 'Busiest'];
const formatValue = (value: number) => `${Math.round(value)} tokens`;
const calendarLabels: UsageCalendarLabels = {
    month: String, day: String, short: String, weekdayInitials: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
    levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' },
    noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier', best: String, now: String, ongoingBest: String,
    values: { ...values, dateColumn: 'Day', levelColumn: 'Level', weekColumn: 'Week', activeDaysColumn: 'Active days' },
};
const dayLabels: UsageDayLabels = {
    unknownAgent: 'Unknown agent', peakOnlyCaption: 'Peak', clock: hour => `${hour}:00`, duration: ms => `${Math.round(ms / 1000)}s`,
    atOnce: 'At once', turns: 'Turns', agentTime: 'Agent time', peak: String, peakCount: String, peakLine: String,
    waiting: 'Waiting', caption: { lanes: 'Lanes', dial: 'Dial' },
    values: { ...values, agentColumn: 'Agent', agentTimeColumn: 'Agent time', spansColumn: 'Spans', formatSpan: (from, to) => `${from}–${to}` },
};
const skyLabels: UsageSkyLabels = {
    formatValue, month: String, day: String, levels: calendarLabels.levels, streakBestOngoing: String, streakBest: String, streakNow: String, streakShort: String,
    key: { tie: 'Tie', notAttributed: 'Not attributed', noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier' }, caption: () => 'Sky',
    values: { ...values, dateColumn: 'Day', valueColumn: 'Tokens', leaderColumn: 'Agent', noActivity: 'No activity', notRecorded: 'Not recorded', tie: 'Tie', notAttributed: 'Not attributed' },
};
const calendar = {
    period: { startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 8, 6), timeZoneOffsetMinutes: 0 },
    days: [{ date: '2026-09-01', level: 1 as const }, { date: '2026-09-02', level: 2 as const }, { date: '2026-09-03', level: 4 as const }, { date: '2026-09-04', level: null }, { date: '2026-09-05', level: 0 as const }],
};
const calendarProps = { ...base, model: calendar, labels: { ...calendarLabels, lit: String, noRuns: 'No runs' }, renderPlanet: () => null };
const hourLabels = {
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const, clock: (hour: number) => `${hour}:00`,
    peak: String, night: () => 'Night', caption: () => 'Daylight',
    values: { ...values, weekdayColumn: 'Weekday', hourColumn: 'Hour', valueColumn: 'Tokens', formatValue, levelNames: levels },
};

/** Real chart bodies for the app's shared ChartTooltip/Popover interaction suite. */
export const usageSpecializedTooltipFixtures = [
    ...(['lanes', 'dial'] as const).map(style => ({
        name: `Parallel ${style}`, value: '1,234 ms',
        body: <UsageDayInAgents {...base} style={style} agents={agents} labels={dayLabels} model={{ date: '2026-09-01', lanes: [{ agentId: 'codex', agentTimeMs: 1234, spans: [{ fromHour: 2, toHour: 4, waits: [[3, 3.5]] }] }], atOnce: [0, 3], peak: { count: 3, atHour: 18, byAgent: [{ agentId: 'codex', count: 3 }] }, waitCount: 1 }} />,
    })),
    { name: 'Week tide', value: '1,234.56789', body: <UsageWeekTide {...base} labels={hourLabels} model={{ encoding: 'amount', grid: [[1234.56789, null, 0]] }} /> },
    { name: 'Daylight', value: 'Busiest', body: <UsageDaylight {...base} labels={hourLabels} model={{ encoding: 'ordinal', hours: [4, null, 0], night: null }} /> },
    { name: 'Sky of days', value: '1,234.56789', body: <UsageSkyOfDays {...base} labels={skyLabels} agents={agents} model={{ encoding: 'amount', colourBy: 'intensity', days: [{ date: '2026-09-01', state: 'active', value: 1234.56789 }, { date: '2026-09-02', state: 'unknown' }] }} /> },
    { name: 'Ninety planets', value: 'Busiest', body: <UsageNinetyPlanets {...calendarProps} /> },
    { name: 'Streak thread', value: 'Busiest', body: <UsageStreakThread {...calendarProps} /> },
    { name: 'Weeks skyline', value: 'Busiest', body: <UsageWeeksSkyline {...calendarProps} /> },
    { name: 'Around the period', value: 'Busiest', body: <UsageAroundThePeriod {...calendarProps} /> },
    { name: 'Days on surface', value: 'Busiest', body: <UsageDaysOnSurface {...calendarProps} /> },
    { name: 'Ringed by streaks', value: '3', body: <UsageRingedByStreaks {...calendarProps} /> },
    { name: 'Agent moons', value: '12.35%', body: <UsageAgentMoons {...base} agents={agents} model={{ agents: [{ agentId: 'codex', share: 0.123456789 }], periodDays: 90 }} labels={{ percent: share => `${Math.round(share * 100)}%`, days: String, unknownAgent: 'Unknown agent', caption: () => 'Moons', values: { ...values, agentColumn: 'Agent', shareColumn: 'Share', daysColumn: 'Days' } }} /> },
    { name: 'Machines', value: '12.35%', body: <UsageMachines {...base} model={{ kinds: [{ kind: 'laptop', count: 2, agentTimeShare: 0.123456789, coverage: { status: 'partial', method: 'runtime' } }], coverage: { status: 'partial', method: 'runtime' } }} labels={{ kind: String, percent: share => `${Math.round(share * 100)}%`, unavailable: 'Unavailable', empty: 'Empty', values: { ...values, kindColumn: 'Kind', countColumn: 'Count', shareColumn: 'Share' } }} /> },
    { name: 'Projects', value: 'https://example.com/garden', body: <UsageProjects {...base} model={{ links: [{ label: 'Garden', url: 'https://example.com/garden' }] }} labels={{ empty: 'Empty' }} /> },
    { name: 'Atmosphere', value: '3', body: <UsageAtmosphere {...base} model={{ weeks: [{ startMs: 1, endMs: 2, peak: 3, coverage: { status: 'partial', method: 'runtime' } }] }} labels={{ week: String, peak: String, firstWeek: 'First', caption: () => 'Atmosphere', values: { ...values, weekColumn: 'Week', peakColumn: 'Peak', notRecorded: 'Not recorded' } }} /> },
];
