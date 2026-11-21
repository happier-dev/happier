import { afterEach, describe, expect, it, vi } from 'vitest';

const language = vi.hoisted(() => ({ value: 'en' }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ getPreferredLanguage: () => language.value });
});

const { formatTriggerResultDecides, formatTriggerSetSentence, formatTriggerSetSummary, formatTriggerSummary, formatNextScheduledRun, formatNextScheduledRunAccessibilityLabel, readNextScheduledRunRefreshAtMs, readSessionLifecycleKind } = await import('./formatTriggerSummary');
const { resolveTriggerEventGroup } = await import('./triggerEventGroups');
const { formatClockTime, parseCalendarSchedule, parseClockTime } = await import('./triggerSchedule');
const { formatAsOfTime } = await import('@/utils/time/formatAsOfTime');

afterEach(() => { language.value = 'en'; });

function cron(scheduleExpr: string) {
    return { kind: 'schedule', schedule: { kind: 'cron', scheduleExpr, everyMs: null } } as const;
}

function interval(everyMs: number) {
    return { kind: 'schedule', schedule: { kind: 'interval', scheduleExpr: null, everyMs } } as const;
}

describe('formatTriggerSummary', () => {
    it('names an Action clause without moving its wait or notify policy into the workflow name', () => {
        const trigger = { kind: 'action' as const, phase: 'before' as const, actionIds: ['scm.commit.create'] };
        const actionTitle = () => 'Commit';
        expect(formatTriggerSummary({ ...trigger, mode: 'wait' }, { actionTitle, form: 'clause' }))
            .toBe('workflows.triggers.link.beforeAction(action=Commit)');
        expect(formatTriggerSummary({ ...trigger, mode: 'notify' }, { actionTitle, form: 'clause' }))
            .toBe('workflows.triggers.link.beforeAction(action=Commit)');
        expect(formatTriggerSummary({ ...trigger, phase: 'after' }, { actionTitle, form: 'clause' }))
            .toBe('workflows.triggers.link.afterAction(action=Commit)');
        expect(formatTriggerSummary({ ...trigger, mode: 'wait' }, { actionTitle }))
            .toBe('workflows.triggers.card.actionSentence.beforeWait(action=Commit)');
        expect(formatTriggerSummary({ ...trigger, mode: 'notify' }, { actionTitle }))
            .toBe('workflows.triggers.card.actionSentence.beforeNotify(action=Commit)');
    });
    it('keeps turn-start activity distinct from turn completion in summaries and grouping', () => {
        const trigger = { kind: 'sessionLifecycle' as const, events: ['parentTurnStarted' as const] };
        expect(readSessionLifecycleKind(trigger.events)).toBe('turnStarts');
        expect(formatTriggerSummary(trigger)).toBe('workflows.triggers.kind.turnStarts');
        expect(resolveTriggerEventGroup(trigger)).toMatchObject({ id: 'lifecycle:turnStarts', glyph: 'play' });
    });
    it('names the exact one-time instant instead of presenting it as a recurring interval', () => {
        const summary = formatTriggerSummary({ kind: 'schedule', schedule: { kind: 'once', scheduledAt: new Date(2030, 10, 11, 9, 15).getTime() } });
        expect(summary).toContain('workflows.triggers.once.at(time=');
        expect(summary).toContain('2030');
        expect(summary).not.toContain('everyMinutes');
        // This year's instant reads like every other time on screen: no year, no zone.
        const thisYear = new Date(new Date().getFullYear(), 10, 18, 0, 1).getTime();
        const sameYear = formatTriggerSummary({ kind: 'schedule', schedule: { kind: 'once', scheduledAt: thisYear } });
        expect(sameYear).not.toContain(String(new Date().getFullYear()));
        expect(sameYear).not.toMatch(/GMT|UTC/u);
    });
    it('waits for a scheduler projection instead of presenting a retained past occurrence as the next run', () => {
        const now = new Date(2026, 9, 20, 10).getTime();
        expect(formatNextScheduledRun(now - 7 * 86_400_000, true, now)).toBe('automations.list.nextRunPending');
        expect(formatNextScheduledRun(now, true, now)).toBe('automations.list.nextRunPending');
        expect(formatNextScheduledRunAccessibilityLabel(now - 1, true, now)).toBe('automations.list.nextRunPending');
        expect(readNextScheduledRunRefreshAtMs(now - 1, now)).toBeNull();
        expect(formatNextScheduledRun(now + 3 * 3_600_000, true, now)).toContain('nextHours(count=3)');
    });
    it.each([[2 * 60_000, 30_001], [3 * 3_600_000, 30 * 60_000 + 30_001],
        [60 * 60_000, 30_001], [10_000, 10_000]])(
        'refreshes an occurrence %sms away only when its displayed value changes', (delta, delay) => {
            const now = new Date(2026, 9, 10, 10).getTime();
            const at = now + delta;
            const boundary = readNextScheduledRunRefreshAtMs(at, now);
            expect(boundary).toBe(now + delay);
            expect(formatNextScheduledRun(at, true, boundary! - 1)).toBe(formatNextScheduledRun(at, true, now));
            expect(formatNextScheduledRun(at, true, boundary!)).not.toBe(formatNextScheduledRun(at, true, now));
        });
    it('refreshes calendar-day labels at local midnight, and leaves absent occurrences unscheduled', () => {
        const now = new Date(2026, 9, 10, 23, 59, 55).getTime();
        const at = new Date(2026, 9, 11, 9).getTime();
        const midnight = new Date(2026, 9, 11).getTime();
        expect(readNextScheduledRunRefreshAtMs(at, now)).toBe(midnight);
        expect(formatNextScheduledRun(at, true, midnight - 1)).toContain('nextDays(count=1)');
        expect(formatNextScheduledRun(at, true, midnight)).toContain('nextHours(count=9)');
        expect(readNextScheduledRunRefreshAtMs(null, now)).toBeNull();
    });
    // One clock across the app (DESIGN-ACCEPT-1 D2): a schedule, a one-time instant and an Event's time all read
    // in the viewer's locale clock, the same as every freshness line ("Listening since 3:49 PM" beside "Every day at 9:05 AM").
    it.each(['en-US', 'en-GB', 'fr-FR'])('uses the app clock for schedules, one-time instants and next occurrences (%s)', (locale) => {
        language.value = locale;
        const now = new Date(2026, 9, 8, 6).getTime();
        const next = new Date(2026, 9, 9, 9, 5).getTime();
        const clock = formatAsOfTime(next, next);
        expect(formatClockTime({ hour: 9, minute: 5 })).toBe(clock);
        expect(formatTriggerSummary(cron('5 9 * * *'))).toContain(clock);
        expect(formatTriggerSummary({ kind: 'schedule', schedule: { kind: 'once', scheduledAt: next } })).toContain(clock);
        expect(formatNextScheduledRunAccessibilityLabel(next, true, now)).toContain(new Intl.DateTimeFormat(locale,
            { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(next));
        expect(parseClockTime('09:05')).toEqual({ hour: 9, minute: 5 });
    });
    it('shows relative occurrences when the native Intl boundary has no RelativeTimeFormat', () => {
        const intl = globalThis.Intl;
        vi.stubGlobal('Intl', { DateTimeFormat: intl.DateTimeFormat });
        try {
            const now = new Date(2026, 9, 8, 6).getTime();
            expect(formatNextScheduledRun(now + 3 * 3_600_000, true, now)).toContain('nextHours(count=3)');
            expect(formatNextScheduledRun(new Date(2026, 9, 9, 9).getTime(), true, now)).toContain('nextDays(count=1)');
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it('keeps upcoming times relative while exposing the exact occurrence to assistive technology', () => {
        const now = new Date(2026, 9, 8, 6).getTime();
        const later = now + 3 * 3_600_000;
        expect(formatNextScheduledRun(later, true, now)).toContain('nextHours(count=3)');
        expect(formatNextScheduledRun(new Date(2026, 9, 9, 9).getTime(), true, now)).toContain('nextDays(count=1)');
        expect(formatNextScheduledRunAccessibilityLabel(later, true, now)).toContain('2026');
        expect(formatNextScheduledRunAccessibilityLabel(later, true, now)).toContain('9:00');
        expect(formatNextScheduledRun(null)).toBe('automations.list.nextRunPending');
        expect(formatNextScheduledRun(null, false)).toBe('automations.list.noNextRun');
    });
    it('groups Run lifecycle triggers by their condition without exposing the private Run identity', () => {
        for (const condition of ['terminal', 'needs_attention'] as const) {
            const trigger = { kind: 'runLifecycle' as const, condition, source: { kind: 'workflow_run' as const, runId: 'run-private' } };
            const group = resolveTriggerEventGroup(trigger);
            expect(group).toBeDefined();
            expect(group.title).toBe(formatTriggerSummary(trigger));
            expect(group.title).not.toContain('run-private');
            expect(group.id).toContain(condition);
            expect(group.glyph).toBe(condition === 'needs_attention' ? 'hand' : 'arrows-clockwise');
        }
    });
    it('reads the common crons as a sentence and shows any other expression as it is', () => {
        expect(formatTriggerSummary(cron('0 7 * * *'))).toBe(`workflows.triggers.summary.everyDayAt(time=${formatClockTime({ hour: 7, minute: 0 })})`);
        expect(formatTriggerSummary(cron('5 9 * * 1-5'))).toBe(`workflows.triggers.summary.weekdaysAt(time=${formatClockTime({ hour: 9, minute: 5 })})`);
        expect(formatTriggerSummary(cron('30 2 * * 3'))).toBe(`workflows.triggers.summary.weeklyAt(day=Wednesday,time=${formatClockTime({ hour: 2, minute: 30 })})`);
        // Sunday may be written 0 or 7.
        expect(formatTriggerSummary(cron('0 18 * * 7'))).toBe(`workflows.triggers.summary.weeklyAt(day=Sunday,time=${formatClockTime({ hour: 18, minute: 0 })})`);
        // Out-of-range, stepped and either-day crons are never guessed at.
        for (const expression of ['*/5 * * * *', '0 25 * * *', '0 9 1 * 1', '0 9 31 2 *', '0 9 * 2 *', '0 9 31 2,8 *', '0 9 5-3 * *']) {
            expect(formatTriggerSummary(cron(expression))).toBe(`workflows.triggers.summary.cron(expression=${expression})`);
        }
    });
    // QA-RERUN-1113 F1: one plain sentence in rows and detail; lists and ranges are read, never collapsed.
    it('reads yearly, monthly, hourly and listed crons as one sentence without the expression', () => {
        const time = (hour: number, minute: number) => formatClockTime({ hour, minute });
        expect(formatTriggerSummary(cron('0 0 1 1 *'))).toBe(`workflows.triggers.summary.yearlyAt(date=January 1,time=${time(0, 0)})`);
        expect(formatTriggerSummary(cron('17 3 5 2,8 *')))
            .toBe(`workflows.triggers.summary.monthDaysAt(days=5,count=1,months=February and August,time=${time(3, 17)})`);
        expect(formatTriggerSummary(cron('0 9 1,15 6-8 *')))
            .toBe(`workflows.triggers.summary.monthDaysAt(days=1 and 15,count=2,months=June, July, and August,time=${time(9, 0)})`);
        expect(formatTriggerSummary(cron('30 9 15 * *'))).toBe(`workflows.triggers.summary.monthlyAt(days=15,count=1,time=${time(9, 30)})`);
        expect(formatTriggerSummary(cron('0 8 1,15 * *'))).toBe(`workflows.triggers.summary.monthlyAt(days=1 and 15,count=2,time=${time(8, 0)})`);
        expect(formatTriggerSummary(cron('5 * * * *'))).toBe('workflows.triggers.summary.hourlyAt(minute=05)');
        expect(formatTriggerSummary(cron('0 9,17 * * *'))).toBe(`workflows.triggers.summary.everyDayAt(time=${time(9, 0)} and ${time(17, 0)})`);
        expect(formatTriggerSummary(cron('0 9 * * 1,3,5'))).toBe(`workflows.triggers.summary.weeklyAt(day=Monday, Wednesday, and Friday,time=${time(9, 0)})`);
        expect(formatTriggerSummary(cron('0 9 * * 1,2,3,4,5'))).toBe(`workflows.triggers.summary.weekdaysAt(time=${time(9, 0)})`);
    });
    it('parses lists and ranges in the day, month, weekday and hour fields', () => {
        expect(parseCalendarSchedule('17 3 5 2,8 *')).toEqual({ repeat: 'yearly', months: [2, 8], days: [5], times: [{ hour: 3, minute: 17 }] });
        expect(parseCalendarSchedule('0 9 1-3 * *')).toEqual({ repeat: 'monthly', days: [1, 2, 3], times: [{ hour: 9, minute: 0 }] });
        expect(parseCalendarSchedule('0 9,17 * * 0,6')).toEqual({ repeat: 'weekly', weekdays: [0, 6], times: [{ hour: 9, minute: 0 }, { hour: 17, minute: 0 }] });
        expect(parseCalendarSchedule('0 9 * * 7,1')).toEqual({ repeat: 'weekly', weekdays: [0, 1], times: [{ hour: 9, minute: 0 }] });
        expect(parseCalendarSchedule('5 * * * *')).toEqual({ repeat: 'hourly', minute: 5 });
        for (const expression of ['0,30 9 * * *', '0 9 1 * 1', '0 9 */2 * *', '0 9 0 * *', '0 9 1,, * *', '5 * 1 * *', '0 9 * 13 *']) {
            expect(parseCalendarSchedule(expression)).toBeNull();
        }
    });

    it('names an interval in hours when it is whole hours', () => {
        expect(formatTriggerSummary(interval(2 * 3_600_000))).toBe('workflows.triggers.summary.everyHours(count=2)');
        expect(formatTriggerSummary(interval(90 * 60_000))).toBe('workflows.triggers.summary.everyMinutes(count=90)');
    });

    it('reads a session event as its kind and a plugin event by its label', () => {
        expect(formatTriggerSummary({ kind: 'sessionLifecycle', events: ['parentTurnCompleted', 'parentTurnFailed'] }))
            .toBe('workflows.triggers.kind.turnEnds');
        expect(formatTriggerSummary({ kind: 'sessionLifecycle', events: ['userActionRequired'] }))
            .toBe('workflows.triggers.kind.needsYou');
        expect(formatTriggerSummary({ kind: 'pluginEvent', eventRef: { pluginId: 'example.github', localId: 'pull_request.merged' }, displayLabel: 'When a pull request merges' }))
            .toBe('When a pull request merges');
        expect(formatTriggerSummary({ kind: 'pluginEvent', eventRef: { pluginId: 'example.github', localId: 'pull_request.merged' } }))
            .toBe('workflows.triggers.kind.pluginEvent');
    });
});

describe('formatTriggerSetSummary', () => {
    it('says Off before a trigger that will not fire, in the same words as a trigger row', () => {
        const first = `workflows.triggers.summary.everyDayAt(time=${formatClockTime({ hour: 2, minute: 0 })})`;
        expect(formatTriggerSetSummary([{ ...cron('0 2 * * *'), enabled: false }])).toBe(`workflows.triggers.row.off · ${first}`);
        expect(formatTriggerSetSummary([{ ...cron('0 2 * * *'), enabled: true }])).toBe(first);
    });
    it('is Manual with no trigger, the one summary with one, and "{first} · {n} more" with several', () => {
        expect(formatTriggerSetSummary([])).toBe('workflows.triggers.summary.manual');
        const first = `workflows.triggers.summary.everyDayAt(time=${formatClockTime({ hour: 2, minute: 0 })})`;
        expect(formatTriggerSetSummary([cron('0 2 * * *')])).toBe(first);
        expect(formatTriggerSetSummary([cron('0 2 * * *'), interval(3_600_000)]))
            .toBe(`workflows.triggers.summary.more(first=${first},count=1)`);
    });
});


it('says the same sentence in collection rows and details, and keeps an unsayable expression out of rows', () => {
    expect(formatTriggerSetSummary([cron('17 3 5 2,8 *')])).toBe(formatTriggerSummary(cron('17 3 5 2,8 *')));
    expect(formatTriggerSetSummary([{ ...cron('0 0 1 1 *'), enabled: false }])).toBe(`workflows.triggers.row.off · ${formatTriggerSummary(cron('0 0 1 1 *'))}`);
    expect(formatTriggerSummary(cron('*/5 * * * *'))).toContain('*/5 * * * *');
    expect(formatTriggerSetSummary([cron('*/5 * * * *')])).toBe('workflows.triggers.summary.schedule');
});

describe('formatTriggerResultDecides', () => {
    const titles = { actionTitle: (actionId: string) => actionId === 'deployments.deploy' ? 'Deploy an app' : 'Merge a pull request' };
    const before = (actionIds: string[], mode?: 'wait' | 'notify') =>
        ({ kind: 'action', phase: 'before', actionIds, ...(mode === undefined ? {} : { mode }) }) as const;
    it('names each Action a waiting before-trigger decides, once', () => {
        const line = formatTriggerResultDecides([before(['deployments.deploy']), before(['deployments.deploy'], 'wait'),
            before(['github.pr.merge'], 'wait')], titles);
        expect(line).toContain('Deploy an app');
        expect(line).toContain('Merge a pull request');
        expect(line?.split('Deploy an app')).toHaveLength(2);
    });
    it('says nothing when no trigger waits on an Action', () => {
        expect(formatTriggerResultDecides([before(['deployments.deploy'], 'notify'),
            { kind: 'action', phase: 'after', actionIds: ['deployments.deploy'] }, cron('0 9 * * *')], titles)).toBeNull();
        expect(formatTriggerResultDecides([], titles)).toBeNull();
    });
});

describe('formatTriggerSetSentence', () => {
    it('says a start once when several triggers read the same (two "When a turn ends" rows on one workflow)', () => {
        const turnEnds = { kind: 'sessionLifecycle', events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'] } as const;
        const sessionStarts = { kind: 'sessionLifecycle', events: ['sessionStarted'] } as const;
        const sentence = formatTriggerSetSentence([turnEnds, turnEnds, sessionStarts, turnEnds]);
        expect(sentence).toBe(formatTriggerSetSentence([turnEnds, sessionStarts]));
        expect(sentence).not.toBe(formatTriggerSetSentence([turnEnds]));
    });
});
