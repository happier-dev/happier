import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { formatWorkflowDefinitionLibraryTitle } from '../presentation/workflowProblemPresentation';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { formatTriggerSetSummary } from '../triggers/formatTriggerSummary';
import { describeLegacyTriggerSet, describeTriggerTarget, isWorkflowTriggerSourceGone } from '../triggers/sessionTriggerGroups';
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

/** Turned off as a whole: the set or every trigger it has. */
export function isWorkflowLibraryTriggerSetOff(set: WorkflowTriggerSetV1): boolean {
    return !set.enabled || (set.triggers.length > 0 && set.triggers.every(trigger => !trigger.enabled));
}

export function describeAccountWorkflowLibraryRecord(set: WorkflowTriggerSetV1, summary?: WorkflowAutomationRunSummary) {
    const sourceGone = isWorkflowTriggerSourceGone(set);
    const inline = set.target?.kind === 'inline' ? set.target.definition.blocks : null;
    const standaloneAction = inline?.length === 1 && inline[0]?.kind === 'action' ? inline[0] : undefined;
    const triggerSummary = formatTriggerSetSummary(set.triggers, summary?.lastRun?.state, {
        offSaidElsewhere: isWorkflowLibraryTriggerSetOff(set),
        ...(inline === null ? {} : { form: 'clause' }),
    });
    // Automatic deployment observers can store their Environment identity as the name.
    const named = set.name === set.automationId || set.name === set.observationOnly?.deploymentEnvironment?.environmentId
        ? undefined : set.name;
    const name = sourceGone ? t('workflows.triggers.row.workflowUnavailable')
        : named ?? describeLegacyTriggerSet(set)?.title
            ?? (standaloneAction ? workflowBlockReferenceLabel(standaloneAction)
                : set.observationOnly ? triggerSummary : describeTriggerTarget(set.target, () => null));
    return { name, sourceGone, triggerSummary };
}

/** One projection and ordering for saved definitions and standalone Account Workflows. No reads. */
export function projectWorkflowLibraryRecords(input: Readonly<{
    definitions: Readonly<{ library: readonly WorkflowLibraryDefinition[]; sharedWithYou: readonly WorkflowLibraryDefinition[] }>;
    accountTriggers: readonly WorkflowTriggerSetV1[];
    summaries: ReadonlyMap<string, WorkflowLibraryRunSummary> | null;
    automationSummaries: ReadonlyMap<string, WorkflowAutomationRunSummary> | null;
    savedLibraryIncomplete?: boolean;
    inventoryPending?: boolean;
    previous?: readonly WorkflowLibraryRecordRow[];
}>): readonly WorkflowLibraryRecordRow[] {
    if (input.inventoryPending) return input.previous ?? [];
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
    const representedDefinitions = new Set(definitions.map(row => row.key));
    const triggers = input.accountTriggers.flatMap((set): WorkflowLibraryRecordRow[] => {
        if (set.scopeSessionId) return [];
        const definitionRef = set.target?.kind === 'workflow' ? set.target.ref : null;
        if (definitionRef !== null && (representedDefinitions.has(definitionRef)
            || (input.savedLibraryIncomplete && !isWorkflowTriggerSourceGone(set)))) return [];
        const lastRunSummary = input.automationSummaries?.get(set.automationId);
        const { name, sourceGone, triggerSummary } = describeAccountWorkflowLibraryRecord(set, lastRunSummary);
        // Nothing of a gone source is editable, so its row is one press: remove the retained set.
        const triggerOpenTargets = (set.triggers.length && !sourceGone ? set.triggers.map(trigger => trigger.id) : [null]).map(triggerId => ({
            kind: 'accountTrigger' as const, automationId: set.automationId, triggerId,
        }));
        return [{
            key: `account-trigger:${set.automationId}`, group: 'library', accountTrigger: set,
            name,
            triggerSummary,
            updatedAt: set.updatedAt ?? 0,
            lastRunSummary,
            openTarget: triggerOpenTargets[0]!, triggerOpenTargets,
        }];
    });
    // The existing Library is updated_desc with descending identity as its tie-breaker.
    const previousByKey = new Map(input.previous?.map(row => [row.key, row]));
    // List sources can overlap; one identity has one row in both the column and Library.
    const recordsByKey = new Map<string, WorkflowLibraryRecordRow>();
    for (const row of [...definitions, ...triggers]) {
        if (!recordsByKey.has(row.key)) recordsByKey.set(row.key, row);
    }
    const ordered = [...recordsByKey.values()].map(row => {
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
