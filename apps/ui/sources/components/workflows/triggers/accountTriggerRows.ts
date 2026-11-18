import { readManagedMachineTriggerAction } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import type { WorkflowAttachedTriggerPageV1, WorkflowAttachedTriggerV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import type { IconName } from '@/components/ui/icons/Icon';

import { formatTriggerSetSummary } from './formatTriggerSummary';
import { describeLegacyTriggerSet, describeTriggerTarget, isWorkflowTriggerSourceGone } from './sessionTriggerGroups';
import { resolveTriggerEventGroup } from './triggerEventGroups';

export type AccountTriggerRow = Readonly<{
    automationId: string;
    triggerId: WorkflowTriggerSetV1['triggers'][number]['id'] | null;
    /** "{when}": this trigger's summary (07 S1, 04 §3.3); a manual set leads with what it runs instead. */
    title: string;
    /** The event's glyph, as every trigger list draws it; a manual set reads as the Manual row's play. */
    glyph: IconName;
    /** "{then}": what it runs, or the neutral unavailable line when its source is gone. */
    subtitle: string;
    /** What it runs is a saved workflow whose name is still being read: the row holds its title slot. */
    subtitlePending?: true;
    /** Turned off: the row says "Off". */
    off: boolean;
    /** Its Workflow can no longer be opened: the row offers only Remove trigger. */
    sourceGone?: true;
    legacy?: NonNullable<ReturnType<typeof describeLegacyTriggerSet>>;
    /** Admitted selected-row facts, including relation, author, access, source and last Run. */
    attachment?: WorkflowAttachedTriggerV1;
    /** The trigger kind/phase, distinct from the selected owner's direct/context membership. */
    relation?: Extract<WorkflowAttachedTriggerV1['summary'], { kind: 'action' }>['phase'] | 'event' | 'schedule';
    setUpBy?: WorkflowAttachedTriggerV1['setUpBy'];
    /** Presentation of the admitted Automation author, independent of Workflow permissions. */
    yours?: boolean;
    readOnly?: boolean;
    /** Latest-started Run evidence; omission is unread, null is no Run. */
    outcome?: Readonly<{ state: NonNullable<WorkflowAttachedTriggerV1['lastRun']>['state']; atMs: number }> | null;
}>;

/**
 * Retained host props translated by useResourceAutomationsSection into canonical subject identity.
 * The service page is its Machine's view. New hosts pass AutomationSubjectV1 and explicit execution context.
 */
export type TriggerSubject = Readonly<
    | { kind: 'machine'; machineId: string }
    | { kind: 'environment'; machineId: string; environmentId: string }
    | { kind: 'service'; machineId: string; serviceId: string }
>;

/**
 * The column's Triggers rows (F1): the Account's trigger sets that hold their own steps, exactly as
 * `workflow.trigger.list {scope:'account_inline'}` returns them — the same membership agents read.
 * A saved workflow's triggers and a session's triggers are not in that list.
 */
export function projectAccountTriggerRows(params: Readonly<{
    sets: readonly WorkflowTriggerSetV1[];
    /** The query owner already selected membership; placement never filters this page. */
    attachedPage?: WorkflowAttachedTriggerPageV1;
    accountId?: string;
    resolveWorkflowTitle: (ref: string) => string | null;
    isWorkflowTitlePending?: (ref: string) => boolean;
    resolveMachineTitle?: (id: string) => string | null;
}>): readonly AccountTriggerRow[] {
    if (params.attachedPage) {
        const setsById = new Map(params.sets.map(set => [set.automationId, {
            set, triggers: new Map(set.triggers.map(trigger => [trigger.id, trigger])),
        }]));
        return params.attachedPage.attached.map<AccountTriggerRow>(attachment => {
            const yours = attachment.setUpBy.accountId === params.accountId;
            const selected = setsById.get(attachment.automationId);
            const set = selected?.set;
            const trigger = selected?.triggers.get(attachment.triggerId);
            const legacy = set ? describeLegacyTriggerSet(trigger ? { ...set, triggers: [trigger] } : set, params.resolveMachineTitle) : null;
            const target = set ? set.health === 'available' ? set.target : undefined
                : attachment.workflowDefinitionId ? { kind: 'workflow' as const, ref: attachment.workflowDefinitionId } : undefined;
            return {
                automationId: attachment.automationId,
                triggerId: attachment.triggerId,
                title: formatTriggerSetSummary([attachment.summary]),
                glyph: resolveTriggerEventGroup(attachment.summary).glyph,
                subtitle: legacy ? `${legacy.title}\n${legacy.qualifier}` : describeTriggerTarget(target, params.resolveWorkflowTitle),
                ...(!legacy && target?.kind === 'workflow' && params.isWorkflowTitlePending?.(target.ref) ? { subtitlePending: true as const } : {}),
                off: !attachment.enabled,
                ...(set && isWorkflowTriggerSourceGone(set) ? { sourceGone: true as const } : {}),
                ...(legacy ? { legacy } : {}),
                attachment,
                relation: attachment.summary.kind === 'action' ? attachment.summary.phase
                    : attachment.summary.kind === 'schedule' ? 'schedule' : 'event',
                setUpBy: attachment.setUpBy,
                yours,
                readOnly: !yours || attachment.relation === 'context',
                ...(attachment.lastRun === undefined ? {} : { outcome: attachment.lastRun === null ? null
                    : { state: attachment.lastRun.state, atMs: Date.parse(attachment.lastRun.startedAt) } }),
            };
        });
    }
    return params.sets.flatMap((set) => {
        const triggers = set.triggers.length > 0 ? set.triggers : [null];
        return triggers.map((trigger) => {
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
            ...(isWorkflowTriggerSourceGone(set) ? { sourceGone: true as const } : {}),
            ...(legacy ? { legacy } : {}),
        };
        });
    });
}

/**
 * The `workflow.trigger.remove` request for Delete on an Account trigger row. An inline Workflow exists
 * for its triggers, so deleting its only trigger deletes the Workflow too; no empty Manual Workflow
 * stays in the Library. A saved Workflow keeps its Manual set, and a managed Machine stop/delete rule
 * keeps the retained record that Machine's Keep choice reads. A row without a trigger is the set.
 */
export function accountTriggerRemoval(
    set: Pick<WorkflowTriggerSetV1, 'automationId' | 'target' | 'triggers'>,
    triggerId: WorkflowTriggerSetV1['triggers'][number]['id'] | null,
): Readonly<{ automationId: WorkflowTriggerSetV1['automationId']; triggerId?: WorkflowTriggerSetV1['triggers'][number]['id'] }> {
    const onlyTrigger = set.target?.kind === 'inline' && readManagedMachineTriggerAction(set.target) === null
        && set.triggers.length === 1 && set.triggers[0]?.id === triggerId;
    return triggerId === null || onlyTrigger ? { automationId: set.automationId } : { automationId: set.automationId, triggerId };
}
