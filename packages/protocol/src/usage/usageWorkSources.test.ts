import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { collectUsageWorkSources } from './usageWorkSources.js';
import { resolveUsagePageAggregation } from './resolveUsagePageAggregation.js';

const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeComparison: false,
  includeQuotaHistory: false, includeSessionEvidence: false, includeWorkEvidence: true });
const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
  tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
  cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
  sessionMembership: { turns: [{ sessionId: 'session', turnId: 'turn', executions: ['happier'] }] } });
const accounting = [{ query, value, status: 'available' as const }];

describe('Usage Work repository admission', () => {
  it('settles a witnessed non-repository without acquiring unusable remote pull-request evidence', async () => {
    let releaseRemote: ((value: unknown) => void) | undefined;
    const heldRemote = new Promise<unknown>(resolve => { releaseRemote = resolve; });
    const methods: string[] = [];
    const settled: Awaited<ReturnType<typeof collectUsageWorkSources>>[] = [];
    // SCM RPC is the external boundary. The real collector and batch source
    // projection must settle even when remote PR acquisition cannot answer.
    const pending = collectUsageWorkSources({ queries: [query], accounting, assertCurrent: () => {},
      readSession: async () => async method => {
        methods.push(method);
        return method === RPC_METHODS.SCM_BRANCH_LIST ? { success: false, errorCode: 'NOT_REPOSITORY' } : heldRemote;
      },
    }).then(work => { settled.push(work); });
    try {
      await vi.waitFor(() => expect(settled).toHaveLength(1));
      expect(methods).toEqual([RPC_METHODS.SCM_BRANCH_LIST]);
      expect(settled[0]?.[0]).toMatchObject({ status: 'unsupported', evidence: [], branchEvidence: [] });
      const batch = resolveUsagePageAggregation({ queries: [query], accounting, work: settled[0] });
      expect(batch.results[0]?.sources).toContainEqual({ source: 'work', status: 'unsupported' });
      expect(batch.results[0]?.accounting?.totals.tokens.total).toBe(1);
    } finally {
      releaseRemote?.({ success: false, errorCode: 'NOT_REPOSITORY' });
      await pending;
    }
  });
  it.each([false, true])('retains every requested PR state when branch support alone is unavailable: %s', async branchUnsupported => {
    const checkpoint = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' } as const;
    const branch = { ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } };
    const methods: string[] = [];
    const work = await collectUsageWorkSources({ queries: [query], accounting, assertCurrent: () => {},
      readSession: async () => async (method, request) => {
        methods.push(method);
        if (method === RPC_METHODS.SCM_BRANCH_LIST) return branchUnsupported ? { success: false, errorCode: 'FEATURE_UNSUPPORTED' }
          : { success: true, branches: [], branchEvidenceStatus: 'partial', branchEvidence: [branch] };
        const state = 'state' in request ? request.state : undefined;
        const pullRequest = { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
          number: state === 'open' ? 1 : state === 'closed' ? 2 : 3, title: 'Outcome', url: 'https://github.com/owner/repo/pull/1',
          baseBranch: 'main', headBranch: 'feature', state };
        return { success: true, pullRequests: [pullRequest], workEvidenceStatus: 'partial', workEvidence: [{ ...checkpoint, pullRequest }] };
      },
    });
    expect(methods).toEqual([RPC_METHODS.SCM_BRANCH_LIST, ...Array(3).fill(RPC_METHODS.SCM_PULL_REQUEST_LIST)]);
    expect(work[0]?.status).toBe('partial');
    expect(work[0]?.evidence?.map(witness => witness.pullRequest.state)).toEqual(['open', 'closed', 'merged']);
    expect(work[0]?.branchEvidence).toEqual(branchUnsupported ? [] : [branch]);
  });
});
