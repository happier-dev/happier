import type { AutomationSessionLifecycleEvent, AutomationRunLifecycleTrigger } from '@happier-dev/protocol';

import { getPreferredLanguage, t } from '@/text';

import { formatClockTime, parseSimpleSchedule } from './triggerSchedule';

/**
 * The one "when" summary of a trigger (FIN 04 §5.4, 07 S4): the chip, the Runs automatically row,
 * the column's Triggers rows and a session's trigger groups all read it from here, so the same
 * trigger reads the same everywhere ("Every day at 09:00", "When a turn ends").
 *
 * It accepts the list projection, the private detail and an editor draft alike: each carries the
 * kind and the fields this reads. A plugin event without a display label names its event.
 */
export type TriggerSummarySource =
    | Readonly<{
        kind: 'schedule';
        schedule: Readonly<{ kind: 'cron' | 'interval'; scheduleExpr: string | null; everyMs: number | null }>;
    }>
    | Readonly<{ kind: 'pluginEvent'; eventRef: Readonly<{ localId: string }>; displayLabel?: string }>
    | Readonly<{ kind: 'prComment' | 'ciFailed'; pullRequest?: Readonly<{ repository: string; number: number }> }>
    | Readonly<{ kind: 'sessionLifecycle'; events: readonly AutomationSessionLifecycleEvent[] }>
    | Pick<AutomationRunLifecycleTrigger, 'kind' | 'condition'>;

const MINUTE_MS = 60_000;

/** The weekday's name in the person's language (cron day 0 is Sunday). */
export function weekdayName(day: number): string {
    // 2023-01-01 was a Sunday; formatting in UTC keeps the day stable in every time zone.
    const date = new Date(Date.UTC(2023, 0, 1 + day));
    try {
        return new Intl.DateTimeFormat(getPreferredLanguage(), { weekday: 'long', timeZone: 'UTC' }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(date);
    }
}

/**
 * The common daily, weekday and weekly crons read as a sentence; anything else shows its
 * expression rather than a guess at what it means.
 */
function formatCron(expression: string): string {
    const simple = parseSimpleSchedule(expression);
    if (simple === null) return t('workflows.triggers.summary.cron', { expression: expression.trim() });
    const time = formatClockTime(simple);
    switch (simple.repeat) {
        case 'daily':
            return t('workflows.triggers.summary.everyDayAt', { time });
        case 'weekdays':
            return t('workflows.triggers.summary.weekdaysAt', { time });
        case 'weekly':
            return t('workflows.triggers.summary.weeklyAt', { day: weekdayName(simple.day), time });
    }
}

/** "Every hour", "Every 15 minutes": an interval schedule's one wording. */
export function formatTriggerInterval(everyMs: number): string {
    const minutes = Math.max(1, Math.round(everyMs / MINUTE_MS));
    return minutes % 60 === 0
        ? t('workflows.triggers.summary.everyHours', { count: minutes / 60 })
        : t('workflows.triggers.summary.everyMinutes', { count: minutes });
}

export type SessionLifecycleKind = 'turnEnds' | 'needsYou' | 'sessionStarts' | 'sessionArchived';

/**
 * The kind a session event reads as: turn-end events fire together as one "When a turn ends"; the
 * attention, start and archive events are their own kinds (07 S16).
 */
export function readSessionLifecycleKind(events: readonly AutomationSessionLifecycleEvent[]): SessionLifecycleKind {
    if (events.includes('sessionArchived')) return 'sessionArchived';
    if (events.includes('sessionStarted')) return 'sessionStarts';
    return events.length > 0 && events.every((event) => event === 'userActionRequired') ? 'needsYou' : 'turnEnds';
}

export function formatTriggerSummary(trigger: TriggerSummarySource): string {
    switch (trigger.kind) {
        case 'schedule':
            return trigger.schedule.kind === 'cron' && trigger.schedule.scheduleExpr !== null
                ? formatCron(trigger.schedule.scheduleExpr)
                : trigger.schedule.everyMs !== null
                    ? formatTriggerInterval(trigger.schedule.everyMs)
                    : t('workflows.triggers.summary.schedule');
        case 'pluginEvent': {
            const label = trigger.displayLabel?.trim();
            return label ? label : t('workflows.triggers.summary.event', { event: trigger.eventRef.localId });
        }
        case 'sessionLifecycle':
            return t(`workflows.triggers.kind.${readSessionLifecycleKind(trigger.events)}`);
        case 'runLifecycle':
            return t(trigger.condition === 'terminal'
                ? 'workflows.triggers.kind.runEnds' : 'workflows.triggers.kind.runNeedsYou');
        case 'prComment':
        case 'ciFailed':
            return t(`workflows.triggers.kind.${trigger.kind}`)
                + (trigger.pullRequest ? ` · ${trigger.pullRequest.repository} #${trigger.pullRequest.number}` : '');
    }
}

/**
 * A trigger set in one string: "Manual" with none, the one summary, or "{first} · {n} more". The
 * header chip and the settings-pane section use this same string for the same draft (04 §9.1).
 */
export function formatTriggerSetSummary(triggers: readonly TriggerSummarySource[]): string {
    const [first, ...rest] = triggers;
    if (first === undefined) return t('workflows.triggers.summary.manual');
    const summary = formatTriggerSummary(first);
    return rest.length === 0 ? summary : t('workflows.triggers.summary.more', { first: summary, count: rest.length });
}
