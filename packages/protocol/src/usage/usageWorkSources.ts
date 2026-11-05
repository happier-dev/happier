import { RPC_METHODS } from '../rpc/methods.js';
import { getUsageQueryKey, type UsageQuery } from '../inputs/usageQuery.js';
import { ScmBranchListResponseSchema, type ScmBranchListRequest, type ScmBranchWorkEvidence, ScmPullRequestListResponseSchema, type ScmPullRequestListRequest } from '../scm/index.js';
import { projectUsageWorkSummary, resolveUsageWorkOutcomeAdmissions, type UsageWorkEvidence } from './usageOutcomeAllocation.js';
import { readUsageAccountingSessionMembership } from './usageAccountingMembership.js';
import type { UsageAccountingSourceSnapshot, UsageWorkSourceSnapshot } from './resolveUsagePageAggregation.js';

export type SessionWorkSourceResult = Readonly<
    | { status: 'unsupported' | 'error' | 'unknown' }
    | { status: 'partial' | 'unsupported' | 'error'; evidence: readonly UsageWorkEvidence[]; branchEvidence?: readonly ScmBranchWorkEvidence[] }
>;

export async function collectUsageWorkSources(input: Readonly<{
    queries: readonly UsageQuery[];
    accounting: readonly UsageAccountingSourceSnapshot[];
    sessionReads?: Map<string, Promise<SessionWorkSourceResult>>;
    readSession: (sessionId: string) => Promise<((method: string, request: ScmBranchListRequest | ScmPullRequestListRequest) => Promise<unknown>) | null>;
    assertCurrent: () => void | Promise<void>;
}>): Promise<readonly UsageWorkSourceSnapshot[]> {
    const { queries, accounting } = input;
    const sessionReads = input.sessionReads ?? new Map<string, Promise<SessionWorkSourceResult>>();
    const byQuery = new Map(accounting.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
    const turnsByQuery = new Map(queries.map(query => {
        const key = getUsageQueryKey(query);
        return [key, readUsageAccountingSessionMembership(byQuery.get(key))?.turns ?? byQuery.get(key)?.contributions
            ?.flatMap(row => row.sessionId && row.turnId ? [{ sessionId: row.sessionId, turnId: row.turnId }] : [])] as const;
    }));
    const sessionIds = new Set([...turnsByQuery.values()].flatMap(turns => turns?.map(turn => turn.sessionId) ?? []));
    // Sessions outside a repository have no SCM evidence; the read did not fail.
    const unsupportedReadFailureCodes = ['FEATURE_UNSUPPORTED', 'NOT_REPOSITORY'];
    // Generic transport refusals quarantine every private sibling read. Only
    // explicit native failures may retain other independently witnessed graphs.
    const nativeReadFailureCodes = ['COMMAND_FAILED', 'COMMAND_TIMEOUT', 'COMMAND_OUTPUT_LIMIT_EXCEEDED',
        'REMOTE_NETWORK_FAILED', 'REPOSITORY_REFRESH_FAILED'];
    const loadSession = async (sessionId: string): Promise<SessionWorkSourceResult> => {
        const read = await input.readSession(sessionId);
        if (!read) return { status: 'unknown' };
        const readState = async (state: 'branch' | 'open' | 'closed' | 'merged'): Promise<Readonly<{
            status: 'partial' | 'unsupported' | 'error'; evidence?: readonly UsageWorkEvidence[]; branchEvidence?: readonly ScmBranchWorkEvidence[];
            quarantine?: boolean; notRepository?: boolean;
        }>> => {
          try {
            await input.assertCurrent();
            if (state === 'branch') {
                const response = ScmBranchListResponseSchema.safeParse(await read(RPC_METHODS.SCM_BRANCH_LIST, { workEvidence: { sessionId } }));
                await input.assertCurrent();
                if (!response.success) return { status: 'error', quarantine: true };
                if (!response.data.success) {
                    if (unsupportedReadFailureCodes.includes(response.data.errorCode ?? '')) return { status: 'unsupported',
                        notRepository: response.data.errorCode === 'NOT_REPOSITORY' };
                    const nativeFailure = nativeReadFailureCodes.includes(response.data.errorCode ?? '');
                    return { status: 'error', quarantine: !nativeFailure };
                }
                if (!response.data.branchEvidence || response.data.branchEvidenceStatus !== 'partial') return { status: 'unsupported' };
                if (response.data.branchEvidence.some(witness => witness.sessionId !== sessionId)) return { status: 'error', quarantine: true };
                return { status: 'partial', branchEvidence: response.data.branchEvidence };
            }
            const response = ScmPullRequestListResponseSchema.safeParse(await read(RPC_METHODS.SCM_PULL_REQUEST_LIST, { state, workEvidence: { sessionId } }));
            await input.assertCurrent();
            if (!response.success) return { status: 'error', quarantine: true };
            if (!response.data.success) {
                if (unsupportedReadFailureCodes.includes(response.data.errorCode ?? '')) return { status: 'unsupported' };
                // The incumbent transport maps generic refusals to BACKEND_UNAVAILABLE.
                // Only explicit native-read failures can retain a sibling state's facts.
                const nativeFailure = nativeReadFailureCodes.includes(response.data.errorCode ?? '');
                return { status: 'error', quarantine: !nativeFailure };
            }
            if (!response.data.workEvidence || !response.data.workEvidenceStatus || response.data.workEvidenceStatus === 'unavailable') {
                return { status: 'unsupported' };
            }
            if (response.data.workEvidence.some(witness => witness.sessionId !== sessionId)) {
                return { status: 'error', quarantine: true };
            }
            // List is current-branch discovery, never proof of complete repository history.
            return { status: 'partial', evidence: response.data.workEvidence };
          } catch {
            await input.assertCurrent();
            return { status: 'error', quarantine: true };
          }
        };
        // Branch discovery establishes whether this admitted workspace is a
        // repository before acquiring remote PR evidence that it cannot have.
        const branch = await readState('branch');
        if (branch.notRepository) return { status: 'unsupported', evidence: [], branchEvidence: [] };
        const states = [branch, ...await Promise.all((['open', 'closed', 'merged'] as const).map(readState))];
        // An explicit empty quarantine is an admission withdrawal. A failed
        // replacement supplies no evidence at all, allowing the page's single
        // retention owner to distinguish it from a refusal or real empty read.
        if (states.some(source => source.quarantine)) return { status: 'error', evidence: [], branchEvidence: [] };
        if (states.every(source => source.status === 'error')) return { status: 'error' };
        return { status: states.some(source => source.status === 'partial') ? 'partial' as const
            : states.some(source => source.status === 'error') ? 'error' as const : 'unsupported' as const,
            evidence: states.flatMap(source => source.evidence ?? []), branchEvidence: states.flatMap(source => source.branchEvidence ?? []) };
    };
    const sessions = new Map(await Promise.all([...sessionIds].map(async sessionId => {
        let read = sessionReads.get(sessionId);
        if (!read) { read = loadSession(sessionId); sessionReads.set(sessionId, read); }
        return [sessionId, await read] as const;
    })));
    return queries.map((query): UsageWorkSourceSnapshot => {
        const admittedTurns = turnsByQuery.get(getUsageQueryKey(query));
        if (!admittedTurns) return { query, status: 'unknown' };
        const turns = new Set(admittedTurns.map(turn => JSON.stringify([turn.sessionId, turn.turnId])));
        const selected = [...new Set(admittedTurns.map(turn => turn.sessionId))]
            .map(sessionId => sessions.get(sessionId)!);
        const evidence = selected.flatMap(source => 'evidence' in source ? source.evidence : [])
            .filter(witness => turns.has(JSON.stringify([witness.sessionId, witness.turnId])));
        const branchEvidence = selected.flatMap(source => 'branchEvidence' in source ? source.branchEvidence ?? [] : [])
            .filter(witness => turns.has(JSON.stringify([witness.sessionId, witness.turnId])));
        const failedReplacement = selected.length > 0 && selected.every(source => source.status === 'error' && !('evidence' in source));
        const status = selected.some(source => source.status === 'partial') ? 'partial' as const
            : selected.some(source => source.status === 'error') ? 'error' as const : selected.some(source => source.status === 'unsupported') ? 'unsupported' as const : 'unknown' as const;
        const summary = status === 'partial' && (query.workProjection === 'summary' || query.population === 'public_eligible_personal')
            ? projectUsageWorkSummary(resolveUsageWorkOutcomeAdmissions({ turns: admittedTurns, evidence }).outcomes) : undefined;
        return { query, ...(failedReplacement ? {} : { evidence, branchEvidence }), status,
            ...(summary ? { summary } : {}),
            ...(selected.some(source => source.status === 'error') ? { errorCode: 'work_evidence_failed' } : {}) };
    });
}
