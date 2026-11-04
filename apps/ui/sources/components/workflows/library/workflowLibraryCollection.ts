import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { formatWorkflowDefinitionLibraryTitle } from '../presentation/workflowProblemPresentation';
import { formatTriggerSetSummary } from '../triggers/formatTriggerSummary';
import { describeLegacyTriggerSet, describeTriggerTarget } from '../triggers/sessionTriggerGroups';
import type { WorkflowLibraryDefinition } from './workflowLibraryReads';
import type { WorkflowAutomationRunSummary, WorkflowLibraryRunSummary } from './useWorkflowLibrarySummaries';
import { t } from '@/text';

export type AccountWorkflowOpenTarget = Readonly<{
    kind: 'accountTrigger';
    automationId: string;
    triggerId: WorkflowTriggerSetV1['triggers'][number]['id'] | null;
}>;
export type WorkflowLibraryOpenTarget = Readonly<{ kind: 'definition'; definitionId: string; href: string }> | AccountWorkflowOpenTarget;

type LibraryRecordFacts = Readonly<{
    key: string;
    name: string;
    triggerSummary: string;
    updatedAt: number;
}>;

export type WorkflowLibraryRecordRow = LibraryRecordFacts & (Readonly<{
    group: 'library' | 'sharedWithYou'; definition: WorkflowLibraryDefinition;
    openTarget: Extract<WorkflowLibraryOpenTarget, { kind: 'definition' }>;
    /** Undefined means unread; a present summary with lastRun:null means no run. */
    lastRunSummary: WorkflowLibraryRunSummary | undefined;
}> | Readonly<{
    group: 'library'; accountTrigger: WorkflowTriggerSetV1;
    openTarget: AccountWorkflowOpenTarget;
    lastRunSummary: WorkflowAutomationRunSummary | undefined;
    /** All existing settings editors remain reachable when a Workflow has several triggers. */
    triggerOpenTargets: readonly AccountWorkflowOpenTarget[];
}>);

/** One projection and ordering for saved definitions and standalone Account Workflows. No reads. */
export function projectWorkflowLibraryRecords(input: Readonly<{
    definitions: Readonly<{ library: readonly WorkflowLibraryDefinition[]; sharedWithYou: readonly WorkflowLibraryDefinition[] }>;
    accountTriggers: readonly WorkflowTriggerSetV1[];
    summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null;
    automationSummaries: ReadonlyMap<string, WorkflowAutomationRunSummary> | null;
    previous?: readonly WorkflowLibraryRecordRow[];
}>): readonly WorkflowLibraryRecordRow[] {
    const projectDefinition = (definition: WorkflowLibraryDefinition, group: 'library' | 'sharedWithYou'): WorkflowLibraryRecordRow => ({
        key: definition.definitionId,
        group,
        definition,
        name: formatWorkflowDefinitionLibraryTitle(definition),
        triggerSummary: definition.triggerSummaryErrorCode === undefined ? formatTriggerSetSummary(definition.triggers) : t('common.unavailable'),
        updatedAt: definition.updatedAt ?? 0,
        lastRunSummary: input.summaries?.get(definition.definitionId),
        openTarget: { kind: 'definition', definitionId: definition.definitionId, href: createWorkflowDefinitionRoute(definition.definitionId) },
    });
    const definitions = [
        ...input.definitions.library.map(definition => projectDefinition(definition, 'library')),
        ...input.definitions.sharedWithYou.map(definition => projectDefinition(definition, 'sharedWithYou')),
    ];
    const triggers = input.accountTriggers.map((set): WorkflowLibraryRecordRow => {
        const triggerOpenTargets = (set.triggers.length ? set.triggers.map(trigger => trigger.id) : [null]).map(triggerId => ({
            kind: 'accountTrigger' as const, automationId: set.automationId, triggerId,
        }));
        return {
            key: `account-trigger:${set.automationId}`, group: 'library', accountTrigger: set,
            name: set.name ?? describeLegacyTriggerSet(set)?.title ?? describeTriggerTarget(set.target, () => null),
            triggerSummary: formatTriggerSetSummary(set.triggers), updatedAt: set.updatedAt ?? 0,
            lastRunSummary: input.automationSummaries?.get(set.automationId),
            openTarget: triggerOpenTargets[0]!, triggerOpenTargets,
        };
    });
    // The existing Library is updated_desc with descending identity as its tie-breaker.
    const previousByKey = new Map(input.previous?.map(row => [row.key, row]));
    const ordered = [...definitions, ...triggers].map(row => {
        const previous = previousByKey.get(row.key);
        if (!previous || previous.group !== row.group || previous.lastRunSummary !== row.lastRunSummary
            || previous.name !== row.name || previous.triggerSummary !== row.triggerSummary || previous.updatedAt !== row.updatedAt) return row;
        const unchangedRecord = 'definition' in row
            ? 'definition' in previous && previous.definition === row.definition
            : 'accountTrigger' in previous && previous.accountTrigger === row.accountTrigger;
        return unchangedRecord ? previous : row;
    }).sort((left, right) => right.updatedAt - left.updatedAt || right.key.localeCompare(left.key));
    const previous = input.previous;
    return previous && previous.length === ordered.length && ordered.every((row, index) => previous[index] === row)
        ? previous : ordered;
}
