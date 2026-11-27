import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import type { ScmWorkEvidenceReadRequest, ScmBranchWorkEvidence } from '../scm/index.js';
import type { SessionWorkSourceResult } from './usageWorkSources.js';
import { UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { collectUsageWorkSources } from './usageWorkSources.js';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema, UsageQueryResultSliceSchema } from './resolveUsagePageAggregation.js';
import { createRpcCallError, MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES } from '../rpc/errors.js';
import { projectUsageQueryDelivery } from './projectUsageQueryDelivery.js';

const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeComparison: false,
  includeQuotaHistory: false, includeSessionEvidence: false, includeWorkEvidence: true });
const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
  tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
  cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
  sessionMembership: { turns: [{ sessionId: 'session', turnId: 'turn', executions: ['happier'] }] } });
const accounting = [{ query, value, status: 'available' as const }];

describe('Usage Work repository admission', () => {
  it.each([false, true])('publishes readable Work and distinguishes offline hosts from independent failures: %s', async fails => {
    const sessions = ['linked', 'unlinked', 'unavailable', 'unresolved', 'offline', ...(fails ? ['denied', 'slow'] : [])];
    const reportedUsd = fails ? 28 : 15;
    const tokens = value.totals.tokens;
    const contributions = sessions.map((sessionId, index) => ({
      id: sessionId, sessionId, turnId: 'turn', observedAtMs: 1, agentId: 'coding-agent', modelId: 'model',
      machineId: sessionId, projectKey: 'project', workspaceId: null, source: 'runtime' as const, tokens,
      cost: { reportedUsd: index + 1, estimatedUsd: null, currency: 'USD' as const },
    }));
    const snapshot = UsageAnalyticsQueryResponseSchema.parse({
      ...value, contributions, totals: { ...value.totals, cost: { reportedUsd, estimatedUsd: null, currency: 'USD' } },
      sessionMembership: { turns: sessions.map(sessionId => ({ sessionId, turnId: 'turn', executions: ['happier'] })) },
    });
    const accounting = [{ query, value: snapshot, status: 'available' as const }];
    const work = await collectUsageWorkSources({
      queries: [query], accounting, assertCurrent: () => {}, now: () => 1000,
      resolveSession: async sessionId => sessionId === 'unresolved' ? null : { machineId: sessionId, cwd: '/repo' },
      readMachine: async (machineId, request) => {
        if (machineId === 'unavailable') throw createRpcCallError({ error: 'Unavailable', errorCode: 'target_unavailable' });
        if (machineId === 'offline') throw createRpcCallError({ error: 'Offline', errorCode: 'machine_offline' });
        if (machineId === 'denied') throw createRpcCallError({ error: 'Denied', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        if (machineId === 'slow') throw Object.assign(new Error('Timed out'), { code: MACHINE_RPC_TIMEOUT_ERROR_CODE });
        return { sessions: request.sessions.map(({ sessionId }) => ({
          sessionId, status: 'partial', evidence: sessionId === 'unlinked' ? [] : [{
            sessionId, turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
            checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
            attributionScope: 'no_happier_checkpoint_overlap_observed',
            pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
              nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
              number: 1, title: 'Outcome', url: 'https://github.com/owner/repo/pull/1',
              baseBranch: 'main', headBranch: 'feature', state: 'merged' },
          }],
        })) };
      },
    });
    const batch = resolveUsagePageAggregation({ queries: [query], accounting, work }, bundledUsageModelPriceCatalog);
    const result = UsageQueryResultSliceSchema.parse(batch.results[0]);
    expect(result.workSummary?.mergedPrCount).toBeUndefined();
    expect(result.work?.allocations.map((row, index) => [result.accounting!.contributions![index]!.sessionId, row.reason, result.accounting!.contributions![index]!.cost.reportedUsd])).toEqual([
      ['linked', 'allocated', 1], ['unlinked', 'missing_evidence', 2], ['unavailable', 'missing_evidence', 3],
      ['unresolved', 'missing_evidence', 4], ['offline', 'missing_evidence', 5],
      ...(fails ? [['denied', 'missing_evidence', 6], ['slow', 'missing_evidence', 7]] : []),
    ]);
    expect(result.accounting?.totals.cost.reportedUsd).toBe(reportedUsd);
    const workSource = {
      source: 'work', status: 'partial', asOfMs: 1000, errorCode: fails ? 'work_evidence_failed' : 'machine_offline',
      unreadSessions: { machine_unavailable: 2, failed: 1, ...(fails ? { not_entitled: 1, timed_out: 1 } : {}) },
    };
    expect(result.sources.find(source => source.source === 'work')).toEqual(workSource);
    const delivered = UsageQueryBatchResultSchema.parse(projectUsageQueryDelivery(batch, 'agent')).results[0];
    expect(delivered?.sources.find(source => source.source === 'work')).toEqual(workSource);
    expect(delivered?.workSummary).toEqual(result.workSummary);
  });

  it.each([false, true])('projects a typed Home Work refusal with a readable sibling: %s', async readable => {
    const sessionIds = readable ? ['allowed', 'refused'] : ['refused'];
    const turns = sessionIds.map(sessionId => ({ sessionId, turnId: 'turn', executions: ['happier' as const] }));
    const refused = { errorCode: 'team_authentication_required', httpStatus: 403 };
    const branch: ScmBranchWorkEvidence = { sessionId: 'allowed', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } };
    const { branch: _branch, ...checkpoint } = branch;
    const accounting = [{ query, value: { ...value, sessionMembership: { turns },
      contributions: turns.map(({ sessionId, turnId }) => ({
        id: sessionId, sessionId, turnId, observedAtMs: 1, agentId: 'codex', modelId: null,
        machineId: null, projectKey: null, workspaceId: null, source: 'runtime' as const,
        tokens: value.totals.tokens, cost: value.totals.cost,
      })) }, status: 'available' as const }];
    const work = await collectUsageWorkSources({
      queries: [query], accounting, assertCurrent: () => {}, now: () => 1000,
      resolveSession: async sessionId => sessionId === 'refused' ? refused : { machineId: 'machine', cwd: '/repo' },
      readMachine: async request => {
        expect(request).toBe('machine');
        return { sessions: [{ sessionId: 'allowed', status: 'partial', pullRequestsRead: true, branchEvidence: [branch],
          evidence: [{ ...checkpoint, pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge',
            baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
            number: 1, title: 'Linked', url: 'https://github.com/owner/repo/pull/1',
            baseBranch: 'main', headBranch: 'feature', state: 'merged' } }] }] };
      },
    });
    const batch = resolveUsagePageAggregation({ queries: [query], accounting, work }, bundledUsageModelPriceCatalog);
    const source = { source: 'work', status: readable ? 'partial' : 'error', errorCode: refused.errorCode,
      unreadSessions: { not_entitled: 1 } };
    for (const delivery of [batch, projectUsageQueryDelivery(batch, 'agent')]) {
      const row = UsageQueryBatchResultSchema.parse(delivery).results[0]!;
      expect(row.sources.find(value => value.source === 'work')).toMatchObject(source);
    }
    expect(work[0]?.branchEvidence).toEqual(readable ? [branch] : []);
    expect(batch.results[0]?.work?.outcomes).toHaveLength(readable ? 1 : 0);
  });

  it('only publishes a measured zero when the PR read answered, independently of branch success', async () => {
    const usage = [{ query, status: 'available' as const, value: { ...value, contributions: [{
      id: 'request', observedAtMs: 2, sessionId: 'session', turnId: 'turn', agentId: 'codex', modelId: null,
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens: value.totals.tokens, cost: value.totals.cost,
    }] } }];
    const branch: ScmBranchWorkEvidence = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } };
    const read = async (readPrs: boolean) => {
      const work = await collectUsageWorkSources({ queries: [query], accounting: usage, assertCurrent: () => {}, now: () => 1000,
        resolveSession: async () => ({ machineId: 'machine', cwd: '/repo' }),
        readMachine: async () => ({ sessions: [{ sessionId: 'session', status: 'partial', evidence: [], branchEvidence: [branch],
          ...(readPrs ? { pullRequestsRead: true } : {}) }] }),
      });
      const result = resolveUsagePageAggregation({ queries: [query], accounting: usage, work }, bundledUsageModelPriceCatalog);
      return UsageQueryBatchResultSchema.parse(result).results[0]!;
    };
    const branchOnly = await read(false);
    expect(branchOnly.work?.branches).toHaveLength(1);
    expect(branchOnly.workSummary?.mergedPrCount).toBeUndefined();
    expect(branchOnly.mergedOutcomes).toBeUndefined();
    const answered = await read(true);
    expect(answered.workSummary?.mergedPrCount).toBe(0);
    expect(answered.mergedOutcomes?.mergedInPeriodCount).toBe(0);
  });

  it('reads 624 Sessions on 20 Machines in 20 calls and reuses an admitted read', async () => {
    // Measured 7D census: 624 Sessions across these 20 Machine populations.
    const populations = [46, 18, 1, 33, 27, 1, 70, 23, 100, 38, 8, 74, 1, 1, 1, 1, 101, 66, 13, 1];
    const targets = new Map(populations.flatMap((count, machine) => Array.from({ length: count }, (_, session) =>
      [`session-${machine}-${session}`, { machineId: `machine-${machine}`, cwd: '/repo' }] as const)));
    const turns = [...targets.keys()].map(sessionId => ({ sessionId, turnId: 'turn', executions: ['happier'] }));
    const snapshot = UsageAnalyticsQueryResponseSchema.parse({ ...value, sessionMembership: { turns } });
    const branch = (sessionId: string) => ({ sessionId, turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } });
    const calls: string[] = [];
    const sessionReads = new Map<string, Promise<SessionWorkSourceResult>>();
    // SCM transport is the genuine boundary; admission, membership and retention are real.
    const input = { queries: [query], accounting: [{ query, value: snapshot, status: 'available' as const }], sessionReads,
      assertCurrent: () => {}, now: () => 1000,
      resolveSession: async (sessionId: string) => targets.get(sessionId)!,
      readMachine: async (machineId: string, request: { sessions: { sessionId: string }[] }) => {
        calls.push(machineId);
        return { sessions: request.sessions.map(({ sessionId }) => ({ sessionId, status: 'partial', evidence: [], branchEvidence: [branch(sessionId)] })) };
      },
    };
    const work = await collectUsageWorkSources(input);
    const firstReadCalls = calls.length;
    await collectUsageWorkSources(input);
    expect(calls.length - firstReadCalls).toBe(0);
    expect(work[0]?.branchEvidence).toHaveLength(624);
    expect(firstReadCalls).toBe(20);
  });
  it.each([
    ['legacy target unavailable', 'target_unavailable', undefined, true],
    ['bare forbidden', RPC_ERROR_CODES.FORBIDDEN, undefined, false],
    ['Machine admission unavailable', RPC_ERROR_CODES.FORBIDDEN, 'machine_unavailable', true],
    ['Machine admission access denied', RPC_ERROR_CODES.FORBIDDEN, 'access_denied', false],
  ] as const)('distinguishes unavailable Work hosts from authorization failure: %s', async (_scenario, errorCode, causeCode, unavailable) => {
    const work = await collectUsageWorkSources({ queries: [query], accounting, assertCurrent: () => {}, now: () => 1000,
      resolveSession: async () => ({ machineId: 'machine', cwd: '/repo' }),
      readMachine: async () => { throw createRpcCallError({
        error: errorCode,
        errorCode,
        failureCause: causeCode ? { phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: causeCode, httpStatus: 403 } : undefined,
      }); },
    });
    const result = resolveUsagePageAggregation({ queries: [query], accounting, work }, bundledUsageModelPriceCatalog);
    expect(result.results[0]?.sources.find(source => source.source === 'work')).toEqual(unavailable
      ? { source: 'work', status: 'unknown', asOfMs: 1000, unreadSessions: { machine_unavailable: 1 } }
      : { source: 'work', status: 'error', errorCode: 'work_evidence_failed', unreadSessions: { not_entitled: 1 } });
    expect(work[0]?.evidence ?? []).toEqual([]);
  });
  it('keeps admitted siblings when one Session is refused and excludes foreign Session witnesses', async () => {
    const turns = ['allowed', 'refused', 'forged'].map(sessionId => ({ sessionId, turnId: 'turn', executions: ['happier'] }));
    const branch: ScmBranchWorkEvidence = { sessionId: 'allowed', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } };
    const work = await collectUsageWorkSources({ queries: [query],
      accounting: [{ query, value: { ...value, sessionMembership: { turns } }, status: 'available' }], assertCurrent: () => {}, now: () => 1000,
      resolveSession: async () => ({ machineId: 'machine', cwd: '/repo' }),
      readMachine: async () => ({ sessions: [
        { sessionId: 'allowed', status: 'partial', evidence: [], branchEvidence: [branch] },
        { sessionId: 'refused', status: 'error', evidence: [],
          branchEvidence: [{ ...branch, sessionId: 'refused' }], errorCode: RPC_ERROR_CODES.FORBIDDEN },
        { sessionId: 'forged', status: 'partial', evidence: [], branchEvidence: [branch] },
      ] }),
    });
    expect(work[0]).toMatchObject({ status: 'partial',
      unreadSessions: { failed: 1, not_entitled: 1 }, branchEvidence: [branch] });
    expect(work[0]?.errorCode).toBe('work_evidence_failed');
  });
  it.each([
    { reads: 2, offline: 0, slow: 0, denied: 0, backend: 0, state: 'partial', counts: undefined, merged: 2 },
    { reads: 1, offline: 1, slow: 0, denied: 0, backend: 0, state: 'partial', counts: { machine_unavailable: 1 } },
    { reads: 1, offline: 959, slow: 74, denied: 0, backend: 0, state: 'partial',
      counts: { machine_unavailable: 959, timed_out: 74 } },
    { reads: 0, offline: 2, slow: 0, denied: 0, backend: 0, state: 'unknown', counts: { machine_unavailable: 2 } },
    { reads: 0, offline: 0, slow: 2, denied: 0, backend: 0, state: 'error', counts: { timed_out: 2 } },
    { reads: 1, offline: 0, slow: 0, denied: 1, backend: 0, state: 'partial', counts: { not_entitled: 1 } },
    { reads: 1, offline: 0, slow: 0, denied: 0, backend: 1, state: 'partial', counts: { failed: 1 } },
  ])('composes $reads readable, $offline offline, $slow timed out, $denied refused and $backend backend failures',
    async ({ reads, offline, slow, denied, backend, state, counts, merged }) => {
      const groups = { read: reads, offline, slow, denied, backend };
      const turns = Object.entries(groups).flatMap(([group, count]) => Array.from({ length: count },
        (_, index) => ({ sessionId: `${group}-${index}`, turnId: 'turn', executions: ['happier' as const] })));
      const accounting = [{ query, status: 'available' as const, value: { ...value,
        contributions: turns.map(turn => ({ id: turn.sessionId, sessionId: turn.sessionId, turnId: turn.turnId,
          observedAtMs: 1, agentId: 'codex', modelId: null, machineId: null, projectKey: 'project', workspaceId: null,
          source: 'runtime' as const, tokens: value.totals.tokens, cost: value.totals.cost })),
        sessionMembership: { turns },
      } }];
      const work = await collectUsageWorkSources({
        queries: [query], accounting, assertCurrent: () => {}, now: () => 1000,
        resolveSession: async sessionId => ({ machineId: sessionId.split('-')[0]!, cwd: '/repo' }),
        readMachine: async (machineId, request) => {
          if (machineId === 'offline') throw createRpcCallError({ error: 'Offline', errorCode: 'machine_offline' });
          if (machineId === 'slow') throw createRpcCallError({ error: 'Deadline', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE });
          if (machineId === 'denied') throw createRpcCallError({ error: 'Denied', errorCode: RPC_ERROR_CODES.FORBIDDEN });
          if (machineId === 'backend') return { sessions: request.sessions.map(({ sessionId }) => ({
            sessionId, status: 'error', errorCode: 'BACKEND_UNAVAILABLE',
          })) };
          return { sessions: request.sessions.map(({ sessionId }, index) => {
            const checkpoint = { sessionId, turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint/turn',
              checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' };
            const number = index + 1;
            return { sessionId, status: 'partial', pullRequestsRead: true,
              branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } }],
              evidence: [{ ...checkpoint, pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge',
                baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
                number, title: 'Linked', url: `https://github.com/owner/repo/pull/${number}`, baseBranch: 'main',
                headBranch: 'feature', state: 'merged' } }],
            };
          }) };
        },
      });
      const slice = resolveUsagePageAggregation({ queries: [query], accounting, work }, bundledUsageModelPriceCatalog).results[0]!;
      const source = slice.sources.find(source => source.source === 'work');
      expect(source?.status).toBe(state);
      expect(source?.unreadSessions).toEqual(counts);
      expect(slice.work?.outcomes.length ?? 0).toBe(reads);
      expect(slice.work?.branchAllocations.filter(allocation => allocation.branch !== null).length ?? 0).toBe(reads);
      expect(slice.workSummary?.mergedPrCount).toBe(merged);
    });

  it.each([
    { name: 'all read', first: 'read', second: 'read', borrowPrevious: false, current: [11, 12] },
    { name: 'read + offline', first: 'read', second: 'offline', borrowPrevious: false, current: [11] },
    { name: 'read + timed out', first: 'read', second: 'slow', borrowPrevious: false, current: [11] },
    { name: 'offline + timed out', first: 'offline', second: 'slow', borrowPrevious: false, current: [] },
    { name: 'Machine refusal + timed out (J-A23)', first: 'machineRefusal', second: 'slow', borrowPrevious: false, current: [] },
    { name: 'Machine refusal + offline', first: 'machineRefusal', second: 'offline', borrowPrevious: false, current: [] },
    { name: 'Machine refusal among successes', first: 'read', second: 'machineRefusal', borrowPrevious: false, current: [11] },
    { name: 'all offline', first: 'offline', second: 'offline', borrowPrevious: false, current: [] },
    { name: 'all timed out', first: 'slow', second: 'slow', borrowPrevious: true, current: [] },
    { name: 'all plain backend failure', first: 'backend', second: 'backend', borrowPrevious: true, current: [] },
    { name: 'Session admission denial among successes', first: 'read', second: 'denied', borrowPrevious: false, current: [11] },
  ])('keeps the cut-36 prior Work boundary for $name', async ({ first, second, borrowPrevious, current }) => {
    const turns = [1, 2].map(number => ({ sessionId: String(number), turnId: 'turn', executions: ['happier' as const] }));
    const accounting = [{ query, status: 'available' as const, value: { ...value,
      contributions: turns.map(turn => ({
        sessionId: turn.sessionId, turnId: turn.turnId, id: turn.sessionId, observedAtMs: 1, agentId: 'codex', modelId: null, machineId: turn.sessionId,
        projectKey: 'project', workspaceId: null, source: 'runtime' as const, tokens: value.totals.tokens, cost: value.totals.cost,
      })),
      sessionMembership: { turns },
    } }];
    const reply = (sessionId: string, number: number) => {
      const checkpoint = { sessionId, turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint/turn',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' };
      return { sessions: [{ sessionId, status: 'partial', pullRequestsRead: true,
        branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/branch-' + number, headSha: 'b'.repeat(40) } }],
        evidence: [{ ...checkpoint, pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge',
          baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
          number, title: 'Linked', url: 'https://github.com/owner/repo/pull/' + number,
          baseBranch: 'main', headBranch: 'feature', state: 'merged' } }],
      }] };
    };
    const read = (replies: readonly string[], offset: number) => collectUsageWorkSources({
      queries: [query], accounting, assertCurrent: () => {}, now: () => 1000,
      resolveSession: async sessionId => replies[Number(sessionId) - 1] === 'denied'
        ? { errorCode: RPC_ERROR_CODES.FORBIDDEN } : { machineId: sessionId, cwd: '/repo' },
      readMachine: async machineId => {
        const number = Number(machineId);
        switch (replies[number - 1]) {
          case 'offline': throw createRpcCallError({ error: 'Offline', errorCode: 'machine_offline' });
          case 'slow': throw createRpcCallError({ error: 'Deadline', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE });
          case 'machineRefusal': throw createRpcCallError({ error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN,
            failureCause: { phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: 'machine_unavailable', httpStatus: 403 } });
          case 'backend': return { sessions: [{ sessionId: machineId, status: 'error', errorCode: 'BACKEND_UNAVAILABLE' }] };
          default: return reply(machineId, number + offset);
        }
      },
    });
    const initialWork = await read(['read', 'read'], 0);
    const inputs = { queries: [query], accounting, nowMs: 500 };
    const previous = resolveUsagePageAggregation({ ...inputs, work: initialWork }, bundledUsageModelPriceCatalog);
    expect(previous.results[0]?.workSummary?.mergedPrCount).toBe(2);
    const work = await read([first, second], 10);
    const settled = UsageQueryBatchResultSchema.parse(
      resolveUsagePageAggregation({ ...inputs, previous, work }, bundledUsageModelPriceCatalog));
    const slice = settled.results[0]!;
    const source = slice.sources.find(row => row.source === 'work');
    const expected = borrowPrevious ? [1, 2] : current;
    expect.soft(source?.status === 'stale', 'borrows prior evidence').toBe(borrowPrevious);
    expect.soft(slice.work?.outcomes.map(row => row.pullRequest.number).sort() ?? []).toEqual(expected);
    expect.soft(slice.work?.branches.map(row => row.branch.ref).sort() ?? []).toEqual(
      expected.map(number => 'refs/heads/branch-' + number));
    expect(slice.workSummary?.mergedPrCount).toBe(current.length === 2 ? 2 : undefined);
    if (current.length === 2) {
      const cold = UsageQueryBatchResultSchema.parse(resolveUsagePageAggregation({ ...inputs, work }, bundledUsageModelPriceCatalog));
      expect(JSON.stringify(settled)).toBe(JSON.stringify(cold));
    }
  });

  it('acquires a newly admitted turn set while reusing the exact admitted read', async () => {
    let calls = 0;
    const sessionReads = new Map<string, Promise<SessionWorkSourceResult>>();
    const input = { queries: [query], accounting, sessionReads, assertCurrent: () => {}, now: () => 1000,
      resolveSession: async () => ({ machineId: 'machine', cwd: '/repo' }),
      readMachine: async (_machineId: string, request: ScmWorkEvidenceReadRequest) => {
        calls++;
        expect(request.sessions[0]?.turnIds).toContain('turn');
        return { sessions: request.sessions.map(({ sessionId }) => ({ sessionId, status: 'partial', evidence: [], branchEvidence: [] })) };
      },
    };
    await Promise.all([collectUsageWorkSources(input), collectUsageWorkSources(input)]);
    expect(calls).toBe(1);
    const changed = { ...input, accounting: [{ query, status: 'available' as const, value: { ...value,
      sessionMembership: { turns: [...value.sessionMembership!.turns, { sessionId: 'session', turnId: 'new-turn', executions: ['happier' as const] }] } } }] };
    await collectUsageWorkSources(changed);
    expect(calls).toBe(2);
    await collectUsageWorkSources(changed);
    expect(calls).toBe(2);
  });
});
