import type { OperationUpdateRequiredV1 } from '../compat/operationUpdateRequiredV1.js';
import { isMachineRpcTimeoutError, isRpcMachineAdmissionUnavailableError, MACHINE_RPC_TIMEOUT_ERROR_CODE, readRpcErrorCode, RPC_ERROR_CODES } from '../rpc/errors.js';
import { isMachineRequestReachabilityFailureV1 } from '../machines/machineReachabilityV1.js';
import { resolveSessionWorkspaceRootForMachine } from '../sessions/metadata/sessionWorkspaceLocationV1.js';
import { SCM_OPERATION_ERROR_CODES } from '../scm/operationError.js';
import { getUsageQueryKey, type UsageQuery } from '../inputs/usageQuery.js';
import { ScmWorkEvidenceReadResponseSchema, type ScmWorkEvidenceReadRequest, type ScmBranchWorkEvidence } from '../scm/index.js';
import { projectUsageWorkSummary, resolveUsageWorkOutcomeAdmissions, type UsageWorkEvidence } from './usageOutcomeAllocation.js';
import { projectUsageAccountingSessionMembership, readUsageAccountingSessionMembership } from './usageAccountingMembership.js';
import type { UsageAccountingSourceSnapshot, UsageWorkSourceSnapshot } from './resolveUsagePageAggregation.js';

type WorkTargetFailure = Readonly<{ errorCode: string; httpStatus?: number; updateRequired?: OperationUpdateRequiredV1 }>;
export type UsageWorkSessionTarget = Readonly<{ machineId: string; cwd: string }> | WorkTargetFailure;

/** Work follows the exact Home Session's Machine and the workspace path published for that Machine. */
export function resolveUsageWorkSessionTarget(
    ownerMetadata: Readonly<{ machineId?: unknown; path?: unknown }> | null,
): UsageWorkSessionTarget {
    const machineId = typeof ownerMetadata?.machineId === 'string' ? ownerMetadata.machineId.trim() : '';
    if (machineId) {
        const candidatePath = typeof ownerMetadata?.path === 'string' ? ownerMetadata.path : '';
        const { machinePath } = resolveSessionWorkspaceRootForMachine({ metadata: ownerMetadata, machineId, candidatePath });
        if (machinePath.trim()) return { machineId, cwd: machinePath };
    }
    return { errorCode: RPC_ERROR_CODES.SESSION_MACHINE_CONTROL_UNAVAILABLE };
}

type UnreadSessions = NonNullable<UsageWorkSourceSnapshot['unreadSessions']>;
type UnreadReason = keyof UnreadSessions | 'machine_offline' | 'machine_admission_unavailable';

export type SessionWorkSourceResult = Readonly<(
    | { status: 'unsupported' | 'error' | 'unknown' }
    | { status: 'partial' | 'unsupported' | 'error'; evidence: readonly UsageWorkEvidence[]; branchEvidence?: readonly ScmBranchWorkEvidence[] }
) & { unreadReason?: UnreadReason; pullRequestsRead?: true; targetFailure?: WorkTargetFailure }>;

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

function unreadSession(code: string | undefined, httpStatus?: number): SessionWorkSourceResult {
    const unreadReason = httpStatus === 401 || httpStatus === 403 ? 'not_entitled' : classifyUnreadReason(code);
    if (unreadReason === 'machine_offline' || unreadReason === 'machine_unavailable') return { status: 'unknown', unreadReason };
    // Explicit refusal withdraws old witnesses. A failed replacement carries no new admission.
    if (unreadReason === 'not_entitled') return { status: 'error', unreadReason, evidence: [], branchEvidence: [] };
    return { status: 'error', unreadReason };
}

function unreadWorkFailure(error: unknown): SessionWorkSourceResult {
    if (isRpcMachineAdmissionUnavailableError(error)) return { status: 'unknown', unreadReason: 'machine_admission_unavailable' };
    if (isMachineRpcTimeoutError(error)) return unreadSession(MACHINE_RPC_TIMEOUT_ERROR_CODE);
    const code = readRpcErrorCode(error);
    if (code === 'machine_offline') return unreadSession(code);
    return unreadSession(isMachineRequestReachabilityFailureV1(error) ? 'target_unavailable' : code);
}

/** Work admission and its observers consume this exact witnessed turn population. */
export function readUsageWorkSessionTurns(accounting: UsageAccountingSourceSnapshot['value']):
    readonly Readonly<{ sessionId: string; turnId: string }>[] | undefined {
    return readUsageAccountingSessionMembership(accounting)?.turns ?? accounting?.contributions
        ?.flatMap(row => row.sessionId && row.turnId ? [{ sessionId: row.sessionId, turnId: row.turnId }] : []);
}

/** Compute coverage only from the PR acquisition result for this admitted population. */
export function hasUsagePullRequestRead(
    turns: ReturnType<typeof readUsageWorkSessionTurns>, readSessions: readonly string[] | undefined,
): boolean {
    if (turns === undefined || readSessions === undefined) return false;
    const answered = new Set(readSessions);
    return turns.every(turn => answered.has(turn.sessionId));
}

export function projectUsagePublicWorkLenses(
    accounting: NonNullable<UsageAccountingSourceSnapshot['value']>,
    evidence: readonly UsageWorkEvidence[],
    readSessions: readonly string[] | undefined,
): { execution: 'happier' | 'outside'; facts: { mergedPrs?: number } }[] {
    const prepared = accounting.summary?.publicProfileAccounting;
    const rows = accounting.contributions;
    const turns = readUsageAccountingSessionMembership(accounting)?.turns
        ?? (rows ? projectUsageAccountingSessionMembership(rows).turns : undefined);
    if (!turns) return [];
    return (['happier', 'outside'] as const).map(execution => {
        const selected = turns.filter(turn => turn.executions.includes(execution));
        const complete = selected.length > 0 ? hasUsagePullRequestRead(selected, readSessions)
            : readSessions !== undefined && (prepared
                ? prepared.lenses.some(lens => lens.execution === execution && lens.population.contributionCount === 0
                    && lens.population.coverage.status === 'complete_for_supplied_facts')
                : accounting.coverage?.status === 'complete' && accounting.coverage.range.complete
                    && rows?.every(row => row.sourceContext?.execution !== undefined
                        && row.sourceContext.execution !== 'unknown' && row.sourceContext.execution !== execution) === true);
        const outcomes = resolveUsageWorkOutcomeAdmissions({ turns: selected, evidence }).outcomes;
        const summary = projectUsageWorkSummary(outcomes, complete);
        return { execution, facts: summary?.mergedPrCount === undefined ? {} : { mergedPrs: summary.mergedPrCount } };
    });
}

export async function collectUsageWorkSources(input: Readonly<{
    queries: readonly UsageQuery[];
    accounting: readonly UsageAccountingSourceSnapshot[];
    sessionReads?: Map<string, Promise<SessionWorkSourceResult>>;
    resolveSession: (sessionId: string) => Promise<UsageWorkSessionTarget | null>;
    readMachine: (machineId: string, request: ScmWorkEvidenceReadRequest) => Promise<unknown>;
    onSessionAdmission?(sessionId: string, readable: boolean): void;
    previouslyRefused?(sessionId: string): boolean;
    assertCurrent: () => void | Promise<void>;
    now: () => number;
    onProgress?: (snapshots: readonly UsageWorkSourceSnapshot[]) => void;
}>): Promise<readonly UsageWorkSourceSnapshot[]> {
    const { queries, accounting, now } = input;
    const sessionReads = input.sessionReads ?? new Map<string, Promise<SessionWorkSourceResult>>();
    const byQuery = new Map(accounting.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
    const turnsByQuery = new Map(queries.map(query => {
        const key = getUsageQueryKey(query);
        return [key, readUsageWorkSessionTurns(byQuery.get(key))] as const;
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
    const acquire = async () => {
        const results = new Map<string, SessionWorkSourceResult>();
        const pending = new Map<string, Promise<void>>();
        const machines = new Map<string, ScmWorkEvidenceReadRequest['sessions']>();
        const targets = await Promise.all(missing.map(async sessionId => {
            await input.assertCurrent();
            try {
                return { sessionId, target: await input.resolveSession(sessionId) };
            } catch (error) {
                await input.assertCurrent();
                results.set(sessionId, unreadWorkFailure(error));
                return null;
            }
        }));
        for (const resolved of targets) {
            if (!resolved) continue;
            const { sessionId, target } = resolved;
            if (!target) { results.set(sessionId, { status: 'unknown', unreadReason: 'failed' }); continue; }
            if ('errorCode' in target) {
                const unread = unreadSession(target.errorCode, target.httpStatus);
                results.set(sessionId, target.updateRequired
                    ? { ...unread, status: 'unsupported', targetFailure: target }
                    : unread.status === 'error' ? { ...unread, targetFailure: target } : unread);
                continue;
            }
            const sessions = machines.get(target.machineId) ?? [];
            sessions.push({ sessionId, cwd: target.cwd, turnIds: [...turnsBySession.get(sessionId)!] });
            machines.set(target.machineId, sessions);
        }
        const read = async (machineId: string, sessions: ScmWorkEvidenceReadRequest['sessions']) => {
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
                    const unreadReason = classifyUnreadReason(row.errorCode);
                    if (unreadReason === 'not_entitled') {
                        results.set(session.sessionId, unreadSession(row.errorCode));
                        continue;
                    }
                    const turns = turnsBySession.get(session.sessionId)!;
                    if (row.status === 'unknown') {
                        results.set(session.sessionId, { status: 'unknown', unreadReason });
                        continue;
                    }
                    if (row.status === 'error') {
                        results.set(session.sessionId, row.evidence === undefined && row.branchEvidence === undefined
                            ? unreadSession(row.errorCode)
                            : { status: 'error', unreadReason, evidence: [], branchEvidence: [] });
                        continue;
                    }
                    results.set(session.sessionId, { status: row.status,
                        ...(row.pullRequestsRead === true ? { pullRequestsRead: true } : {}),
                        ...(row.errorCode === undefined ? {} : { unreadReason }),
                        evidence: (row.evidence ?? []).filter(witness => turns.has(witness.turnId)),
                        ...(row.branchEvidence === undefined ? {} : { branchEvidence: row.branchEvidence.filter(witness => turns.has(witness.turnId)) }),
                    });
                }
            } catch (error) {
                await input.assertCurrent();
                const result = unreadWorkFailure(error);
                for (const session of sessions) results.set(session.sessionId, result);
            }
        };
        for (const [machineId, sessions] of machines) {
            const reading = read(machineId, sessions);
            for (const session of sessions) pending.set(session.sessionId, reading);
        }
        return { results, pending };
    };

    const project = (sessions: ReadonlyMap<string, SessionWorkSourceResult>, asOfMs?: number) => queries.map((query): UsageWorkSourceSnapshot => {
        const key = getUsageQueryKey(query);
        const admittedTurns = turnsByQuery.get(key);
        if (!admittedTurns) return asOfMs === undefined ? { query, status: 'pending' } : { query, status: 'unknown', asOfMs };
        const turns = new Set(admittedTurns.map(turn => JSON.stringify([turn.sessionId, turn.turnId])));
        const admittedIds = [...new Set(admittedTurns.map(turn => turn.sessionId))];
        const selectedIds = admittedIds.filter(sessionId => sessions.has(sessionId));
        const selected = selectedIds.map(sessionId => sessions.get(sessionId)!);
        const pullRequestReadSessions = selectedIds.filter(sessionId => sessions.get(sessionId)?.pullRequestsRead === true);
        const evidence = selected.flatMap(source => 'evidence' in source ? source.evidence : [])
            .filter(witness => turns.has(JSON.stringify([witness.sessionId, witness.turnId])));
        const branchEvidence = selected.flatMap(source => 'branchEvidence' in source ? source.branchEvidence ?? [] : [])
            .filter(witness => turns.has(JSON.stringify([witness.sessionId, witness.turnId])));
        const unreadSessions: UnreadSessions = {};
        const unreadBySession: [string, keyof UnreadSessions][] = [];
        let hasOfflineMachine = false;
        for (const [index, { unreadReason }] of selected.entries()) {
            if (unreadReason === undefined) continue;
            if (unreadReason === 'machine_offline') hasOfflineMachine = true;
            const reason = unreadReason === 'machine_offline' || unreadReason === 'machine_admission_unavailable'
                ? 'machine_unavailable' : unreadReason;
            unreadSessions[reason] = (unreadSessions[reason] ?? 0) + 1;
            unreadBySession.push([selectedIds[index]!, reason]);
        }
        const failedReplacement = selected.length > 0 && selected.every(source => source.status === 'error' && !('evidence' in source));
        const readFailed = selected.some(source => source.status === 'error');
        const value = byQuery.get(key);
        const measuredEmpty = selected.length === 0 && value?.totals.eventCount === 0
            && value.coverage?.status === 'complete' && value.coverage.range.complete;
        const status = measuredEmpty ? 'available' as const : selected.some(source => source.status === 'partial') ? 'partial' as const
            : readFailed ? 'error' as const : selected.some(source => source.status === 'unsupported') ? 'unsupported' as const : 'unknown' as const;
        const targetFailure = selected.find(source => source.targetFailure?.updateRequired)?.targetFailure
            ?? selected.find(source => source.targetFailure)?.targetFailure;
        const { updateRequired } = targetFailure ?? {};
        const errorCode = targetFailure?.errorCode ?? (readFailed ? 'work_evidence_failed'
            : hasOfflineMachine && (status === 'unknown' || status === 'partial') ? 'machine_offline' : undefined);
        if (asOfMs === undefined) return {
            query, status: 'pending', evidence, branchEvidence,
            retainWorkSessionIds: admittedIds.filter(sessionId => {
                const session = sessions.get(sessionId);
                return !session || (!('evidence' in session) && session.unreadReason !== undefined);
            }),
            ...(unreadBySession.length ? { unreadSessions, unreadBySession } : {}),
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(updateRequired ? { updateRequired } : {}),
        };
        return { query, ...(failedReplacement ? {} : { evidence, branchEvidence }), status,
            pullRequestReadSessions,
            ...(status === 'error' ? {} : { asOfMs }),
            ...(unreadBySession.length ? { unreadSessions, unreadBySession } : {}),
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(updateRequired ? { updateRequired } : {}) };
    });

    // Install promises before awaiting targets. Each Machine's batch settles
    // its own Sessions, so a slow route does not hold other batches' witnesses.
    if (missing.length) {
        const acquisition = acquire();
        for (const sessionId of missing) {
            sessionReads.set(readKeys.get(sessionId)!, acquisition.then(async ({ results, pending }) => {
                await pending.get(sessionId);
                const source = results.get(sessionId)!;
                if (source.unreadReason === 'not_entitled') input.onSessionAdmission?.(sessionId, false);
                else if (source.status === 'partial' || source.pullRequestsRead) input.onSessionAdmission?.(sessionId, true);
                return source;
            }));
        }
    }
    const sessions = new Map<string, SessionWorkSourceResult>();
    let publishedSize = 0;
    await Promise.all([...sessionIds].map(async sessionId => {
        const source = await sessionReads.get(readKeys.get(sessionId)!)!;
        // A failed attempt cannot replace a Session's known refusal. The caller
        // supplies the admission it was replacing, scoped to this read.
        sessions.set(sessionId, source.unreadReason !== undefined && source.unreadReason !== 'not_entitled'
            && input.previouslyRefused?.(sessionId) ? unreadSession(RPC_ERROR_CODES.FORBIDDEN) : source);
        if (!input.onProgress) return;
        // Adjacent resolutions in one Machine answer publish as a batch.
        await Promise.resolve();
        if (sessions.size === sessionIds.size || sessions.size === publishedSize) return;
        publishedSize = sessions.size;
        input.onProgress(project(sessions));
    }));
    return project(sessions, now());
}
