import {
    type WorkflowRunPrivateMetadataV1,
    WorkflowRunListRequestV1Schema,
    WorkflowRunListResultV1Schema,
    WorkflowRunSummariesRequestV1Schema,
    WorkflowRunSourceSummariesResultV1Schema,
    type WorkflowRunSourceSummariesResultV1,
    WorkflowRunAutomationSummariesRequestV1Schema,
    WorkflowRunAutomationSummariesResultV1Schema,
    type WorkflowRunAutomationSummariesResultV1,
    type WorkflowRunAcceptedContextV1,
    type WorkflowRunGetResultV1,
} from '@happier-dev/protocol/workflows/actionsV1';
import type {
    WorkflowRunStateV1,
    WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import { callWorkflowAction } from './callWorkflowAction';
import { WorkflowActionError } from './workflowActionError';
import { createWorkflowRunDetailActions, workflowRunDetailActions } from './workflowRunDetailActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { sync } from '@/sync/sync';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

/**
 * The Workflows collection's Run **list** reader.
 *
 * Exact Run detail, invocation pages and run controls remain owned by the
 * Run-detail reader. Role prefill composes that reader with the paged list;
 * it does not implement another detail client. Row bodies are stored by the
 * existing Account-scoped `workflowRunsById` owner; this module never keeps
 * a second cache.
 */

export type WorkflowRunListFilter = Readonly<{
    /**
     * Exact-Run selection. The page stays the lean list projection — one Run
     * summary plus its sparse private metadata — with no usage, checkpoint,
     * definition or invocation reads. Background refresh and transcript
     * initial materialization use this; explicit Run detail keeps the full
     * `workflow.run.get` read.
     */
    runId?: string;
    runIds?: readonly string[];
    invocationProvenance?: readonly Readonly<{ runId: string; invocationRecordIds: readonly string[] }>[];
    sourceArtifactId?: string;
    /** `attention: 'required'` asks the server's indexed predicate, not a cached page. */
    attention?: 'required';
    states?: readonly WorkflowRunStateV1[];
    origin?: 'automation' | 'direct';
    automationId?: string;
    triggerId?: string;
    originSessionId?: string;
    originDiscussionId?: string;
    targetSessionId?: string;
    underSessionId?: string;
    machineId?: string;
}>;

export type WorkflowRunListPage = Readonly<{
    projection?: 'membership';
    runs: readonly WorkflowRunSummaryV1[];
    /**
     * Full pages' sparse private metadata: a missing key is a readable Run
     * whose accepted snapshot opened but carries no authored title — the
     * canonical display projector names it Untitled — while an explicit
     * `unavailable` value is content this host could not open. Membership pages
     * never open private content and leave this map empty instead.
     */
    metadataByRunId: Readonly<Record<string, WorkflowRunPrivateMetadataV1 | null>>;
    supportsAnotherRoundByRunId?: Readonly<Record<string, boolean>>;
    callerAccessByRunId?: Readonly<Record<string, WorkflowRunGetResultV1['callerAccess']>>;
    nextCursor: string | undefined;
    invocationProvenance?: ReturnType<typeof WorkflowRunListResultV1Schema.parse>['invocationProvenance'];
}>;

/**
 * One page of Account-scoped Runs. The opaque cursor binds every supplied
 * filter, so a caller must not mix cursors across filters.
 */
export async function listWorkflowRuns(params: Readonly<{
    projection?: 'membership';
    filter?: WorkflowRunListFilter;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime | null;
}> = {}): Promise<WorkflowRunListPage> {
    const accountLifetime = params.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : params.accountLifetime;
    await sync.awaitBootstrapForegroundAcquisition();
    if (accountLifetime?.isCurrent() === false) {
        throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
    }
    throwIfAborted(params.signal);
    const request = WorkflowRunListRequestV1Schema.parse({
        ...(params.filter ?? {}),
        ...(params.projection === undefined ? {} : { projection: params.projection }),
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    const result = await callWorkflowAction({
        actionId: 'workflow.run.list',
        input: request,
        parseResult: (value) => WorkflowRunListResultV1Schema.parse(value),
        fallbackMessage: 'Workflow run list request failed',
        ...(params.signal === undefined ? {} : { signal: params.signal }),
        ...(params.accountLifetime === undefined && accountLifetime === null ? {} : { accountLifetime }),
    });
    const sidecar = result.metadataByRunId;
    const metadataByRunId: Record<string, WorkflowRunPrivateMetadataV1 | null> = result.projection === 'membership' ? {} : Object.fromEntries(
        result.runs.map((run) => [
            run.id,
            // An omitted key is the current host's readable untitled Run.
            sidecar[run.id] ?? null,
        ]),
    );
    return { runs: result.runs, metadataByRunId, nextCursor: result.nextCursor,
        ...(result.projection === undefined ? {} : { projection: result.projection }),
        ...(result.supportsAnotherRoundByRunId ? { supportsAnotherRoundByRunId: result.supportsAnotherRoundByRunId } : {}),
        ...(result.callerAccessByRunId ? { callerAccessByRunId: result.callerAccessByRunId } : {}),
        ...(result.invocationProvenance ? { invocationProvenance: result.invocationProvenance } : {}) };
}

/** Complete membership for a demanded relation, following the server's response-byte continuations. */
export async function listAllWorkflowRuns(params: Readonly<{
    filter: WorkflowRunListFilter;
    signal: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): Promise<Pick<WorkflowRunListPage, 'runs' | 'metadataByRunId' | 'supportsAnotherRoundByRunId' | 'callerAccessByRunId'>> {
    const runs: WorkflowRunSummaryV1[] = [];
    const metadataByRunId: Record<string, WorkflowRunPrivateMetadataV1 | null> = {};
    const supportsAnotherRoundByRunId: Record<string, boolean> = {};
    const callerAccessByRunId: Record<string, WorkflowRunGetResultV1['callerAccess']> = {};
    let cursor: string | undefined;
    do {
        throwIfAborted(params.signal);
        const page = await listWorkflowRuns({ ...params, ...(cursor === undefined ? {} : { cursor }) });
        throwIfAborted(params.signal);
        runs.push(...page.runs);
        Object.assign(metadataByRunId, page.metadataByRunId);
        Object.assign(supportsAnotherRoundByRunId, page.supportsAnotherRoundByRunId);
        Object.assign(callerAccessByRunId, page.callerAccessByRunId);
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    return { runs, metadataByRunId, supportsAnotherRoundByRunId, callerAccessByRunId };
}

/** FIN §4.8: memory is the starter's newest accepted Run, not another preference store. */
export async function readWorkflowRunRolePrefill(params: Readonly<{
    sourceArtifactId: string;
    accountId: string;
    signal: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): Promise<WorkflowRunAcceptedContextV1['roleOverrides']> {
    const detail = params.accountLifetime === undefined ? workflowRunDetailActions
        : createWorkflowRunDetailActions({ accountLifetime: params.accountLifetime });
    let cursor: string | undefined;
    do {
        const page = await listWorkflowRuns({ filter: { sourceArtifactId: params.sourceArtifactId },
            ...(cursor === undefined ? {} : { cursor }), signal: params.signal,
            ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }) });
        const own = page.runs.find((run) => run.ownerAccountId === params.accountId
            && run.sourceArtifactId === params.sourceArtifactId);
        if (own) {
            const accepted = await detail.getRun(own.id, params.signal);
            if (accepted.run.ownerAccountId !== params.accountId
                || accepted.run.sourceArtifactId !== params.sourceArtifactId) {
                throw new WorkflowActionError({ message: 'Workflow role prefill unavailable', rawCode: 'run_access_denied' });
            }
            return accepted.acceptedContext.roleOverrides;
        }
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
}

/** Lean batch for the rendered saved-workflow page; no Run-detail cache or reads. */
export async function summarizeWorkflowRuns(params: Readonly<{
    sourceArtifactIds: readonly string[]; recent: number; signal?: AbortSignal;
}>): Promise<WorkflowRunSourceSummariesResultV1> {
    return await callWorkflowAction({
        actionId: 'workflow.run.summaries',
        input: WorkflowRunSummariesRequestV1Schema.parse({ sourceArtifactIds: params.sourceArtifactIds, recent: params.recent }),
        parseResult: (value) => WorkflowRunSourceSummariesResultV1Schema.parse(value),
        fallbackMessage: 'Workflow run summaries request failed',
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** Public latest-status facts for demanded Automations; never acquires private Run content. */
export async function summarizeWorkflowAutomationRuns(params: Readonly<{
    automationIds: readonly string[]; signal?: AbortSignal;
}>): Promise<WorkflowRunAutomationSummariesResultV1> {
    return await callWorkflowAction({
        actionId: 'workflow.run.summaries',
        input: WorkflowRunAutomationSummariesRequestV1Schema.parse({ automationIds: params.automationIds }),
        parseResult: (value) => WorkflowRunAutomationSummariesResultV1Schema.parse(value),
        fallbackMessage: 'Workflow run summaries request failed',
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** Shared read windows; starter membership belongs to SessionListFilterV1. */
export const WORKFLOW_RUN_LIST_FILTERS = ['all', 'active', 'attention'] as const;
export type WorkflowRunListFilterId = (typeof WORKFLOW_RUN_LIST_FILTERS)[number] | `automation:${string}` | `trigger:${string}` | `destination:${string}` | `under:${string}`;

/**
 * Projects a filter chip onto the canonical request.
 *
 * **Needs you** asks the server for `attention: 'required'` so an off-page
 * approval is discoverable before this client has loaded any invocation.
 * Boundary-paused alone is deliberately not attention.
 */
export function buildWorkflowRunListFilter(id: WorkflowRunListFilterId): WorkflowRunListFilter {
    if (id.startsWith('automation:')) return { automationId: id.slice('automation:'.length) };
    if (id.startsWith('trigger:')) return { triggerId: id.slice('trigger:'.length) };
    if (id.startsWith('destination:')) return { targetSessionId: id.slice('destination:'.length), ...buildWorkflowRunListFilter('active') };
    if (id.startsWith('under:')) return { underSessionId: id.slice('under:'.length) };
    switch (id) {
        case 'all':
            return {};
        case 'active':
            return { states: ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'interrupted'] };
        case 'attention':
            return { attention: 'required' };
    }
    throw new Error('Unknown workflow Run window');
}
