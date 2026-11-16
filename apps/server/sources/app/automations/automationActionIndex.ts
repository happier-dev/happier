import type { Prisma } from '@prisma/client';
import { ActionAutomationIndexRowV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { automationSubjectSharedKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { automationActionTriggerConfigurationSelect, decodeAutomationActionTriggerConfiguration,
    type AutomationActionTriggerColumns } from './automationActionTriggerConfiguration';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { afterTx, type Tx } from '@/storage/inTx';
import { emitAutomationUpsert } from './automationChangePublisher';

/** The seed and each pushed replacement read routing facts, never private definitions. */
export const automationActionIndexSelect = {
    id: true, accountId: true, workflowDefinitionId: true, scopeSessionId: true,
    templateVersion: true, enabled: true, deletedAt: true, updatedAt: true,
    triggers: { where: { kind: 'action' }, select: {
        id: true, kind: true, revision: true, enabled: true, deletedAt: true, ...automationActionTriggerConfigurationSelect,
    } },
} satisfies Prisma.AutomationSelect;
type SelectedDefinition = Prisma.AutomationGetPayload<{ select: typeof automationActionIndexSelect }>;
export type AutomationActionIndexDefinition = Readonly<Omit<SelectedDefinition, 'triggers' | 'deletedAt'> & {
    deletedAt?: Date | null;
    triggers: readonly (Readonly<Pick<SelectedDefinition['triggers'][number], 'id' | 'kind' | 'revision' | 'enabled' | 'deletedAt'>>
        & AutomationActionTriggerColumns)[];
}>;
export type AutomationActionIndexRow = ReturnType<typeof ActionAutomationIndexRowV1Schema.parse>;

/** Stored write-time reach decides shared summaries and host tuples at the same owner. */
export function canProjectSharedAutomationTriggerSummary(
    definition: Readonly<{ scopeSessionId: string | null; workflowDefinitionId: string | null }>,
    trigger: Pick<AutomationActionTriggerColumns, 'reachesOthers' | 'subjectKey' | 'subjectKind'>,
): boolean {
    return Boolean(definition.workflowDefinitionId !== null && trigger.reachesOthers && trigger.subjectKey
        && trigger.subjectKind !== 'plugin' && definition.scopeSessionId === null);
}

/** Step revisions come from W's body owner, independently of trigger-set edits. */
export async function readAutomationActionWorkflowRevisionsInTx(tx: Tx,
    rows: readonly AutomationActionIndexDefinition[]): Promise<ReadonlyMap<string, number>> {
    const workflowIds = [...new Set(rows.flatMap(row => row.workflowDefinitionId && row.triggers.some(trigger => trigger.kind === 'action')
        ? [row.workflowDefinitionId] : []))];
    const revisions = new Map<string, number>();
    for (const ids of portableQueryChunks({ values: workflowIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        const artifacts = await tx.artifact.findMany({ where: { id: { in: [...ids] }, deletedAt: null },
            select: { id: true, bodyVersion: true } });
        for (const artifact of artifacts) revisions.set(artifact.id, artifact.bodyVersion);
    }
    return revisions;
}

/** Own and shared references share one decoder and shape; shared keys disclose no resource id. */
export function projectAutomationActionIndexRows(row: AutomationActionIndexDefinition,
    workflowRevisions: ReadonlyMap<string, number>, shared = false): AutomationActionIndexRow[] {
    if (!row.enabled || row.deletedAt != null) return [];
    const workflowId = row.workflowDefinitionId ?? row.id;
    const reference = parseWorkflowDefinitionRefV1(row.workflowDefinitionId);
    const workflowRevision = reference?.kind === 'artifact' ? workflowRevisions.get(reference.artifactId) : row.templateVersion;
    return row.triggers.flatMap(trigger => {
        if (trigger.kind !== 'action' || !trigger.enabled || trigger.deletedAt !== null) return [];
        const configuration = decodeAutomationActionTriggerConfiguration(trigger);
        const identity = { automationId: row.id, triggerId: trigger.id, triggerRevision: trigger.revision,
            workflowId, workflowRevision, ownerAccountId: row.accountId };
        if ('consentFor' in configuration) {
            return shared ? [] : [ActionAutomationIndexRowV1Schema.parse({ ...identity, workflowRevision: configuration.consentedWorkflowRevision,
                consentFor: configuration.consentFor, consentedWorkflowRevision: configuration.consentedWorkflowRevision })];
        }
        if (workflowRevision === undefined) return [];
        if (shared && !canProjectSharedAutomationTriggerSummary(row, configuration)) return [];
        const { kind: _kind, ...matching } = configuration;
        return [ActionAutomationIndexRowV1Schema.parse({ ...identity, ...matching,
            ...(shared && configuration.subjectKey
                ? { subjectKey: automationSubjectSharedKeyV1(configuration.subjectKey, workflowId) } : {}) })];
    }).sort((left, right) => left.triggerId.localeCompare(right.triggerId));
}

/** Existing Artifact writers pass their already-decided audience and publication cursors. */
export async function publishWorkflowActionIndexChangedInTx(tx: Tx, input: Readonly<{
    workflowId: string;
    recipients: readonly import('@/app/changes/markAccountChanged').AccountChangePublication[];
    admittedAccountIds: readonly string[];
    /** A body writer passes its new revision without rereading its own write. */
    workflowRevision?: number;
    removed?: boolean;
    /** Grant owners publish only newly admitted or removed readers. */
    previousAccountIds?: readonly string[];
}>): Promise<void> {
    if (input.recipients.length === 0) return;
    const definitions = await tx.automation.findMany({ where: { workflowDefinitionId: input.workflowId,
        triggers: { some: { kind: 'action' } } }, select: automationActionIndexSelect });
    if (definitions.length === 0) return;
    const revisions = input.workflowRevision === undefined ? await readAutomationActionWorkflowRevisionsInTx(tx, definitions)
        : new Map([[input.workflowId, input.workflowRevision]]);
    const admitted = new Set(input.admittedAccountIds);
    const previous = input.previousAccountIds ? new Set(input.previousAccountIds) : undefined;
    for (const definition of definitions) {
        // Reference-only consent rows freeze the reviewed W revision.
        const ownRows = projectAutomationActionIndexRows(definition, revisions).filter(row => !row.consentFor);
        const sharedRows = projectAutomationActionIndexRows(definition, revisions, true);
        for (const recipient of input.recipients) {
            if (previous && previous.has(recipient.accountId) === admitted.has(recipient.accountId)) continue;
            const activeRows = recipient.accountId === definition.accountId ? ownRows : sharedRows;
            if (activeRows.length === 0) continue;
            const rows = input.removed || !admitted.has(recipient.accountId) ? [] : activeRows;
            afterTx(tx, () => emitAutomationUpsert({ accountId: recipient.accountId, automation: definition,
                cursor: recipient.resolveCursor(), actionIndex: { automationId: definition.id, rows } }));
        }
    }
}
