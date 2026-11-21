import * as React from 'react';
import { ExecutionRunGetResponseSchema, type ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewRunReferenceV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';

import { resolveReviewFollowUpAvailability } from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { normalizeReviewFindingsMessagePayload } from '@/components/sessions/reviews/messages/reviewFindingsMessageDisplay';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { isExecutionRunTargetUnavailable } from '@/sync/runtime/executionRuns/executionRunHeaderReads';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ReviewFindingsMember } from '../finding/useReviewFindingsModel';

type Reference = Extract<ReviewRunReferenceV1, { kind: 'execution' }>;
export type ReviewQuestionRunsUnavailableReason = 'temporarily_unavailable' | 'run_missing' | 'read_failed';
export type ReviewQuestionRunsState =
    | Readonly<{ kind: 'loading' | 'no_questions' | 'ready' }>
    | Readonly<{ kind: 'unavailable'; reason: ReviewQuestionRunsUnavailableReason }>;

type Read = Readonly<{
    key: string;
    runId: string;
    member: ReviewFindingsMember | null;
    /** The reviewer run's public state (who ran it, on which model, how it ended), last known on a failed read. */
    run: ExecutionRunPublicState | null;
    /** How many findings its retained result holds; `null` when it published none. */
    findingsCount: number | null;
    unavailableReason: ReviewQuestionRunsUnavailableReason | null;
}>;

/** One reviewer run of the round as its Machine last answered. */
export type ReviewRoundRunRead = Pick<Read, 'run' | 'findingsCount' | 'unavailableReason'>;

function readUnavailableReason(error: unknown): ReviewQuestionRunsUnavailableReason {
    const code = error instanceof WorkflowActionError ? error.rawCode : null;
    if (isExecutionRunTargetUnavailable(code)) return 'temporarily_unavailable';
    if (code === 'execution_run_not_found') return 'run_missing';
    return 'read_failed';
}
const EMPTY_RUNS: readonly ReviewRunReferenceV1[] = Object.freeze([]);
const EMPTY_READS: readonly Read[] = Object.freeze([]);
const EMPTY_MEMBERS: readonly ReviewFindingsMember[] = Object.freeze([]);
const EMPTY_RUN_READS: ReadonlyMap<string, ReviewRoundRunRead> = new Map();
const EMPTY_COMMENTS: ReviewFindingsMember['commentByFindingId'] = new Map();
const referenceKey = (reference: Reference) => JSON.stringify([reference.machineId, reference.sessionId ?? null, reference.runId]);

/**
 * The selected round's reviewer runs, read at their original Home and Machine while a tab that shows them is open
 * (Findings for questions, Runs and Activity for who ran and how it ended): one read per run serves all three.
 */
export function useReviewQuestionRuns(params: Readonly<{
    runs: readonly ReviewRunReferenceV1[] | undefined;
    accountLifetime: ServerAccountScopeLifetime | null;
    enabled: boolean;
}>) {
    const runs = params.runs ?? EMPTY_RUNS;
    const references = React.useMemo(() => runs.filter((run): run is Reference => run.kind === 'execution'), [runs]);
    const lifetime = params.accountLifetime;
    const key = React.useMemo(() => JSON.stringify([lifetime?.scope, references]), [lifetime, references]);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ key: string; reads: readonly Read[]; loading: boolean }>>({ key: '', reads: EMPTY_READS, loading: false });
    const [retryVersion, retry] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!params.enabled || !lifetime || references.length === 0) return;
        const controller = new AbortController();
        const pending = new Set<Reference>();
        let loading = false;
        const load = async (requested: readonly Reference[] = references) => {
            for (const reference of requested) pending.add(reference);
            if (loading) return;
            loading = true;
            setSnapshot(previous => previous.key === key && previous.reads.length > 0 ? previous
                : ({ key, reads: previous.key === key ? previous.reads : EMPTY_READS, loading: true }));
            while (pending.size > 0 && !controller.signal.aborted) {
                const requested = [...pending]; pending.clear();
                const next = await Promise.all(requested.map(async (reference): Promise<Read> => {
                    try {
                        const response = await callWorkflowAction({ actionId: 'execution.run.get',
                            input: { sessionId: reference.sessionId ?? null, runId: reference.runId, includeStructured: true, includeLatestToolResult: false },
                            context: { executionRunTargetMachineId: reference.machineId }, accountLifetime: lifetime,
                            signal: controller.signal, parseResult: value => ExecutionRunGetResponseSchema.parse(value) });
                        const payload = response.reviewFindings;
                        const normalized = payload ? normalizeReviewFindingsMessagePayload(payload) : null;
                        const member: ReviewFindingsMember | null = normalized ? {
                            runId: reference.runId, backendId: normalized.runRef.backendId,
                            reviewerLabel: resolveExecutionRunBackendLabel(response.run.backendTarget) ?? normalized.runRef.backendId,
                            sessionId: reference.sessionId ?? null,
                            followUp: resolveReviewFollowUpAvailability(normalized.runRef, { sessionId: reference.sessionId ?? null }),
                            questions: normalized.questions, assumptions: normalized.assumptions,
                            findings: normalized.findings, commentByFindingId: EMPTY_COMMENTS, originalByFindingId: {}, threadsByFindingId: {}, threadRefsByFindingId: {},
                        } : null;
                        return { key: referenceKey(reference), runId: reference.runId, member, run: response.run,
                            findingsCount: normalized ? normalized.findings.length : null, unavailableReason: null };
                    } catch (error) {
                        return { key: referenceKey(reference), runId: reference.runId, member: null, run: null, findingsCount: null,
                            unavailableReason: readUnavailableReason(error) };
                    }
                }));
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                setSnapshot(previous => {
                    const prior = previous.key === key ? previous.reads : EMPTY_READS;
                    const previousByKey = new Map(prior.map(read => [read.key, read]));
                    const updates = new Map(next.map(read => [read.key, read]));
                    const incoming = references.flatMap(reference => {
                        const id = referenceKey(reference);
                        const before = previousByKey.get(id);
                        const update = updates.get(id);
                        return update ? [update.unavailableReason ? { ...update, member: before?.member ?? null, run: before?.run ?? null,
                            findingsCount: before?.findingsCount ?? null } : update] : before ? [before] : [];
                    });
                    const reads = retainKeyedRows(prior, incoming, read => read.key);
                    if (previous.key === key && reads === prior && !previous.loading) return previous;
                    return { key, reads, loading: pending.size > 0 };
                });
            }
            loading = false;
        };
        void load();
        const activity = references.map(reference => subscribeExecutionRunActivity(reference.sessionId
            ? { serverId: lifetime.scope.serverId, sessionId: reference.sessionId }
            : { serverId: lifetime.scope.serverId, machineId: reference.machineId }, event => {
            if (event.runId === null || event.runId === reference.runId) void load([reference]);
        }));
        const reconnect = subscribeHomeAccountChange(event => {
            if (event.source === 'connected' && areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) void load();
        }, { reconnect: 'refresh' });
        return () => { controller.abort(); activity.forEach(dispose => dispose()); reconnect(); };
    }, [params.enabled, lifetime, references, key, retryVersion]);
    const reads = snapshot.key === key ? snapshot.reads : EMPTY_READS;
    const members = React.useMemo(() => reads.length > 0 ? reads.flatMap(read => read.member ? [read.member] : []) : EMPTY_MEMBERS, [reads]);
    const runReads = React.useMemo(() => reads.length > 0 ? new Map(reads.map(read => [read.runId, read])) : EMPTY_RUN_READS, [reads]);
    const unavailableReason = reads.find(read => read.unavailableReason === 'temporarily_unavailable')?.unavailableReason
        ?? reads.find(read => read.unavailableReason !== null)?.unavailableReason;
    let state: ReviewQuestionRunsState;
    if (unavailableReason) state = { kind: 'unavailable', reason: unavailableReason };
    else if (params.enabled && references.length > 0 && (snapshot.key !== key || snapshot.loading)) state = { kind: 'loading' };
    else state = { kind: members.some(member => member.questions.length > 0) ? 'ready' : 'no_questions' };
    return { members, runs: runReads, state, retry };
}
