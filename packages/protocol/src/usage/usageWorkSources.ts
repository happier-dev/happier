import { isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE, readRpcErrorCode, RPC_ERROR_CODES } from '../rpc/errors.js';
import { isMachineRequestReachabilityFailureV1 } from '../machines/machineReachabilityV1.js';
import { SCM_OPERATION_ERROR_CODES } from '../scm/operationError.js';
import { getUsageQueryKey, type UsageQuery } from '../inputs/usageQuery.js';
import { ScmWorkEvidenceReadResponseSchema, type ScmWorkEvidenceReadRequest, type ScmBranchWorkEvidence } from '../scm/index.js';
import { projectUsageWorkSummary, resolveUsageWorkOutcomeAdmissions, type UsageWorkEvidence } from './usageOutcomeAllocation.js';
import { readUsageAccountingSessionMembership } from './usageAccountingMembership.js';
import type { UsageAccountingSourceSnapshot, UsageWorkSourceSnapshot } from './resolveUsagePageAggregation.js';

type UnreadSessions = NonNullable<UsageWorkSourceSnapshot['unreadSessions']>;
type UnreadReason = keyof UnreadSessions | 'machine_offline';

export type SessionWorkSourceResult = Readonly<(
    | { status: 'unsupported' | 'error' | 'unknown' }
    | { status: 'partial' | 'unsupported' | 'error'; evidence: readonly UsageWorkEvidence[]; branchEvidence?: readonly ScmBranchWorkEvidence[] }
) & { unreadReason?: UnreadReason }>;

function classifyUnreadReason(code: string | undefined): UnreadReason {
    switch (code) {
        case 'machine_offline':
            return 'machine_offline';
        case 'target_unavailable':
        case RPC_ERROR_CODES.SESSION_MACHINE_CONTROL_UNAVAILABLE:
            return 'machine_unavailable';
        case RPC_ERROR_CODES.FORBIDDEN:
        case RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED:
            return 'not_entitled';
        case MACHINE_RPC_TIMEOUT_ERROR_CODE:
        case SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT:
            return 'timed_out';
        default:
            return 'failed';
    }
}

function unreadSession(code: string | undefined): SessionWorkSourceResult {
    const unreadReason = classifyUnreadReason(code);
    if (unreadReason === 'machine_offline' || unreadReason === 'machine_unavailable') return { status: 'unknown', unreadReason };
    // Explicit refusal withdraws old witnesses. A failed replacement carries no new admission.
    if (unreadReason === 'not_entitled') return { status: 'error', unreadReason, evidence: [], branchEvidence: [] };
    return { status: 'error', unreadReason };
}

function readWorkFailureCode(error: unknown): string | undefined {
    if (isMachineRpcTimeoutError(error)) return MACHINE_RPC_TIMEOUT_ERROR_CODE;
    const code = readRpcErrorCode(error);
    if (code === 'machine_offline') return code;
    return isMachineRequestReachabilityFailureV1(error) ? 'target_unavailable' : code;
}

export async function collectUsageWorkSources(input: Readonly<{
    queries: readonly UsageQuery[];
    accounting: readonly UsageAccountingSourceSnapshot[];
    sessionReads?: Map<string, Promise<SessionWorkSourceResult>>;
    resolveSession: (sessionId: string) => Promise<Readonly<{ machineId: string; cwd: string } | { errorCode: string }> | null>;
    readMachine: (machineId: string, request: ScmWorkEvidenceReadRequest) => Promise<unknown>;
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
    const turnsBySession = new Map<string, Set<string>>();
    for (const turns of turnsByQuery.values()) for (const turn of turns ?? []) {
        const ids = turnsBySession.get(turn.sessionId) ?? new Set<string>();
        ids.add(turn.turnId);
        turnsBySession.set(turn.sessionId, ids);
    }
    const readKeys = new Map([...sessionIds].map(sessionId => [sessionId,
        JSON.stringify([sessionId, [...turnsBySession.get(sessionId)!].sort()])]));
    const missing = [...sessionIds].filter(sessionId => !sessionReads.has(readKeys.get(sessionId)!));
    const acquire = async (): Promise<Map<string, SessionWorkSourceResult>> => {
        const results = new Map<string, SessionWorkSourceResult>();
        const machines = new Map<string, ScmWorkEvidenceReadRequest['sessions']>();
        const targets = await Promise.all(missing.map(async sessionId => {
            await input.assertCurrent();
            try {
                return { sessionId, target: await input.resolveSession(sessionId) };
            } catch (error) {
                await input.assertCurrent();
                results.set(sessionId, unreadSession(readWorkFailureCode(error)));
                return null;
            }
        }));
        for (const resolved of targets) {
            if (!resolved) continue;
            const { sessionId, target } = resolved;
            if (!target) { results.set(sessionId, { status: 'unknown', unreadReason: 'failed' }); continue; }
            if ('errorCode' in target) { results.set(sessionId, unreadSession(target.errorCode)); continue; }
            const sessions = machines.get(target.machineId) ?? [];
            sessions.push({ sessionId, cwd: target.cwd, turnIds: [...turnsBySession.get(sessionId)!] });
            machines.set(target.machineId, sessions);
        }
        await Promise.all([...machines].map(async ([machineId, sessions]) => {
            try {
                await input.assertCurrent();
                const response = ScmWorkEvidenceReadResponseSchema.safeParse(await input.readMachine(machineId, { sessions }));
                await input.assertCurrent();
                if (!response.success) {
                    for (const session of sessions) results.set(session.sessionId, unreadSession(undefined));
                    return;
                }
                const rows = new Map<string, (typeof response.data.sessions)[number] | null>();
                for (const row of response.data.sessions) rows.set(row.sessionId, rows.has(row.sessionId) ? null : row);
                for (const session of sessions) {
                    const row = rows.get(session.sessionId);
                    if (!row || [...row.evidence ?? [], ...row.branchEvidence ?? []].some(witness => witness.sessionId !== session.sessionId)) {
                        results.set(session.sessionId, { status: 'error', unreadReason: 'failed', evidence: [], branchEvidence: [] });
                        continue;
                    }
                    const turns = turnsBySession.get(session.sessionId)!;
                    if (row.status === 'unknown') {
                        results.set(session.sessionId, { status: 'unknown', unreadReason: classifyUnreadReason(row.errorCode) });
                        continue;
                    }
                    if (row.status === 'error') {
                        results.set(session.sessionId, row.evidence === undefined && row.branchEvidence === undefined
                            ? unreadSession(row.errorCode)
                            : { status: 'error', unreadReason: classifyUnreadReason(row.errorCode), evidence: [], branchEvidence: [] });
                        continue;
                    }
                    results.set(session.sessionId, { status: row.status,
                        ...(row.errorCode === undefined ? {} : { unreadReason: classifyUnreadReason(row.errorCode) }),
                        evidence: (row.evidence ?? []).filter(witness => turns.has(witness.turnId)),
                        ...(row.branchEvidence === undefined ? {} : { branchEvidence: row.branchEvidence.filter(witness => turns.has(witness.turnId)) }),
                    });
                }
            } catch (error) {
                await input.assertCurrent();
                const result = unreadSession(readWorkFailureCode(error));
                for (const session of sessions) results.set(session.sessionId, result);
            }
        }));
        return results;
    };
    // Install promises before awaiting targets, so concurrent slices share an
    // already admitted Session read instead of emitting another Machine call.
    if (missing.length) {
        const acquisition = acquire();
        for (const sessionId of missing) sessionReads.set(readKeys.get(sessionId)!, acquisition.then(results => results.get(sessionId)!));
    }
    const sessions = new Map(await Promise.all([...sessionIds].map(async sessionId => [sessionId, await sessionReads.get(readKeys.get(sessionId)!)!] as const)));
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
        const unreadSessions: UnreadSessions = {};
        let hasOfflineMachine = false;
        for (const { unreadReason } of selected) {
            if (unreadReason === undefined) continue;
            if (unreadReason === 'machine_offline') hasOfflineMachine = true;
            const reason = unreadReason === 'machine_offline' ? 'machine_unavailable' : unreadReason;
            unreadSessions[reason] = (unreadSessions[reason] ?? 0) + 1;
        }
        const failedReplacement = selected.length > 0 && selected.every(source => source.status === 'error' && !('evidence' in source));
        const readFailed = selected.some(source => source.status === 'error');
        const status = selected.some(source => source.status === 'partial') ? 'partial' as const
            : readFailed ? 'error' as const : selected.some(source => source.status === 'unsupported') ? 'unsupported' as const : 'unknown' as const;
        const summary = status === 'partial' && (query.workProjection === 'summary' || query.population === 'public_eligible_personal')
            ? projectUsageWorkSummary(resolveUsageWorkOutcomeAdmissions({ turns: admittedTurns, evidence }).outcomes) : undefined;
        const errorCode = readFailed ? 'work_evidence_failed'
            : hasOfflineMachine && (status === 'unknown' || status === 'partial') ? 'machine_offline' : undefined;
        return { query, ...(failedReplacement ? {} : { evidence, branchEvidence }), status,
            ...(summary ? { summary } : {}),
            ...(Object.keys(unreadSessions).length ? { unreadSessions } : {}),
            ...(errorCode === undefined ? {} : { errorCode }) };
    });
}
