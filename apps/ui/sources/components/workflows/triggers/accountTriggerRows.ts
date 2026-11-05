import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol';

import type { IconName } from '@/components/ui/icons/Icon';

import { formatTriggerSetSummary } from './formatTriggerSummary';
import { describeLegacyTriggerSet, describeTriggerTarget } from './sessionTriggerGroups';
import { resolveTriggerEventGroup } from './triggerEventGroups';

export type AccountTriggerRow = Readonly<{
    automationId: string;
    triggerId: WorkflowTriggerSetV1['triggers'][number]['id'] | null;
    /** "{when}": this trigger's summary (07 S1, 04 §3.3); a manual set leads with what it runs instead. */
    title: string;
    /** The event's glyph, as every trigger list draws it; a manual set reads as the Manual row's play. */
    glyph: IconName;
    /** "{then}": what it runs, or "Workflow deleted" when its source is gone. */
    subtitle: string;
    /** Turned off: the row says "Off". */
    off: boolean;
    legacy?: NonNullable<ReturnType<typeof describeLegacyTriggerSet>>;
}>;

/**
 * What a page's Triggers section is about, and where its new triggers run. A Machine's triggers are the
 * sets that run on it (their project or any placement). An Environment or a deployed service lists the
 * sets that run on its Machine: trigger sets do not name an event's subject yet, so that Machine is the
 * one fact the list can match (OPS-AUTOMATIONS-1102 D2; a subject field on the set would narrow it).
 */
export type TriggerSubject = Readonly<
    | { kind: 'machine'; machineId: string }
    | { kind: 'environment'; machineId: string; environmentId: string }
    | { kind: 'service'; machineId: string; serviceId: string }
>;

function runsOnSubject(set: WorkflowTriggerSetV1, subject: TriggerSubject): boolean {
    return set.project?.machineId === subject.machineId
        || (set.placements ?? []).some((placement) => placement.machineId === subject.machineId);
}

/**
 * The column's Triggers rows (F1): the Account's trigger sets that hold their own steps, exactly as
 * `workflow.trigger.list {scope:'account_inline'}` returns them — the same membership agents read.
 * A saved workflow's triggers and a session's triggers are not in that list.
 */
export function projectAccountTriggerRows(params: Readonly<{
    sets: readonly WorkflowTriggerSetV1[];
    resolveWorkflowTitle: (ref: string) => string | null;
    resolveMachineTitle?: (id: string) => string | null;
    /** A page's own section lists only the sets about its subject. */
    subject?: TriggerSubject;
}>): readonly AccountTriggerRow[] {
    const subject = params.subject;
    const sets = subject ? params.sets.filter((set) => runsOnSubject(set, subject)) : params.sets;
    return sets.flatMap((set) => (set.triggers.length > 0 ? set.triggers : [null]).map((trigger) => {
        const legacy = describeLegacyTriggerSet(trigger ? { ...set, triggers: [trigger] } : set, params.resolveMachineTitle);
        const when = formatTriggerSetSummary(trigger ? [trigger] : []);
        const then = legacy ? `${legacy.title}\n${legacy.qualifier}` : describeTriggerTarget(set.health === 'available' ? set.target : undefined, params.resolveWorkflowTitle);
        // A set with no event is run by hand: "Manual" says nothing that tells one such row from the next, so
        // what it runs leads and "Manual" is the quiet line (a legacy row keeps its own name).
        const leadsWithThen = trigger === null && !legacy;
        return {
            automationId: set.automationId,
            triggerId: trigger?.id ?? null,
            title: leadsWithThen ? then : when,
            glyph: trigger ? resolveTriggerEventGroup(trigger).glyph : 'play',
            subtitle: leadsWithThen ? when : then,
            off: !set.enabled || trigger?.enabled === false,
            ...(legacy ? { legacy } : {}),
        };
    }));
}
