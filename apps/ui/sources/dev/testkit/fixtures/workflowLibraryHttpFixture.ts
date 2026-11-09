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
/** The saved library's read fails (lab `nav-N5` "Couldn't load"); Built-in and examples still render. */
let definitionListFails = false;
export function configureLibraryReadFailure() { definitionListFails = true; }
export function getLibraryFixtureAccountId() { return currentAccount; }
export function isLibraryDeletionPending() { return pending !== null; }
export function switchLibraryAccount() { currentAccount = 'account-b'; }
/**
 * The design lab's library (`nav-N1`): real-sounding saved workflows, a schedule, a long name and recent
 * runs with a failure and one that needs you, so design lanes judge the composed home on realistic content.
 * Every shape is parsed by its Protocol schema at the response boundary.
 */
let designSceneSummaries: readonly Readonly<{ sourceArtifactId: string; recent: readonly Readonly<{ runId: string; state: string }>[];
    lastRunAgoMs: number | null; needsYouRunId: string | null }>[] | null = null;
export function configureLibraryDesignScene() {
    const scene = [
        ['20000000-0000-4000-8000-000000000001', 'Prepare the 0.3 release', 8, [{ kind: 'schedule', schedule: { kind: 'cron', scheduleExpr: '0 2 * * *', everyMs: null, timezone: 'Europe/Zurich' } }], 'ssssfssn', 7 * 3_600_000],
        ['20000000-0000-4000-8000-000000000002', 'Fix a failing test', 3, [], 'ss', 5 * 86_400_000],
        ['20000000-0000-4000-8000-000000000003', 'Roll out a payments change behind a flag, then watch the error budget', 5, [], 's', 3_600_000],
        ['20000000-0000-4000-8000-000000000004', 'Weekly dependency review', 4, [{ kind: 'schedule', schedule: { kind: 'cron', scheduleExpr: '0 9 * * 1', everyMs: null, timezone: 'Europe/Zurich' } }], 'sssss', 2 * 86_400_000],
        ['20000000-0000-4000-8000-000000000005', 'Triage new issues', 2, [], '', null],
    ] as const;
    definitions = scene.map(([definitionId, title, stepCount, triggers]) => ({
        kind: 'workflow-definition.v1' as const, definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title }, ownerAccountId: 'account-a', access: 'owner' as const,
        contentStatus: 'available' as const, stepCount, triggers: triggers as never, nextRunAt: null,
    }));
    const states = { s: 'succeeded', f: 'failed', n: 'waiting_for_review' } as const;
    designSceneSummaries = scene.map(([definitionId, , , , history, lastRunAgoMs]) => ({
        sourceArtifactId: definitionId,
        recent: [...history].reverse().map((code, index) => ({ runId: `${definitionId}-run-${index}`, state: states[code as keyof typeof states] })),
        lastRunAgoMs,
        needsYouRunId: history.endsWith('n') ? `${definitionId}-run-0` : null,
    }));
}
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
        if (actionId === 'workflow.definition.list' && definitionListFails) return { ok: false, errorCode: 'unavailable', error: 'Library unavailable' };
        if (actionId === 'workflow.definition.list') return { ok: true, result: WorkflowDefinitionListResultV1Schema.parse({ definitions: definitions.map(row => currentAccount === 'account-a' ? row : {
            ...row, access: 'view', metadata: { title: `Account B ${row.definitionId === '10000000-0000-4000-8000-000000000001' ? 'saved' : 'neighbor'}` },
        }) }) };
        if (actionId === 'workflow.definition.delete') {
            const definitionId = typeof input === 'object' && input !== null && 'definitionId' in input ? String(input.definitionId) : '';
            return new Promise(resolve => { pending = { definitionId, resolve }; });
        }
        if (actionId === 'workflow.run.summaries' && designSceneSummaries !== null) return { ok: true, result: WorkflowRunSummariesResultV1Schema.parse({
            summaries: designSceneSummaries.map(row => ({ sourceArtifactId: row.sourceArtifactId, recent: row.recent,
                lastRun: row.lastRunAgoMs === null || row.recent.length === 0 ? null : { ...row.recent[0],
                    createdAt: new Date(Date.now() - row.lastRunAgoMs).toISOString(),
                    startedAt: new Date(Date.now() - row.lastRunAgoMs).toISOString(), finishedAt: null },
                needsYouCount: row.needsYouRunId === null ? 0 : 1, needsYouRunId: row.needsYouRunId })),
            remainingSourceArtifactIds: [],
        }) };
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
