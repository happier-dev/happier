import { createTriageBulkEntrySessionsController, type TriageBulkSessionsRequestV1, type TriageBulkHostV1 } from './bulkEntrySessionsController.js';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriagePendingPullRequestReviewV1 } from './entrySessionStartController.js';
import { TriageReadActionsResultV1Schema, TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 } from '../actions/actionsCatalogProtocol.js';
import type { TriageRunConfiguredActionInputV1, TriageRunConfiguredActionResultV1 } from '../actions/configuredActionRunProtocol.js';
import { planTriageOfferedActionsV1 } from '../settings/actions.js';
import type { TriagePullRequestReviewChoiceV1, TriageStartEntrySessionResultV1 } from '../actions/entrySessionProtocol.js';
import { continueTriagePullRequestReviewV1 } from './pullRequestReviewContinuation.js';
import { openLinkedSession } from './entrySessionOpen.js';
import { triageEntryRowKey } from '../projection/listWindow.js';

export type TriageConfiguredActionRunHostV1 = TriageBulkHostV1 & TriageStartHostV1;
export type TriageConfiguredActionRunRequestV1 = Readonly<{
    actionId: string;
    entries: TriageBulkSessionsRequestV1['entries'];
    unavailableKeys?: readonly string[];
    destination: 'single' | TriageBulkSessionsRequestV1['destination'];
    settlements?: readonly unknown[];
    reviewChoices?: TriagePullRequestReviewChoiceV1;
    resumeReview?: TriageRunConfiguredActionInputV1['resumeReview'];
}>;

export async function runTriageConfiguredActionV1(
    host: TriageConfiguredActionRunHostV1,
    request: TriageConfiguredActionRunRequestV1,
    options?: Readonly<{ signal?: AbortSignal; mintCreationKey?: () => string }>,
): Promise<TriageRunConfiguredActionResultV1> {
    if (options?.signal?.aborted) return { v: 1, status: 'cancelled' };
    const read = TriageReadActionsResultV1Schema.parse(await host.executeAction(
        TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 }, { signal: options?.signal },
    ));
    if (options?.signal?.aborted) return { v: 1, status: 'cancelled' };
    if (read.availability === 'unavailable') return { v: 1, status: 'unavailable', reason: 'catalogUnavailable' };
    const action = read.actions.find((candidate) => candidate.actionId === request.actionId);
    if (action === undefined) return { v: 1, status: 'unavailable', reason: 'unknownAction' };
    const finishReview = async (pending: TriagePendingPullRequestReviewV1, result: TriageStartEntrySessionResultV1): Promise<TriageRunConfiguredActionResultV1> => {
        const basis = { v: 1 as const, result, reviewInstructions: pending.instructions };
        if (request.reviewChoices === undefined) return { ...basis, status: 'awaitingReview' };
        const continuation = await continueTriagePullRequestReviewV1(host, pending, request.reviewChoices, options);
        if (continuation.kind !== 'settled') return { ...basis, status: continuation.kind === 'unknown'
            ? 'reviewUnknown' : continuation.kind === 'cancelled' ? 'awaitingReview' : 'reviewRefused' };
        const reviewResult = continuation.result;
        if (reviewResult.status !== 'started') return { ...basis, status: 'reviewRefused', reviewResult };
        if (reviewResult.failedEngineIds.length > 0) return { ...basis, status: 'reviewPartial', reviewResult };
        const opened = await openLinkedSession({ execute: async (id, input, cancellation) => host.executeAction(id, input, cancellation),
            sessionId: pending.sessionId, signal: options?.signal });
        return { ...basis, status: 'reviewStarted', reviewResult, sessionOpen: opened.status };
    };
    if (request.resumeReview !== undefined) {
        const { result, instructions } = request.resumeReview;
        const entry = request.entries.length === 1 ? request.entries[0] : undefined;
        if (request.destination !== 'single' || action.target.kind !== 'reviewStart'
            || action.workspaceMode !== 'pull_request' || entry?.workflowSubject !== 'pullRequest'
            || (result.type !== 'linked' && result.type !== 'opened') || result.review === undefined
            || triageEntryRowKey(result.review.entryRef) !== triageEntryRowKey(entry.entryRef)
            || result.review.instance.instance.sourceInstanceId !== entry.sourceInstance?.sourceInstanceId) {
            return { v: 1, status: 'unavailable', reason: 'reviewContinuationMismatch' };
        }
        // Retained facts are input, not authority: the incumbent final Review Action
        // rereads the source/workspace and admits the canonical review.start request.
        return finishReview({ sessionId: result.sessionId, review: result.review, instructions }, result);
    }
    if (request.destination === 'single') {
        const entry = request.entries.length === 1 ? request.entries[0] : undefined;
        if (entry === undefined) return { v: 1, status: 'unavailable', reason: 'singleEntryRequired' };
        if (entry.workflowSubject === null || planTriageOfferedActionsV1([action], entry.workflowSubject).length === 0) {
            return { v: 1, status: 'unavailable', reason: 'actionInapplicable' };
        }
        const owner = createTriageEntrySessionStartController(host, options);
        try {
            owner.getSnapshot().start({ ...entry, action, ...(request.settlements?.[0] === undefined ? {} : { settlement: request.settlements[0] }) });
            const outcome = await owner.waitForSettled();
            if (outcome.phase.kind === 'settled' && outcome.review !== null) {
                return finishReview(outcome.review, outcome.phase.result);
            }
            if (outcome.phase.kind === 'settled') return {
                v: 1, status: 'single', result: outcome.phase.result,
                ...(outcome.review === null ? {} : { reviewInstructions: outcome.review.instructions }),
            };
            if (options?.signal?.aborted) return { v: 1, status: 'cancelled' };
            if (outcome.phase.kind === 'unavailable') return { v: 1, status: 'unavailable', reason: outcome.phase.reason };
            return { v: 1, status: 'seeded' };
        } finally { owner.dispose(); }
    }
    const owner = createTriageBulkEntrySessionsController(host, options);
    const cancel = () => owner.getSnapshot().cancel();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    try {
        owner.getSnapshot().run({ action, entries: request.entries, destination: request.destination, unavailableKeys: request.unavailableKeys,
            settlementForEntries: (entries) => request.settlements?.[
                request.destination === 'oneSessionForAllEntries' ? 0
                    : request.entries.findIndex((candidate) => candidate.key === entries[0]?.key)
            ],
        });
        const { phase } = await owner.waitForSettled();
        if (phase.kind === 'settled') return {
            v: 1, status: 'bulk', unavailableKeys: [...phase.unavailableKeys],
            refusals: phase.refusals.map((refusal) => ({ entryRef: refusal.entry.entryRef, reason: refusal.reason })),
            results: phase.results.map((result) => ({
                creationKey: result.unit.creationKey, entryRefs: result.unit.entries.map((entry) => entry.entryRef),
                status: result.status,
                ...(result.status === 'settled' ? { start: result.outcome.start, entries: [...result.outcome.entries] } : {}),
            })),
        };
        if (phase.kind === 'seeded') return { v: 1, status: 'seeded', entries: [...phase.outcomes],
            refusals: phase.refusals.map((refusal) => ({ entryRef: refusal.entry.entryRef, reason: refusal.reason })),
        };
        if (phase.kind === 'unavailable') return { v: 1, status: 'unavailable', reason: phase.reason };
        return { v: 1, status: 'cancelled' };
    } finally {
        options?.signal?.removeEventListener('abort', cancel);
        owner.dispose();
    }
}
