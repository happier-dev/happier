import { afterEach, describe, expect, it, vi } from 'vitest';

const language = vi.hoisted(() => ({ value: 'en' }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ getPreferredLanguage: () => language.value });
});

const { formatTriggerSetSummary, formatTriggerSummary, formatNextScheduledRun, formatNextScheduledRunAccessibilityLabel, readNextScheduledRunRefreshAtMs } = await import('./formatTriggerSummary');
const { resolveTriggerEventGroup } = await import('./triggerEventGroups');
const { formatClockTime, parseClockTime } = await import('./triggerSchedule');

afterEach(() => { language.value = 'en'; });

function cron(scheduleExpr: string) {
    return { kind: 'schedule', schedule: { kind: 'cron', scheduleExpr, everyMs: null } } as const;
}

function interval(everyMs: number) {
    return { kind: 'schedule', schedule: { kind: 'interval', scheduleExpr: null, everyMs } } as const;
}

describe('formatTriggerSummary', () => {
    it.each([[2 * 60_000, 30_001], [3 * 3_600_000, 30 * 60_000 + 30_001],
        [60 * 60_000, 30_001], [10_000, 70_000], [-90_000, 30_000]])(
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
    it.each(['en-US', 'en-GB', 'fr-FR'])('uses the same locale clock for schedules and next occurrences (%s)', (locale) => {
        language.value = locale;
        const now = new Date(2026, 9, 8, 6).getTime();
        const next = new Date(2026, 9, 9, 9, 5).getTime();
        const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(next);
        expect(formatClockTime({ hour: 9, minute: 5 })).toBe(clock);
        expect(formatTriggerSummary(cron('5 9 * * *'))).toContain(clock);
        expect(formatNextScheduledRunAccessibilityLabel(next)).toContain(new Intl.DateTimeFormat(locale,
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
        expect(formatNextScheduledRunAccessibilityLabel(later)).toContain('2026');
        expect(formatNextScheduledRunAccessibilityLabel(later)).toContain('9:00');
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
        // Out-of-range, stepped and day-of-month crons are never guessed at.
        for (const expression of ['*/5 * * * *', '0 25 * * *', '0 9 1 * *']) {
            expect(formatTriggerSummary(cron(expression))).toBe(`workflows.triggers.summary.cron(expression=${expression})`);
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
        expect(formatTriggerSummary({ kind: 'pluginEvent', eventRef: { localId: 'pull_request.merged' }, displayLabel: 'When a pull request merges' }))
            .toBe('When a pull request merges');
        expect(formatTriggerSummary({ kind: 'pluginEvent', eventRef: { localId: 'pull_request.merged' } }))
            .toBe('workflows.triggers.summary.event(event=pull_request.merged)');
    });
});

describe('formatTriggerSetSummary', () => {
    it('is Manual with no trigger, the one summary with one, and "{first} · {n} more" with several', () => {
        expect(formatTriggerSetSummary([])).toBe('workflows.triggers.summary.manual');
        const first = `workflows.triggers.summary.everyDayAt(time=${formatClockTime({ hour: 2, minute: 0 })})`;
        expect(formatTriggerSetSummary([cron('0 2 * * *')])).toBe(first);
        expect(formatTriggerSetSummary([cron('0 2 * * *'), interval(3_600_000)]))
            .toBe(`workflows.triggers.summary.more(first=${first},count=1)`);
    });
});
