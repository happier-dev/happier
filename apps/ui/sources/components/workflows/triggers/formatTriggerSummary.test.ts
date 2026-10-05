import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const { formatTriggerSetSummary, formatTriggerSummary } = await import('./formatTriggerSummary');
const { resolveTriggerEventGroup } = await import('./triggerEventGroups');

function cron(scheduleExpr: string) {
    return { kind: 'schedule', schedule: { kind: 'cron', scheduleExpr, everyMs: null } } as const;
}

function interval(everyMs: number) {
    return { kind: 'schedule', schedule: { kind: 'interval', scheduleExpr: null, everyMs } } as const;
}

describe('formatTriggerSummary', () => {
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
        expect(formatTriggerSummary(cron('0 7 * * *'))).toBe('workflows.triggers.summary.everyDayAt(time=07:00)');
        expect(formatTriggerSummary(cron('5 9 * * 1-5'))).toBe('workflows.triggers.summary.weekdaysAt(time=09:05)');
        expect(formatTriggerSummary(cron('30 2 * * 3'))).toBe('workflows.triggers.summary.weeklyAt(day=Wednesday,time=02:30)');
        // Sunday may be written 0 or 7.
        expect(formatTriggerSummary(cron('0 18 * * 7'))).toBe('workflows.triggers.summary.weeklyAt(day=Sunday,time=18:00)');
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
        expect(formatTriggerSetSummary([cron('0 2 * * *')])).toBe('workflows.triggers.summary.everyDayAt(time=02:00)');
        expect(formatTriggerSetSummary([cron('0 2 * * *'), interval(3_600_000)]))
            .toBe('workflows.triggers.summary.more(first=workflows.triggers.summary.everyDayAt(time=02:00),count=1)');
    });
});
