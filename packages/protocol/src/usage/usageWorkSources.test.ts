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
      queries: [query], accounting, assertCurrent: () => {},
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
    expect(result.workSummary?.mergedPrCount).toBe(1);
    expect(result.work?.allocations.map(row => [row.contribution.sessionId, row.reason, row.contribution.cost.reportedUsd])).toEqual([
      ['linked', 'allocated', 1], ['unlinked', 'missing_evidence', 2], ['unavailable', 'missing_evidence', 3],
      ['unresolved', 'missing_evidence', 4], ['offline', 'missing_evidence', 5],
      ...(fails ? [['denied', 'missing_evidence', 6], ['slow', 'missing_evidence', 7]] : []),
    ]);
    expect(result.accounting?.totals.cost.reportedUsd).toBe(reportedUsd);
    const workSource = {
      source: 'work', status: 'partial', errorCode: fails ? 'work_evidence_failed' : 'machine_offline',
      unreadSessions: { machine_unavailable: 2, failed: 1, ...(fails ? { not_entitled: 1, timed_out: 1 } : {}) },
    };
    expect(result.sources.find(source => source.source === 'work')).toEqual(workSource);
    const delivered = UsageQueryBatchResultSchema.parse(projectUsageQueryDelivery(batch, 'agent')).results[0];
    expect(delivered?.sources.find(source => source.source === 'work')).toEqual(workSource);
    expect(delivered?.workSummary).toEqual(result.workSummary);
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
      const work = await collectUsageWorkSources({ queries: [query], accounting: usage, assertCurrent: () => {},
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
      assertCurrent: () => {},
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
    const work = await collectUsageWorkSources({ queries: [query], accounting, assertCurrent: () => {},
      resolveSession: async () => ({ machineId: 'machine', cwd: '/repo' }),
      readMachine: async () => { throw createRpcCallError({
        error: errorCode,
        errorCode,
        failureCause: causeCode ? { phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: causeCode, httpStatus: 403 } : undefined,
      }); },
    });
    const result = resolveUsagePageAggregation({ queries: [query], accounting, work }, bundledUsageModelPriceCatalog);
    expect(result.results[0]?.sources.find(source => source.source === 'work')).toEqual(unavailable
      ? { source: 'work', status: 'unknown', unreadSessions: { machine_unavailable: 1 } }
      : { source: 'work', status: 'error', errorCode: 'work_evidence_failed', unreadSessions: { not_entitled: 1 } });
    expect(work[0]?.evidence ?? []).toEqual([]);
  });
  it('keeps admitted siblings when one Session is refused and excludes foreign Session witnesses', async () => {
    const turns = ['allowed', 'refused', 'forged'].map(sessionId => ({ sessionId, turnId: 'turn', executions: ['happier'] }));
    const branch: ScmBranchWorkEvidence = { sessionId: 'allowed', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } };
    const work = await collectUsageWorkSources({ queries: [query],
      accounting: [{ query, value: { ...value, sessionMembership: { turns } }, status: 'available' }], assertCurrent: () => {},
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
  it('acquires a newly admitted turn set while reusing the exact admitted read', async () => {
    let calls = 0;
    const sessionReads = new Map<string, Promise<SessionWorkSourceResult>>();
    const input = { queries: [query], accounting, sessionReads, assertCurrent: () => {},
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
