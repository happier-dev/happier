import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol';

import type { IconName } from '@/components/ui/icons/Icon';

import { formatTriggerSetSummary } from './formatTriggerSummary';
import { describeLegacyTriggerSet, describeTriggerTarget } from './sessionTriggerGroups';
import { resolveTriggerEventGroup } from './triggerEventGroups';

export type AccountTriggerRow = Readonly<{
    automationId: string;
    triggerId: WorkflowTriggerSetV1['triggers'][number]['id'] | null;
    /** "{when}": this trigger's summary (07 S1, 04 §3.3). */
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
 * The column's Triggers rows (F1): the Account's trigger sets that hold their own steps, exactly as
 * `workflow.trigger.list {scope:'account_inline'}` returns them — the same membership agents read.
 * A saved workflow's triggers and a session's triggers are not in that list.
 */
export function projectAccountTriggerRows(params: Readonly<{
    sets: readonly WorkflowTriggerSetV1[];
    resolveWorkflowTitle: (ref: string) => string | null;
    resolveMachineTitle?: (id: string) => string | null;
}>): readonly AccountTriggerRow[] {
    return params.sets.flatMap((set) => (set.triggers.length > 0 ? set.triggers : [null]).map((trigger) => {
        const legacy = describeLegacyTriggerSet(trigger ? { ...set, triggers: [trigger] } : set, params.resolveMachineTitle);
        return {
            automationId: set.automationId,
            triggerId: trigger?.id ?? null,
            title: formatTriggerSetSummary(trigger ? [trigger] : []),
            glyph: trigger ? resolveTriggerEventGroup(trigger).glyph : 'play',
            subtitle: legacy ? `${legacy.title}\n${legacy.qualifier}` : describeTriggerTarget(set.health === 'available' ? set.target : undefined, params.resolveWorkflowTitle),
            off: !set.enabled || trigger?.enabled === false,
            ...(legacy ? { legacy } : {}),
        };
    }));
}
