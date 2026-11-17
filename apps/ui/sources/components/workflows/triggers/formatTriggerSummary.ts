import { AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1, type AutomationSessionLifecycleEvent } from '@happier-dev/protocol/automations/automationSessionLifecycle';
import type { AutomationRunLifecycleTrigger } from '@happier-dev/protocol/automations/automationRunLifecycle';
import type { AutomationActionTrigger } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { findActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { AutomationPluginEventTrigger } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import type { AutomationPluginEventDefinitionTrigger } from '@happier-dev/protocol/automations/automationTriggerDefinition';

import { getPreferredLanguage, t } from '@/text';
import { readCachedDaemonMergedProjectionCacheEntry, type DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readEligibleEventPresentation } from '@/components/automations/editor/pluginEventAutomationEventPresentation';
import { readCurrentAppShellPluginUiTranslationRuntime } from '@/components/appShell/plugins/committedPluginUiProjection';
import { arePluginContributionIdentitiesEqual } from '@/sync/domains/automations/pluginEventAutomationCurrentness';
import { createPluginLocalizedTextResolver, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { joinList } from '@/utils/text/joinList';
import { resolveActionTitle } from '@/text/actionTitles';

import { formatCalendarDate, formatClockTime, formatMonthName, parseCalendarSchedule, readOnceScheduleState, formatOnceScheduleStateLabel } from './triggerSchedule';

function scheduledRunTimeUnits(nextRunAt: number, nowMs: number) {
    const next = new Date(nextRunAt);
    const now = new Date(nowMs);
    // Calendar days, rather than elapsed 24-hour periods, keep tomorrow truthful across DST.
    const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
    return { days: day(next) - day(now), minutes: Math.round((nextRunAt - nowMs) / MINUTE_MS) };
}

/** Scheduler-owned occurrence time, shared by habits and upcoming Work rows. */
export function formatNextScheduledRun(nextRunAt: number | null, enabled = true, nowMs = Date.now()): string {
    if (nextRunAt === null || nextRunAt <= nowMs) return t(enabled ? 'automations.list.nextRunPending' : 'automations.list.noNextRun');
    return t('workflows.triggers.row.nextRun', { time: formatNextScheduledRunTime(nextRunAt, enabled, nowMs) });
}

/**
 * The same occurrence as a bare time ("in 3 h", "tomorrow"), for a trailing meta column whose
 * position already says "next": a due or unscheduled occurrence is the one word "Pending" (the
 * sentence form would crowd the title it qualifies), and a disabled one says it has none.
 */
export function formatNextScheduledRunTime(nextRunAt: number | null, enabled = true, nowMs = Date.now()): string {
    // A retained occurrence is not a future promise once it is due. Only the scheduler can
    // publish its successor; elapsed-age wording would describe a different fact (a past Run).
    if (nextRunAt === null || nextRunAt <= nowMs) return t(enabled ? 'workflows.triggers.row.nextPending' : 'automations.list.noNextRun');
    const { days, minutes } = scheduledRunTimeUnits(nextRunAt, nowMs);
    return days > 0
        ? t('workflows.triggers.row.nextDays', { count: days })
        : minutes < 60 ? t('workflows.triggers.row.nextMinutes', { count: Math.max(1, minutes) })
            : t('workflows.triggers.row.nextHours', { count: Math.round(minutes / 60) });
}

/** The occurrence label's actual calendar, rounded-minute/hour, or due boundary. */
export function readNextScheduledRunRefreshAtMs(nextRunAt: number | null, nowMs: number): number | null {
    if (nextRunAt === null || !Number.isFinite(nextRunAt) || !Number.isFinite(nowMs) || nextRunAt <= nowMs) return null;
    const { days, minutes } = scheduledRunTimeUnits(nextRunAt, nowMs);
    if (days > 0) {
        const now = new Date(nowMs);
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    }
    if (minutes <= 1) return nextRunAt;
    const nextMinutes = minutes < 60 ? minutes - 1 : Math.max(59, Math.round(minutes / 60) * 60 - 31);
    // Math.round retains the upper value at a half minute: the lower label starts one ms later.
    return nextRunAt - (nextMinutes + 0.5) * MINUTE_MS + 1;
}

/** A scheduler occurrence surrounded by the retained qualifier's static facts. */
export type ScheduledRunQualifierTime = Readonly<{ atMs: number; prefix?: string; suffix?: string }>;

export function formatScheduledRunQualifier(time: ScheduledRunQualifierTime, nowMs: number, enabled = true): string {
    return [time.prefix, formatNextScheduledRun(time.atMs, enabled, nowMs), time.suffix].filter(Boolean).join('\n');
}

/** A firing without accepted lifecycle evidence says only that it ran. */
export function formatTriggerLastOutcome(age: string, state?: string): string {
    return state === undefined ? t('workflows.triggers.row.ran', { age })
        : t('workflows.triggers.row.lastOutcome', { state, age });
}

/** Exact scheduler time for spoken labels, alongside the compact visible occurrence. */
export function formatNextScheduledRunAccessibilityLabel(nextRunAt: number | null, enabled = true, nowMs = Date.now()): string {
    return nextRunAt === null || nextRunAt <= nowMs ? formatNextScheduledRun(null, enabled, nowMs)
        : t('workflows.triggers.row.nextRun', { time: formatWithCachedDateTimeFormatter(nextRunAt, getPreferredLanguage(),
            { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
                second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }) });
}

/**
 * The one "when" summary of a trigger (FIN 04 §5.4, 07 S4): the chip, the Runs automatically row,
 * the column's Triggers rows and a session's trigger groups all read it from here, so the same
 * trigger reads the same everywhere ("Every day at 09:00", "When a turn ends").
 *
 * It accepts the list projection, the private detail and an editor draft alike: each carries the
 * kind and the fields this reads. A plugin event without a display label names its event.
 */
export type TriggerSummarySource =
    | Pick<AutomationActionTrigger, 'kind' | 'phase' | 'actionIds' | 'mode' | 'onFailure'>
    | Readonly<{
        kind: 'schedule';
        schedule: Readonly<{ kind: 'once'; scheduledAt: number }>
            | Readonly<{ kind: 'cron' | 'interval'; scheduleExpr: string | null; everyMs: number | null }>;
    }>
    | (Pick<AutomationPluginEventTrigger, 'kind' | 'eventRef'> & Readonly<{ displayLabel?: string }>
        & Partial<Pick<AutomationPluginEventTrigger, 'observation'>>
        & Partial<Pick<AutomationPluginEventDefinitionTrigger, 'observationTransport'>>)
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

/** The sentence a calendar cron reads as, or null when it can't be said and only its expression is true. */
function formatCronSentence(expression: string): string | null {
    const calendar = parseCalendarSchedule(expression);
    if (calendar === null) return null;
    if (calendar.repeat === 'hourly') return t('workflows.triggers.summary.hourlyAt', { minute: String(calendar.minute).padStart(2, '0') });
    const time = joinList(calendar.times.map(formatClockTime));
    switch (calendar.repeat) {
        case 'daily':
            return t('workflows.triggers.summary.everyDayAt', { time });
        case 'weekly':
            return calendar.weekdays.join(',') === '1,2,3,4,5' ? t('workflows.triggers.summary.weekdaysAt', { time })
                : t('workflows.triggers.summary.weeklyAt', { day: joinList(calendar.weekdays.map(weekdayName)), time });
        case 'monthly':
            return t('workflows.triggers.summary.monthlyAt', { days: joinList(calendar.days.map(String)), count: calendar.days.length, time });
        case 'yearly':
            return calendar.months.length === 1 && calendar.days.length === 1
                ? t('workflows.triggers.summary.yearlyAt', { date: formatCalendarDate({ month: calendar.months[0]!, day: calendar.days[0]! }), time })
                : t('workflows.triggers.summary.monthDaysAt', { days: joinList(calendar.days.map(String)), count: calendar.days.length,
                    months: joinList(calendar.months.map(formatMonthName)), time });
    }
}

/** A cron reads as one sentence everywhere; only one that can't be said shows its expression (QA-RERUN-1113 F1). */
function formatCron(expression: string): string {
    return formatCronSentence(expression) ?? t('workflows.triggers.summary.cron', { expression: expression.trim() });
}

/** "Every hour", "Every 15 minutes": an interval schedule's one wording. */
export function formatTriggerInterval(everyMs: number): string {
    const minutes = Math.max(1, Math.round(everyMs / MINUTE_MS));
    return minutes % 60 === 0
        ? t('workflows.triggers.summary.everyHours', { count: minutes / 60 })
        : t('workflows.triggers.summary.everyMinutes', { count: minutes });
}

export type SessionLifecycleKind = keyof typeof AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1;

/**
 * The kind a session event reads as: turn-end events fire together as one "When a turn ends"; the
 * attention, start and archive events are their own kinds (07 S16).
 */
export function readSessionLifecycleKind(events: readonly AutomationSessionLifecycleEvent[]): SessionLifecycleKind {
    const groups = AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1;
    return (Object.keys(groups) as SessionLifecycleKind[]).find(kind =>
        events.length > 0 && events.every(event => (groups[kind] as readonly AutomationSessionLifecycleEvent[]).includes(event))) ?? 'turnEnds';
}

export type TriggerSummaryContext = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    projection?: Pick<DaemonMergedProjectionInputs, 'automationEligibleEvents' | 'pluginUiProjection'> | null;
    localize?: PluginLocalizedTextResolver;
    /** A mounted Action catalog may supply its already-localized contributed titles. */
    actionTitle?: (actionId: string) => string | undefined;
}>;

export type ActionTriggerSummaryFacts = Readonly<Pick<AutomationActionTrigger, 'phase' | 'mode' | 'onFailure'> & {
    actions: readonly Readonly<{ actionId: string; title: string }>[];
}>;

/** Authored Action policy and canonical catalog labels, without inventing matching or defaults. */
export function readActionTriggerSummaryFacts(
    trigger: Pick<AutomationActionTrigger, 'phase' | 'actionIds' | 'mode' | 'onFailure'>,
    context?: TriggerSummaryContext,
): ActionTriggerSummaryFacts {
    return { phase: trigger.phase,
        actions: trigger.actionIds.map(actionId => ({ actionId,
            title: context?.actionTitle?.(actionId) ?? resolveActionTitle(actionId, findActionSpec(actionId) ?? null) })),
        ...(trigger.mode === undefined ? {} : { mode: trigger.mode }),
        ...(trigger.onFailure === undefined ? {} : { onFailure: trigger.onFailure }),
    };
}

/**
 * What a wait-mode "before an Action" trigger makes this workflow's Result decide (05 S4 Result line), or `null`
 * when no such trigger is set: its run passing lets the Action go ahead, its failing refuses it with the reply.
 */
export function formatTriggerResultDecides(triggers: readonly Readonly<{ kind: string }>[], context?: TriggerSummaryContext): string | null {
    const titles = new Set<string>();
    for (const trigger of triggers) {
        if (!isActionTriggerSource(trigger) || trigger.phase !== 'before' || trigger.mode === 'notify') continue;
        for (const fact of readActionTriggerSummaryFacts(trigger, context).actions) titles.add(fact.title);
    }
    return titles.size === 0 ? null : t('workflows.triggers.card.decides', { action: joinList([...titles]) });
}

function isActionTriggerSource(trigger: Readonly<{ kind: string }>): trigger is Extract<TriggerSummarySource, { kind: 'action' }> {
    return trigger.kind === 'action';
}

function readDeclaredEventTitle(trigger: Extract<TriggerSummarySource, { kind: 'pluginEvent' }>, context?: TriggerSummaryContext): string | null {
    const observation = trigger.observation;
    const transport = trigger.observationTransport;
    const machineId = context?.machineId ?? (observation
        ? observation.kind === 'durablePush' ? observation.endpointMaterializationRef?.machineId : observation.watcher?.machineId
        : transport?.kind === 'durablePush' ? transport.endpointMaterializationRef.machineId : transport?.watcherMaterializationRef.machineId);
    const cached = context?.projection === undefined ? readCachedDaemonMergedProjectionCacheEntry({
        machineId, serverId: context?.serverId, sections: ['automationEligibleEvents'],
    }) : null;
    const projection = context?.projection ?? (cached && cached.kind !== 'unsupported' ? cached.inputs : null);
    const event = projection?.automationEligibleEvents?.find((entry) =>
        arePluginContributionIdentitiesEqual(entry.event.identity, trigger.eventRef));
    if (!event) return null;
    const pluginUiProjection = projection?.pluginUiProjection ?? null;
    const localize = context?.localize ?? createPluginLocalizedTextResolver({
        projection: pluginUiProjection, runtime: readCurrentAppShellPluginUiTranslationRuntime(pluginUiProjection),
    });
    return readEligibleEventPresentation(event, localize).title;
}

export function formatTriggerSummary(trigger: TriggerSummarySource, context?: TriggerSummaryContext): string {
    switch (trigger.kind) {
        case 'action': {
            // The trigger block's sentence (lab `actrig:v:before`): before waits or starts beside, after follows.
            const facts = readActionTriggerSummaryFacts(trigger, context);
            if (facts.actions.length === 0) return t(facts.phase === 'before' ? 'workflows.triggers.card.actionBefore' : 'workflows.triggers.card.actionAfter');
            const action = joinList(facts.actions.map(entry => entry.title));
            if (facts.phase === 'after') return t('workflows.triggers.card.actionSentence.after', { action });
            return t(facts.mode === 'notify' ? 'workflows.triggers.card.actionSentence.beforeNotify' : 'workflows.triggers.card.actionSentence.beforeWait', { action });
        }
        case 'schedule':
            if (trigger.schedule.kind === 'once') return t('workflows.triggers.once.at', {
                time: formatWithCachedDateTimeFormatter(trigger.schedule.scheduledAt, getPreferredLanguage(), {
                    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
                }),
            });
            return trigger.schedule.kind === 'cron' && trigger.schedule.scheduleExpr !== null
                ? formatCron(trigger.schedule.scheduleExpr)
                : trigger.schedule.everyMs !== null
                    ? formatTriggerInterval(trigger.schedule.everyMs)
                    : t('workflows.triggers.summary.schedule');
        case 'pluginEvent': {
            const label = trigger.displayLabel?.trim();
            if (label) return label;
            const title = readDeclaredEventTitle(trigger, context);
            return title ? t('workflows.triggers.summary.event', { event: title }) : t('workflows.triggers.kind.pluginEvent');
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
 * When a workflow runs, as one clause the "When it runs" card and the page's summary line both read:
 * "When you press Run now" with no trigger, else every trigger's sentence joined ("When a turn ends and
 * Every weekday at 09:00"). Run now always works too, so it is said only when nothing else starts it.
 */
export function formatTriggerSetSentence(triggers: readonly TriggerSummarySource[]): string {
    if (triggers.length === 0) return t('workflows.triggers.card.manualSentence');
    return joinList(triggers.map((trigger, index) => index === 0 ? formatTriggerSummary(trigger) : lowerSentenceStart(formatTriggerSummary(trigger))));
}

/**
 * A summary joined after the first continues the sentence ("…and every day at 09:00"). Only a plain
 * capitalised first word is lowered; a name with inner capitals or an acronym ("GitHub", "CI") keeps them.
 */
function lowerSentenceStart(summary: string): string {
    const first = summary.split(/\s/u, 1)[0] ?? '';
    if (!/^\p{Lu}\p{Ll}+$/u.test(first)) return summary;
    return first.toLocaleLowerCase(getPreferredLanguage()) + summary.slice(first.length);
}

/**
 * A trigger set in one string: "Manual" with none, the one summary, or "{first} · {n} more". The
 * header chip and the settings-pane section use this same string for the same draft (04 §9.1).
 */
export function formatTriggerSetSummary(
    triggers: readonly (TriggerSummarySource & Readonly<{ enabled?: boolean; remainingOccurrences?: number | null }>)[],
    /** The set's last Run state, when its owner has read it: a spent one-time schedule says Completed or Missed from it. */
    lastRunState?: string | null,
): string {
    const [first, ...rest] = triggers;
    if (first === undefined) return t('workflows.triggers.summary.manual');
    // A trigger that won't fire says so first, as its row does ("Off · Every day at 2:00 AM"); a spent
    // one-time schedule says how it ended ("Completed · Once at …"), a pending one keeps its due time.
    // A collection row never shows a raw expression: a cron that can't be said reads "On a schedule" there.
    const when = first.kind === 'schedule' && first.schedule?.kind === 'cron'
        && formatCronSentence(first.schedule.scheduleExpr ?? '') === null
        ? t('workflows.triggers.summary.schedule')
        : formatTriggerSummary(first);
    const once = readOnceScheduleState(first, lastRunState);
    const state = formatOnceScheduleStateLabel(once)
        ?? (first.enabled === false ? t('workflows.triggers.row.off') : null);
    const summary = state === null ? when : [state, when].join(' · ');
    return rest.length === 0 ? summary : t('workflows.triggers.summary.more', { first: summary, count: rest.length });
}
