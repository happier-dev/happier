import { WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListResultV1Schema, WorkflowRunSummariesResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createWorkflowDefinitionFixture } from './workflowRunFixtures';

// Scripted server facts consumed only by the real HTTP response fixture.
let definitions = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'].map(definitionId => ({
    kind: 'workflow-definition.v1' as const, definitionId,
    revision: { headerVersion: 1, bodyVersion: 1 },
    metadata: { title: definitionId === '10000000-0000-4000-8000-000000000001' ? 'Quarterly planning with a deliberately long workflow title' : 'Neighbor workflow' },
    ownerAccountId: 'account-a', access: 'owner' as const,
    contentStatus: 'available' as const, stepCount: 3, triggers: [], nextRunAt: null,
}));
let pending: { definitionId: string; resolve: (result: ActionExecuteResult) => void } | null = null;
let currentAccount: 'account-a' | 'account-b' = 'account-a';
export function getLibraryFixtureAccountId() { return currentAccount; }
export function isLibraryDeletionPending() { return pending !== null; }
export function switchLibraryAccount() { currentAccount = 'account-b'; }
export function configureSingleLibraryDefinition() {
    definitions = definitions.filter(row => row.definitionId === '10000000-0000-4000-8000-000000000001');
}
export function settleLibraryDeletion(success: boolean) {
    if (!pending) throw new Error('No deletion is pending');
    const { definitionId, resolve } = pending;
    pending = null;
    if (success) definitions = definitions.filter(row => row.definitionId !== definitionId);
    resolve(success ? { ok: true, result: { definitionId, deleted: true } }
        : { ok: false, errorCode: 'workflow_not_found', error: 'Deletion unavailable' });
}
export async function readLibraryFixtureResponse(actionId: string, input: Record<string, unknown>): Promise<ActionExecuteResult> {
        if (actionId === 'workflow.definition.get') {
            const row = definitions.find(row => row.definitionId === input.definitionId);
            if (!row) return { ok: false, errorCode: 'workflow_not_found', error: 'Workflow unavailable' };
            return { ok: true, result: WorkflowDefinitionGetResultV1Schema.parse({ definitionId: row.definitionId,
                revision: row.revision, metadata: row.metadata, access: row.access,
                definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'review',
                    document: { text: 'Review this workflow', references: [], attachments: [] }, result: { kind: 'text' } }] }),
            }) };
        }
        if (actionId === 'workflow.definition.list') return { ok: true, result: WorkflowDefinitionListResultV1Schema.parse({ definitions: definitions.map(row => currentAccount === 'account-a' ? row : {
            ...row, access: 'view', metadata: { title: `Account B ${row.definitionId === '10000000-0000-4000-8000-000000000001' ? 'saved' : 'neighbor'}` },
        }) }) };
        if (actionId === 'workflow.definition.delete') {
            const definitionId = typeof input === 'object' && input !== null && 'definitionId' in input ? String(input.definitionId) : '';
            return new Promise(resolve => { pending = { definitionId, resolve }; });
        }
        if (actionId === 'workflow.run.summaries') return { ok: true, result: WorkflowRunSummariesResultV1Schema.parse({
            summaries: definitions.map(row => ({ sourceArtifactId: row.definitionId, recent: [], lastRun: null,
                needsYouCount: currentAccount === 'account-a' && row.definitionId === '10000000-0000-4000-8000-000000000001' ? 1 : 0,
                needsYouRunId: currentAccount === 'account-a' && row.definitionId === '10000000-0000-4000-8000-000000000001' ? 'waiting-run' : null })),
            remainingSourceArtifactIds: [],
        }) };
        if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
        if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
        return { ok: false, errorCode: 'unexpected', error: 'Unexpected harness Action' };
}
