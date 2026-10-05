import {
    type ActionExecutorContext,
    WorkflowInvocationCompleteReviewRequestV1Schema,
    WorkflowInvocationCompleteReviewResultV1Schema,
    WorkflowInvocationGetResultV1Schema,
    WorkflowInvocationListRequestV1Schema,
    WorkflowInvocationListResultV1Schema,
    WorkflowInvocationPublishDraftRequestV1Schema,
    WorkflowInvocationPublishDraftResultV1Schema,
    WorkflowInvocationRetryResultV1Schema,
    WorkflowRunControlResultV1Schema,
    WorkflowRunDeleteResultV1Schema,
    WorkflowRunGetResultV1Schema,
    type ActionId,
    type WorkflowInvocationCompleteReviewRequestV1,
    type WorkflowInvocationLifecycleV1,
    type WorkflowInvocationPublishDraftRequestV1,
    type WorkflowInvocationRetryInputV1,
    type WorkflowResumeInputV1,
} from '@happier-dev/protocol';

import { callWorkflowAction, type WorkflowActionExecute } from './callWorkflowAction';

import { WorkflowActionError } from './workflowActionError';

/**
 * The exact Run **detail** reader and control caller.
 *
 * Scope boundary, mirroring `workflowRunListActions.ts`: that module owns the
 * collection's paged Run list, this one owns one exact Run — its detail,
 * invocation pages and controls. Neither keeps a Run body cache; bodies belong
 * to the Account-scoped `workflowRunsById` owner.
 *
 * Every operation travels through the one Action front door, so surface
 * enablement, approval routing and provenance stay owned there. Responses are
 * parsed through the canonical result schemas, so a partially migrated server
 * fails closed instead of seeding the store with a guessed row.
 */

type ActionExecute = WorkflowActionExecute;

export function createWorkflowRunDetailActions(dependencies: Readonly<{
    execute?: ActionExecute;
}> = {}) {
    async function call<TResult>(
        actionId: string,
        input: unknown,
        parse: (value: unknown) => TResult,
        signal?: AbortSignal,
        context?: Omit<ActionExecutorContext, 'surface' | 'signal'>,
    ): Promise<TResult> {
        // Dispatch and failure mapping stay at the one shared workflow Action
        // seam; this client only supplies its optional injected executor.
        return callWorkflowAction({
            actionId: actionId as ActionId,
            input,
            parseResult: parse,
            ...(dependencies.execute === undefined ? {} : { execute: dependencies.execute }),
            ...(signal === undefined ? {} : { signal }),
            ...(context === undefined ? {} : { context }),
        });
    }

    return {
        getRun: (runId: string, signal?: AbortSignal) =>
            call('workflow.run.get', { runId }, (value) => WorkflowRunGetResultV1Schema.parse(value), signal),

        /**
         * One page of a Run's invocations. `lifecycles` asks the server's
         * canonical index, so an actionable row is reachable without paging the
         * whole history; the opaque cursor binds every supplied filter, so a
         * caller must not mix cursors across filters.
         */
        listInvocations: (input: Readonly<{
            runId: string;
            cursor?: string;
            limit?: number;
            parentRecordId?: string;
            lifecycles?: readonly WorkflowInvocationLifecycleV1[];
        }>, signal?: AbortSignal) =>
            call(
                'workflow.run.invocations.list',
                WorkflowInvocationListRequestV1Schema.parse({
                    runId: input.runId,
                    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                    ...(input.parentRecordId === undefined ? {} : { parentRecordId: input.parentRecordId }),
                    ...(input.lifecycles === undefined ? {} : { lifecycles: [...input.lifecycles] }),
                }),
                (value) => WorkflowInvocationListResultV1Schema.parse(value),
                signal,
            ),

        /**
         * One exact historical attempt, including its sealed private content.
         * The server authorizes and validates the outer envelope; opening it is
         * the authorized client's own Account-content step, never the server's.
         */
        getInvocation: (input: Readonly<{ runId: string; invocationId: string }>, signal?: AbortSignal) =>
            call('workflow.run.invocations.get', input, (value) => WorkflowInvocationGetResultV1Schema.parse(value), signal),

        pauseRun: (input: Readonly<{ runId: string; expectedRevision: number }>, signal?: AbortSignal) =>
            call('workflow.run.pause', input, (value) => WorkflowRunControlResultV1Schema.parse(value), signal),
        resumeRun: (input: WorkflowResumeInputV1, signal?: AbortSignal) =>
            call('workflow.run.resume', input, (value) => WorkflowRunControlResultV1Schema.parse(value), signal),
        restoreWorkspace: (input: WorkflowResumeInputV1, machineId: string, signal?: AbortSignal) =>
            call(
                'workflow.run.resume',
                input,
                (value) => WorkflowRunControlResultV1Schema.parse(value),
                signal,
                { externalActionTarget: { kind: 'machine', machineId } },
            ),
        cancelRun: (input: Readonly<{ runId: string; expectedRevision: number }>, signal?: AbortSignal) =>
            call('workflow.run.cancel', input, (value) => WorkflowRunControlResultV1Schema.parse(value), signal),
        retryInvocation: (input: WorkflowInvocationRetryInputV1, signal?: AbortSignal) =>
            call('workflow.run.invocations.retry', input, (value) => WorkflowInvocationRetryResultV1Schema.parse(value), signal),
        completeReview: (input: WorkflowInvocationCompleteReviewRequestV1, signal?: AbortSignal) =>
            call(
                'workflow.run.invocations.complete_review',
                WorkflowInvocationCompleteReviewRequestV1Schema.parse(input),
                (value) => WorkflowInvocationCompleteReviewResultV1Schema.parse(value),
                signal,
            ),
        publishDraft: (input: WorkflowInvocationPublishDraftRequestV1, signal?: AbortSignal) =>
            call(
                'workflow.run.invocations.publish_draft',
                WorkflowInvocationPublishDraftRequestV1Schema.parse(input),
                (value) => WorkflowInvocationPublishDraftResultV1Schema.parse(value),
                signal,
            ),
        deleteRun: (input: Readonly<{ runId: string; expectedRevision: number }>, signal?: AbortSignal) =>
            call('workflow.run.delete', input, (value) => WorkflowRunDeleteResultV1Schema.parse(value), signal),
    } as const;
}

export type WorkflowRunDetailActions = ReturnType<typeof createWorkflowRunDetailActions>;

/** The shared instance product surfaces use. */
export const workflowRunDetailActions = createWorkflowRunDetailActions();
