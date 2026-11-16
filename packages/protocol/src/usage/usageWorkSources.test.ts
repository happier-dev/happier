import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import type { ScmWorkEvidenceReadRequest, ScmBranchWorkEvidence } from '../scm/index.js';
import type { SessionWorkSourceResult } from './usageWorkSources.js';
import { UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { collectUsageWorkSources } from './usageWorkSources.js';
import { resolveUsagePageAggregation } from './resolveUsagePageAggregation.js';
import { createRpcCallError } from '../rpc/errors.js';

const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeComparison: false,
  includeQuotaHistory: false, includeSessionEvidence: false, includeWorkEvidence: true });
const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
  tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
  cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
  sessionMembership: { turns: [{ sessionId: 'session', turnId: 'turn', executions: ['happier'] }] } });
const accounting = [{ query, value, status: 'available' as const }];

describe('Usage Work repository admission', () => {
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
  it.each(['target_unavailable', 'RPC_FORBIDDEN'] as const)('distinguishes unavailable Work hosts from authorization failure: %s', async code => {
    let calls = 0;
    const work = await collectUsageWorkSources({ queries: [query], accounting, assertCurrent: () => {},
      resolveSession: async () => ({ machineId: 'machine', cwd: '/repo' }),
      readMachine: async () => { calls++; throw createRpcCallError({ error: code, errorCode: code }); },
    });
    const result = resolveUsagePageAggregation({ queries: [query], accounting, work }, bundledUsageModelPriceCatalog);
    expect(result.results[0]?.sources.find(source => source.source === 'work')).toEqual(code === 'target_unavailable'
      ? { source: 'work', status: 'unknown' }
      : { source: 'work', status: 'error', errorCode: 'work_evidence_failed' });
    expect(work[0]?.evidence ?? []).toEqual([]);
    expect(calls).toBe(1);
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
        { sessionId: 'refused', status: 'error', evidence: [], branchEvidence: [], errorCode: 'RPC_FORBIDDEN' },
        { sessionId: 'forged', status: 'partial', evidence: [], branchEvidence: [branch] },
      ] }),
    });
    expect(work[0]).toMatchObject({ status: 'partial', errorCode: 'work_evidence_failed', branchEvidence: [branch] });
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
