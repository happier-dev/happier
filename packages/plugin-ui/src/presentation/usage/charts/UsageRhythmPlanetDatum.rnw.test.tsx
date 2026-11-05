import { act, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { ChartInteractionProvider } from '../../data/ChartDatum.js';
import { UsageDayInAgents, type UsageDayLabels } from './UsageDayInAgents.js';
import { UsageDaylight, UsageWeekTide } from './UsageRhythmEncodings.js';
import { UsageSkyOfDays, type UsageSkyLabels } from './UsageSkyOfDays.js';
import { UsageAgentMoons, UsageAtmosphere, UsageMachines, UsageProjects } from './UsagePlanetFamily.js';
import { UsageAroundThePeriod, UsageDaysOnSurface, UsageNinetyPlanets, UsageRingedByStreaks, UsageStreakThread, UsageWeeksSkyline, type UsageCalendarLabels } from './UsageCalendarForms.js';

const paint = { accent: '#007aff', paper: '#ffffff', dark: false };
const base = { theme, paint, width: 480, label: 'Activity', testID: 'chart' };
const values = { show: 'Values', hide: 'Hide' };
const agents = [{ id: 'codex', name: 'Codex', color: '#007aff' }];
const levels = ['No activity', 'Quiet', 'Steady', 'Busy', 'Busiest'];
const formatted = (value: number) => `${Math.round(value)} tokens`;
const calendarLabels: UsageCalendarLabels = {
  month: date => date, day: date => date, short: date => date, weekdayInitials: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
  levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' }, noActivity: 'No activity', notRecorded: 'Not recorded',
  quieter: 'Quieter', busier: 'Busier', best: String, now: String, ongoingBest: String,
  values: { ...values, dateColumn: 'Day', levelColumn: 'Level', weekColumn: 'Week', activeDaysColumn: 'Active days' },
};
const dayLabels: UsageDayLabels = {
  unknownAgent: 'Unknown agent', peakOnlyCaption: 'Peak', clock: hour => `${hour}:00`, duration: ms => `${Math.round(ms / 1000)} s`,
  atOnce: 'At once', turns: 'Turns', agentTime: 'Agent time', peak: (count, hour) => `${count} at ${hour}`, peakCount: String,
  peakLine: hour => String(hour), waiting: 'Waiting', caption: { lanes: 'Lanes', dial: 'Dial' },
  values: { ...values, agentColumn: 'Agent', agentTimeColumn: 'Agent time', spansColumn: 'Spans', formatSpan: (from, to) => `${from}–${to}` },
};
const skyLabels: UsageSkyLabels = {
  formatValue: formatted, month: date => date, day: date => date, levels: calendarLabels.levels,
  streakBestOngoing: String, streakBest: String, streakNow: String, streakShort: String,
  key: { tie: 'Tie', notAttributed: 'Not attributed', noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier' }, caption: () => 'Sky',
  values: { ...values, dateColumn: 'Day', valueColumn: 'Tokens', leaderColumn: 'Agent', noActivity: 'No activity', notRecorded: 'Not recorded', tie: 'Tie', notAttributed: 'Not attributed' },
};
const calendar = { period: { startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 8, 6), timeZoneOffsetMinutes: 0 }, days: [
  { date: '2026-09-01', level: 1 as const }, { date: '2026-09-02', level: 2 as const }, { date: '2026-09-03', level: 4 as const },
  { date: '2026-09-04', level: null }, { date: '2026-09-05', level: 0 as const },
] };
function datums(children: ReactNode) {
  const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual) => <button data-datum-label={datum.label} data-datum-value={datum.value} data-datum-subtitle={datum.subtitle}>{visual}</button>}>{children}</ChartInteractionProvider>);
  return { ...mount, values: () => [...mount.container.querySelectorAll<HTMLButtonElement>('button[data-datum-value]')].map(node => ({ label: node.dataset.datumLabel, value: node.dataset.datumValue, subtitle: node.dataset.datumSubtitle })) };
}

describe('Rhythm and planet chart datum targets', () => {
  it.each(['lanes', 'dial'] as const)('discloses %s concurrency, exact agent time, witnessed spans and waits', style => {
    const mount = datums(<UsageDayInAgents {...base} style={style} agents={agents} labels={dayLabels} model={{ date: '2026-09-01', lanes: [{ agentId: 'codex', agentTimeMs: 1234, spans: [{ fromHour: 2, toHour: 4, waits: [[3, 3.5]] }] }], atOnce: [0, 3], peak: { count: 3, atHour: 18, byAgent: [{ agentId: 'codex', count: 3 }] }, waitCount: 1 }} />);
    try {
      const entries = mount.values();
      expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ value: '3' }), expect.objectContaining({ label: 'Codex', value: '1,234 ms' }), expect.objectContaining({ value: '2–4' }), expect.objectContaining({ value: '3–3.5' })]));
      expect(mount.container.querySelector('svg button')).toBeNull();
    } finally { mount.unmount(); }
  });
  it.each(['week', 'daylight'] as const)('retains exact amounts, unknown and ordinal readings in %s marks', style => {
    const labels = { weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const, clock: (hour: number) => `${hour}:00`, peak: String, night: () => 'Night', caption: () => 'Daylight', values: { ...values, weekdayColumn: 'Weekday', hourColumn: 'Hour', valueColumn: 'Tokens', formatValue: formatted, levelNames: levels } };
    for (const encoding of ['amount', 'ordinal'] as const) {
      const hours = [encoding === 'amount' ? 1234.56789 : 4, null, 0];
      const mount = datums(style === 'week' ? <UsageWeekTide {...base} labels={labels} model={{ encoding, grid: [hours] }} /> : <UsageDaylight {...base} labels={labels} model={{ encoding, hours, night: null }} />);
      try { expect(mount.values().map(entry => entry.value)).toEqual(expect.arrayContaining([encoding === 'amount' ? '1,234.56789' : 'Busiest', '—', encoding === 'amount' ? '0' : 'No activity'])); } finally { mount.unmount(); }
    }
  });
  it('discloses sky stars and floor marks without exposing ordinal levels as private amounts', () => {
    for (const encoding of ['amount', 'ordinal'] as const) {
      const mount = datums(<UsageSkyOfDays {...base} agents={agents} labels={skyLabels} model={{ encoding, colourBy: 'intensity', days: [
        { date: '2026-09-01', state: 'active', value: 1234.56789, level: 4 }, { date: '2026-09-02', state: 'unknown' }, { date: '2026-09-03', state: 'inactive' },
      ] }} />);
      try { expect(mount.values().map(entry => entry.value)).toEqual(expect.arrayContaining([encoding === 'amount' ? '1,234.56789' : 'Busiest', 'Not recorded', 'No activity'])); } finally { mount.unmount(); }
    }
  });
  it('keeps exact night-window share on its existing label, and never turns an unknown share into zero', () => {
    for (const share of [0.123456789, null]) {
      const mount = datums(<UsageDaylight {...base} labels={{ clock: String, night: () => 'Night window', caption: () => '', values: { ...values, hourColumn: 'Hour', valueColumn: 'Tokens', formatValue: formatted, levelNames: levels } }} model={{ encoding: 'amount', hours: [10], night: { fromHour: 23, toHour: 7, share } }} />);
      try { expect(mount.values()).toContainEqual(expect.objectContaining({ label: 'Night window', value: share === null ? '—' : '12.35%' })); } finally { mount.unmount(); }
    }
  });
  it.each(['planets', 'thread', 'skyline', 'orbit', 'surface', 'rings'] as const)('makes %s calendar marks disclose their admitted day level or run length', style => {
    const props = { ...base, model: calendar, labels: { ...calendarLabels, lit: (active: number) => String(active), noRuns: 'No runs' }, renderPlanet: () => <span>Planet</span> };
    const bodies = { planets: <UsageNinetyPlanets {...props} />, thread: <UsageStreakThread {...props} />, skyline: <UsageWeeksSkyline {...props} />, orbit: <UsageAroundThePeriod {...props} />, surface: <UsageDaysOnSurface {...props} />, rings: <UsageRingedByStreaks {...props} /> };
    const mount = datums(bodies[style]);
    try {
      const entries = mount.values();
      expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ value: style === 'rings' ? '3' : 'Busiest' })]));
      if (!['rings', 'skyline'].includes(style)) expect(entries.map(entry => entry.value)).toEqual(expect.arrayContaining(['Not recorded', 'No activity']));
      expect(mount.container.querySelector('svg button')).toBeNull();
    } finally { mount.unmount(); }
  });
  it('discloses exact moon shares and missing attribution without inventing hidden days', () => {
    const mount = datums(<UsageAgentMoons {...base} agents={agents} model={{ agents: [{ agentId: 'codex', share: 0.123456789 }, { agentId: null, share: null }], periodDays: 90 }} labels={{ percent: value => `${Math.round(value * 100)}%`, days: (days, total) => `${days}/${total}`, unknownAgent: 'Unknown agent', caption: () => 'Moons', values: { ...values, agentColumn: 'Agent', shareColumn: 'Share', daysColumn: 'Days' } }} />);
    try { expect(mount.values()).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Codex', value: '12.35%' }), expect.objectContaining({ label: 'Unknown agent', value: '—' })])); } finally { mount.unmount(); }
  });
  it('discloses machine counts and exact shares, project destinations and weekly atmosphere peaks', () => {
    const mount = datums(<><UsageMachines {...base} model={{ kinds: [{ kind: 'laptop', count: 2, agentTimeShare: 0.123456789, coverage: { status: 'partial', method: 'runtime' } }], coverage: { status: 'partial', method: 'runtime' } }} labels={{ kind: kind => kind, percent: value => `${Math.round(value * 100)}%`, unavailable: 'Unavailable', empty: 'Empty', values: { ...values, kindColumn: 'Kind', countColumn: 'Count', shareColumn: 'Share' } }} /><UsageProjects {...base} model={{ links: [{ label: 'Garden', url: 'https://example.com/garden' }] }} labels={{ empty: 'Empty' }} /><UsageAtmosphere {...base} model={{ weeks: [{ startMs: 1, endMs: 2, peak: 3, coverage: { status: 'partial', method: 'runtime' } }, { startMs: 2, endMs: 3, peak: 0, coverage: { status: 'unknown', method: 'unknown' } }] }} labels={{ week: start => `Week ${start}`, peak: count => `${count} at once`, firstWeek: 'First', caption: () => 'Atmosphere', values: { ...values, weekColumn: 'Week', peakColumn: 'Peak', notRecorded: 'Not recorded' } }} /></>);
    try { expect(mount.values()).toEqual(expect.arrayContaining([expect.objectContaining({ value: '12.35%' }), expect.objectContaining({ label: 'Garden', value: 'https://example.com/garden' }), expect.objectContaining({ label: 'Week 1', value: '3' }), expect.objectContaining({ label: 'Week 2', value: 'Not recorded' })])); expect(mount.container.querySelector('a[href="https://example.com/garden"]')).not.toBeNull(); } finally { mount.unmount(); }
  });
  it('exposes interactive marks separately to assistive technology and scales sky targets with its drawing', () => {
    const mount = datums(<UsageSkyOfDays {...base} labels={skyLabels} agents={agents} model={{ encoding: 'ordinal', colourBy: 'intensity', days: [{ date: '2026-09-01', state: 'active', level: 4 }] }} />);
    try {
      const target = mount.container.querySelector<HTMLButtonElement>('button[data-datum-value="Busiest"]')!;
      expect(target.closest('[role="img"]')).toBeNull();
      expect(target.parentElement!.style.left).toMatch(/%$/u);
      expect(target.parentElement!.style.top).toMatch(/%$/u);
    } finally { mount.unmount(); }
  });
  it.each([
    { name: 'streak ring', value: '3', body: <UsageRingedByStreaks {...base} model={calendar} labels={{ ...calendarLabels, noRuns: 'No runs' }} /> },
    { name: 'dial concurrency sector', value: '3', body: <UsageDayInAgents {...base} agents={agents} labels={dayLabels} style="dial" model={{ date: '2026-09-01', lanes: [], atOnce: [0, 3, 1, 4], peak: { count: 4, atHour: 21, byAgent: [] }, waitCount: 0 }} /> },
    { name: 'weekday ridge', value: '1,234.56789', body: <UsageWeekTide {...base} model={{ encoding: 'amount', grid: [[1234.56789, 0, 100]] }} labels={{ weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], clock: String, peak: String, values: { ...values, weekdayColumn: 'Day', formatValue: formatted, levelNames: levels } }} /> },
    { name: 'surface meridian', value: 'Busiest', body: <UsageDaysOnSurface {...base} model={calendar} labels={{ ...calendarLabels, lit: String }} renderPlanet={() => null} /> },
    { name: 'weekly atmosphere', value: '3', body: <UsageAtmosphere {...base} model={{ weeks: [{ startMs: 1, endMs: 2, peak: 3, coverage: { status: 'partial', method: 'runtime' } }] }} labels={{ week: String, peak: String, firstWeek: 'First', caption: () => 'Atmosphere', values: { ...values, weekColumn: 'Week', peakColumn: 'Peak', notRecorded: 'Not recorded' } }} /> },
  ])('activates the full $name geometry on pointer, focus, keyboard and press', ({ body, value, name }) => {
    const selected: string[] = [];
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, _id, trigger) => trigger ? trigger({ onHoverChange: hovered => { if (hovered) selected.push(datum.value); }, onFocusChange: focused => { if (focused) selected.push(datum.value); }, onPress: () => { selected.push(datum.value); } }) : visual}>
      {body}
    </ChartInteractionProvider>);
    try {
      const path = [...mount.container.querySelectorAll<SVGPathElement>('path[role="button"]')].find(node => node.getAttribute('aria-label')?.endsWith(`: ${value}`));
      expect(path).toBeDefined();
      expect(mount.container.querySelector('svg button')).toBeNull();
      const focusablePaths = mount.container.querySelectorAll('path[role="button"][tabindex="0"]');
      // One stop per real semantic datum, not one stop per rendered atmosphere dot or sampled curve pixel.
      if (name === 'weekly atmosphere') expect(focusablePaths).toHaveLength(1);
      if (name === 'dial concurrency sector') expect(focusablePaths).toHaveLength(4);
      if (name === 'weekday ridge') expect(focusablePaths).toHaveLength(3);
      if (name === 'surface meridian') expect(focusablePaths).toHaveLength(calendar.days.length);
      if (name === 'dial concurrency sector') expect(path!.getAttribute('clip-path')).toMatch(/^url\(#chart-datum-/u);
      if (name === 'dial concurrency sector' || name === 'weekday ridge') expect([...mount.container.querySelectorAll('path')].some(node => node !== path && node.getAttribute('d') === path!.getAttribute('d'))).toBe(true);
      act(() => { path!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); path!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); path!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); path!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); path!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(selected).toEqual([value, value, value, value, value]);
    } finally { mount.unmount(); }
  });
});
