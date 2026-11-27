import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getUsageQueryKey, normalizeUsageQuery, resolveUsageQueryPeriod } from '../inputs/usageQuery.js';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema } from '../usage/resolveUsagePageAggregation.js';
import { enforceExternalActionResponseEnvelopeLimitV1 } from './externalActionApi.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from './externalActionLimits.js';
import { UsageAnalyticsQueryResponseSchema } from '../usage/usageAnalyticsContracts.js';
import { decodeBase64 } from '../crypto/base64.js';
import type { UsageWorkEvidence } from '../usage/usageOutcomeAllocation.js';
import { resolveInputOptions } from '../inputs/inputOptions.js';
import { bundledUsageModelPriceCatalog } from '../usage/usageModelPriceCatalog.js';
import { UsageModelPriceCatalogSchema } from '../usage/usageModelPriceSchemas.js';
import * as usageDelivery from '../usage/projectUsageQueryDelivery.js';
import * as strictJson from '../plugins/contributions/strictJsonValue.js';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema, type ApiTokenGrantV1 } from '../auth/apiTokenGrant.js';
import { USAGE_PRICE_ACTION_IDS, USAGE_PRIVATE_RECAP_ACTION_IDS, USAGE_QUERY_ACTION_ID_V1 } from '../usage/usageActionIdsV1.js';

const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } });
const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: ['a', 'b'] });

// Check the supplied authenticated transport ports before adapting this fixture
// to the cross-family executor; unrelated family ports are unreachable here.
describe('personal usage Action execution', () => {
  describe('API-token Environment usage scope', () => {
    const allowed = 'app_calls:staging';
    const alsoAllowed = 'app_calls:preview';
    const outside = 'app_calls:production';
    const environmentGrant = ApiTokenGrantV1Schema.parse({
      ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: [USAGE_QUERY_ACTION_ID_V1, USAGE_PRICE_ACTION_IDS.get, USAGE_PRIVATE_RECAP_ACTION_IDS.compose] },
      targets: { sessions: [], machines: ['machine-1'], environments: ['staging', 'preview'] },
    });

    function executeUsage(grant: ApiTokenGrantV1) {
      // Simulate the usage data transport with one priced event per read source.
      const queryUsage: NonNullable<ActionExecutorDeps['usageActions']>['query'] = async ({ queries }, _context, readChild) => {
        const modelIds = Object.keys(bundledUsageModelPriceCatalog.models).slice(0, 1);
        if (!readChild) throw new Error('Expected the App calls price reader');
        const prices = await readChild(USAGE_PRICE_ACTION_IDS.get, { modelIds });
        if (!prices.ok) return prices;
        return resolveUsagePageAggregation({ queries, accounting: queries.map(query => ({
          query, status: 'available', value: { ...accounting, totals: { ...accounting.totals,
            eventCount: query.sources.length, cost: { ...accounting.totals.cost, reportedUsd: query.sources.length },
            tokens: { ...accounting.totals.tokens, input: query.sources.length, output: 0, total: query.sources.length } } },
        })) }, UsageModelPriceCatalogSchema.parse(prices.result));
      };
      const executor = createActionExecutor({ usageActions: { query: queryUsage,
        prices: { get: async () => bundledUsageModelPriceCatalog, refresh: async () => bundledUsageModelPriceCatalog },
      } } as ActionExecutorDeps);
      const context = {
        surface: 'api' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1' },
        externalActionCredential: { accountId: 'account-1', principalId: 'account-1', credentialId: 'token-1', grant },
      };
      return (actionId: Parameters<typeof executor.execute>[0], input: unknown) => executor.execute(actionId, input, context);
    }

    function read(sources: string[], grant: ApiTokenGrantV1) {
      return executeUsage(grant)(USAGE_QUERY_ACTION_ID_V1, { queries: [{ sources }] });
    }

    it('defaults an empty source selection to the granted Environments', async () => {
      expect(await read([], environmentGrant)).toMatchObject({ ok: true, result: { results: [
        { shownQuery: { sources: [alsoAllowed, allowed] }, accounting: { totals: { eventCount: 2 } } },
      ] } });
    });

    it('composes a private recap over the granted app sources', async () => {
      const input = { query, selectedFields: ['tokens'] };
      expect(await executeUsage(API_TOKEN_FULL_GRANT_V1)(USAGE_PRIVATE_RECAP_ACTION_IDS.compose, input))
        .toMatchObject({ ok: true, result: { kind: 'composed' } });
      expect(await executeUsage(environmentGrant)(USAGE_PRIVATE_RECAP_ACTION_IDS.compose, input))
        .toMatchObject({ ok: true, result: { kind: 'composed', facts: { tokens: { total: 2 } } } });
    });

    it('preserves explicit source scope in a private recap for an Environment token', async () => {
      const compose = USAGE_PRIVATE_RECAP_ACTION_IDS.compose;
      const recap = (sources: string[]) => ({ query: normalizeUsageQuery({ ...query, sources }), selectedFields: ['tokens'] });
      const execute = executeUsage(environmentGrant);
      expect(await execute(compose, recap([outside]))).toMatchObject({
        ok: false, errorCode: 'credential_scope_denied', details: { reason: 'environment_not_granted' },
      });
      expect(await execute(compose, recap([allowed, outside]))).toMatchObject({
        ok: true, result: { kind: 'composed', facts: { tokens: { total: 1 } } },
      });
      expect(await executeUsage(API_TOKEN_FULL_GRANT_V1)(compose, recap([outside]))).toMatchObject({
        ok: true, result: { kind: 'composed', facts: { tokens: { total: 0 } } },
      });
    });

    it('reads and prices only the granted Environment in a mixed-source query', async () => {
      expect(await read([allowed, outside], environmentGrant)).toMatchObject({ ok: true, result: { results: [
        { shownQuery: { sources: [allowed] }, accounting: { totals: { eventCount: 1, cost: { reportedUsd: 1 } } } },
      ] } });
    });

    it('refuses an exclusively out-of-scope query', async () => {
      expect(await read([outside], environmentGrant)).toMatchObject({
        ok: false, errorCode: 'credential_scope_denied', details: { reason: 'environment_not_granted' },
      });
    });

    it('retains all requested app usage for an Account-wide token', async () => {
      expect(await read([allowed, outside], API_TOKEN_FULL_GRANT_V1)).toMatchObject({ ok: true, result: { results: [
        { shownQuery: { sources: [outside, allowed] }, accounting: { totals: { eventCount: 2, cost: { reportedUsd: 2 } } } },
      ] } });
    });
  });

  it('delivers complete Work with bytes proportional to contributions sharing an outcome', async () => {
    const heavy = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
      includeQuotaHistory: true, includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: true });
    const small = normalizeUsageQuery({ ...heavy, session: 'session-0' });
    // The performance lane's Account-scale shape: 1k Sessions linked to one PR.
    // One shared outcome must not repeat every contribution identity in every allocation.
    const contributions = Array.from({ length: 1_000 }, (_, index) => ({
      id: `session-${index}:turn-${index}:runtime-contribution-0`, observedAtMs: 150,
      sessionId: `session-${index}`, turnId: `turn-${index}`, agentId: 'codex', modelId: null,
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
      tokens: accounting.totals.tokens, cost: accounting.totals.cost,
    }));
    const evidence: UsageWorkEvidence[] = contributions.map(row => ({ sessionId: row.sessionId, turnId: row.turnId,
      repositoryKey: 'repo', checkpointRef: `checkpoint-${row.sessionId}`, checkpointCommitSha: 'a'.repeat(40),
      commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Work', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open',
      } }));
    const rich = resolveUsagePageAggregation({ queries: [heavy, small],
      accounting: [heavy, small].map(query => ({ query, status: 'available' as const,
        value: { ...accounting, contributions: query === small ? contributions.slice(0, 1) : contributions } })),
      work: [heavy, small].map(query => ({ query, status: 'available' as const, evidence })),
    }, bundledUsageModelPriceCatalog);
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(rich)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    let reads = 0;
    let admitted = rich;
    const deps: Partial<ActionExecutorDeps> = { usageActions: { query: async () => { reads += 1; return admitted; } } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    // Today at the existing Account-scale shape must reach an agent without
    // Pi's 50 KiB tool truncation (extensionSource.ts TOOL_OUTPUT_MAX_BYTES),
    // and therefore also its 1 MiB bridge refusal. This is not a Usage cap.
    const today = normalizeUsageQuery({ period: { relative: 'today' } });
    const todayRows = contributions.map(row => ({ ...row, observedAtMs: Date.now() }));
    const todayBatch = resolveUsagePageAggregation({ queries: [today],
      accounting: [{ query: today, status: 'available', value: { ...accounting, contributions: todayRows } }],
      work: [{ query: today, status: 'available', evidence }],
    }, bundledUsageModelPriceCatalog);
    for (const surface of ['agent', 'mcp'] as const) {
      const agent = await createActionExecutor({ usageActions: { query: async () => todayBatch } } as ActionExecutorDeps)
        .execute('usage.query', { queries: [{ period: { relative: 'today' } }] }, { surface });
      expect(agent.ok).toBe(true);
      if (!agent.ok) throw new Error('Expected agent summary');
      expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(agent.result)).toBeLessThan(50 * 1024);
      const slice = UsageQueryBatchResultSchema.parse(agent.result).results[0]!;
      expect(slice.accounting?.totals).toEqual(accounting.totals);
      expect(slice.workSummary).toMatchObject({ sessionCount: 1_000, allocatedContributionCount: 1_000 });
      expect(slice.work).toBeUndefined();
      expect(slice.incomplete).toMatchObject({ recovery: 'narrow_query', omittedSections: ['work'] });
    }
    for (const surface of ['agent', 'mcp'] as const) {
      const narrowed = await createActionExecutor({ usageActions: { query: async () => ({ ...rich, results: [rich.results[1]!] }) } } as ActionExecutorDeps)
        .execute('usage.query', { queries: [small] }, { surface });
      const work = narrowed.ok && UsageQueryBatchResultSchema.parse(narrowed.result).results[0]?.work;
      expect(work).toMatchObject({ outcomes: [{ pullRequest: { number: 1 } }],
        allocations: [{ contributionId: contributions[0]!.id }] });
    }
    const result = await executor.execute('usage.query', { queries: [heavy, small, heavy] }, { surface: 'cli' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected useful admitted Usage facts');
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(result.result)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(enforceExternalActionResponseEnvelopeLimitV1({ v: 1, actionId: 'usage.query', requestId: 'evidence-heavy', execution: result }))
      .toMatchObject({ execution: { ok: true } });
    const batch = UsageQueryBatchResultSchema.parse(result.result);
    const bounded = batch.results.find(slice => slice.key === getUsageQueryKey(heavy))!;
    expect(bounded).toMatchObject({ requestedQuery: heavy, shownQuery: heavy, accounting: { totals: accounting.totals } });
    expect(bounded.work?.allocations).toHaveLength(1_000);
    expect(bounded.work?.outcomes[0]?.contributionIds).toHaveLength(1_000);
    expect(bounded.work?.allocations.map(row => row.contributionId)).toEqual(contributions.map(row => row.id));
    expect(bounded).not.toHaveProperty('incomplete');
    expect(bounded.workSummary).toMatchObject({ sessionCount: 1_000, contributionCount: 1_000, allocatedContributionCount: 1_000 });
    const narrow = batch.results.find(slice => slice.key !== bounded.key)!;
    expect(narrow.work?.allocations).toHaveLength(1);
    expect(narrow).not.toHaveProperty('incomplete');
    expect(reads).toBe(1);
    expect(rich.results.find(slice => slice.key === bounded.key)?.work?.allocations).toHaveLength(1_000);
    const selected = contributions.slice(0, 500);
    const near = normalizeUsageQuery({ ...heavy, session: selected.map(row => row.sessionId) });
    admitted = resolveUsagePageAggregation({ queries: [near], accounting: [{ query: near, status: 'available',
      value: { ...accounting, contributions: selected } }], work: [{ query: near, status: 'available', evidence }] }, bundledUsageModelPriceCatalog);
    const nearBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(admitted);
    // Doubling the real contributions adds at most another half-sized slice.
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(rich)).toBeLessThan(nearBytes * 2 +
      measureExternalActionResultResponseEnvelopeUtf8BytesV1({ v: 1, results: [rich.results[1]] }));
    const recovered = await executor.execute('usage.query', { queries: [near] }, { surface: 'cli' });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('Expected caller-selected evidence');
    const recoveredSlice = UsageQueryBatchResultSchema.parse(recovered.result).results[0]!;
    expect(recoveredSlice.work?.allocations).toHaveLength(selected.length);
    expect(recoveredSlice).not.toHaveProperty('incomplete');
    expect(reads).toBe(2);
    // A real envelope-sized collection still retains bounded Work/session facts.
    const copies = Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES /
      measureExternalActionResultResponseEnvelopeUtf8BytesV1({ v: rich.v, results: [rich.results[0]] })) + 1;
    const wideQueries = Array.from({ length: copies }, (_, index) => normalizeUsageQuery({ ...heavy,
      period: { startMs: 100, endMs: 200 + index } }));
    const wide = resolveUsagePageAggregation({ queries: wideQueries,
      accounting: wideQueries.map(query => ({ query, status: 'available' as const, value: { ...accounting, contributions } })),
      work: wideQueries.map(query => ({ query, status: 'available' as const, evidence })),
    }, bundledUsageModelPriceCatalog);
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(wide)).toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const wideDelivery = usageDelivery.projectUsageQueryDelivery(wide);
    expect(wideDelivery.results.some(slice => slice.incomplete?.omittedSections.includes('workSessionDetail'))).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse(wideDelivery).success).toBe(true);
    for (const slice of wideDelivery.results) {
      expect(slice.workSummary).toMatchObject({ sessionCount: 1_000, contributionCount: 1_000, allocatedContributionCount: 1_000 });
      expect(slice.accounting?.totals).toEqual(accounting.totals);
    }
    console.info('[PERF usage delivery]', JSON.stringify({ section: 'work',
      richBytes: measureExternalActionResultResponseEnvelopeUtf8BytesV1(rich),
      deliveredBytes: measureExternalActionResultResponseEnvelopeUtf8BytesV1(result.result), nearBytes, nearRows: selected.length }));
  }, 0); // Real envelope-scale byte contract, not a five-second throughput gate.
  it('preserves Week Work links and typed counts when only Session detail exceeds the Action envelope', async () => {
    const week = normalizeUsageQuery({ period: { startMs: 0, endMs: 7 * 86_400_000 },
      includeWorkEvidence: true, includeComparison: false });
    const sha = 'c'.repeat(40);
    const contribution = (index: number, projectKey: string) => ({
      id: `contribution-${index}`, sessionId: `session-${index}`, turnId: `turn-${index}`, observedAtMs: 1,
      agentId: 'muse', modelId: null, machineId: null, projectKey, workspaceId: null, source: 'runtime',
      tokens: accounting.totals.tokens, cost: accounting.totals.cost,
    });
    const build = (projectKey: string, firstTitle = 'Work', requestedQuery = week) => {
      const contributions = Array.from({ length: 11 }, (_, index) => contribution(index, projectKey));
      const branchEvidence = contributions.slice(0, 10).map((row, index) => ({
        sessionId: row.sessionId, turnId: row.turnId, repositoryKey: 'repo',
        checkpointRef: `checkpoint-${index}`, checkpointCommitSha: sha, commitSha: sha,
        attributionScope: 'no_happier_checkpoint_overlap_observed' as const,
        branch: { ref: `refs/heads/work-${index}`, headSha: sha },
      }));
      const evidence: UsageWorkEvidence[] = branchEvidence.slice(0, 9).map(({ branch: _branch, ...row }, index) => ({
        ...row, pullRequest: {
          provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
            nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
          number: index + 1, title: index === 0 ? firstTitle : 'Work', url: `https://github.com/owner/repo/pull/${index + 1}`,
          baseBranch: 'main', headBranch: `work-${index}`,
          ...(index === 1 ? { state: 'merged' as const, mergedAtMs: 2 } : { state: 'open' as const }),
        },
      }));
      return resolveUsagePageAggregation({ queries: [requestedQuery],
        accounting: [{ query: requestedQuery, status: 'available', value: { ...accounting, contributions } }],
        work: [{ query: requestedQuery, status: 'partial', errorCode: 'machine_offline', asOfMs: 7,
          unreadSessions: { machine_unavailable: 1 }, evidence, branchEvidence }],
        howYouWork: requestedQuery.includeCoach ? [{ query: requestedQuery, detail: { status: 'available', phaseEvents: [{
          evidenceId: 'sibling-read', sessionId: 'session-0', turnId: 'turn-0', observedAtMs: 1,
          kind: 'read', method: 'tool_classification',
        }] } }] : [],
      }, bundledUsageModelPriceCatalog);
    };
    const invokeBatch = async (batch: ReturnType<typeof build>, surface: 'ui' | 'cli') => {
      const executor = createActionExecutor({ usageActions: { query: async () => batch } } as ActionExecutorDeps);
      const reply = await executor.execute('usage.query', { queries: batch.results.map(slice => slice.requestedQuery) }, { surface });
      if (!reply.ok) throw new Error(reply.errorCode);
      expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(reply.result))
        .toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
      return UsageQueryBatchResultSchema.parse(reply.result).results;
    };
    const invoke = async (batch: ReturnType<typeof build>, surface: 'ui' | 'cli') => (await invokeBatch(batch, surface))[0]!;

    const small = build('project');
    const complete = await invoke(small, 'cli');
    expect(complete.work).toEqual(small.results[0]!.work);
    expect(complete.accounting?.contributions).toEqual(small.results[0]!.accounting?.contributions);
    expect(complete.incomplete).toBeUndefined();

    const weekSized = build('p'.repeat(2_300_000));
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(weekSized))
      .toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const compact = await invoke(weekSized, 'cli');
    expect(compact).toMatchObject({ accounting: { totals: accounting.totals },
      workSummary: complete.workSummary,
      incomplete: { reason: 'response_size_limit', omittedSections: ['workSessionDetail'], recovery: 'narrow_query' } });
    expect(compact.work?.outcomes.map(row => row.pullRequest)).toEqual(complete.work?.outcomes.map(row => row.pullRequest));
    expect(compact.work?.outcomes).toHaveLength(9);
    expect(compact.work?.branches.map(row => row.branch)).toEqual(complete.work?.branches.map(row => row.branch));
    expect(compact.work?.branches).toHaveLength(10);
    expect(compact.work?.allocations).toHaveLength(0);
    expect(compact.work?.branchAllocations).toHaveLength(0);
    expect(compact.accounting?.contributions).toBeUndefined();
    expect(compact.mergedOutcomes).toEqual(complete.mergedOutcomes);
    expect(compact.mergedOutcomes?.linkedMergedCount).toBe(1);
    expect(compact.mergedOutcomes?.mergedInPeriodCount).toBeUndefined();
    expect(UsageQueryBatchResultSchema.safeParse({ v: 1, results: [{
      ...compact, mergedOutcomes: { ...compact.mergedOutcomes, mergedInPeriodCount: 1 },
    }] }).success).toBe(false);
    expect(compact.sources).toEqual(complete.sources);
    expect(compact.sources.find(row => row.source === 'work')).toMatchObject({
      status: 'partial', asOfMs: 7, unreadSessions: { machine_unavailable: 1 },
    });
    expect(await invoke(weekSized, 'ui')).toEqual(compact);

    const sibling = build('sibling', 'Work', normalizeUsageQuery({ ...week, period: { startMs: 0, endMs: 6 * 86_400_000 }, includeCoach: true }));
    const completeSibling = await invoke(sibling, 'cli');
    expect(completeSibling.howYouWork?.autopsy?.events).toHaveLength(1);
    expect(completeSibling.coach).toBeDefined();

    // Calibrate the ASCII title against the actual envelope. A's compact link body
    // plus B's complete answer is one byte over, but omitting B's detail fits.
    const withFirstTitle = (slice: typeof compact, title: string) => ({
      ...slice, work: { ...slice.work!, outcomes: slice.work!.outcomes.map(row => row.pullRequest.number === 1
        ? { ...row, pullRequest: { ...row.pullRequest, title } } : row) },
    });
    const envelopeBytes = (results: typeof weekSized.results) =>
      measureExternalActionResultResponseEnvelopeUtf8BytesV1({ ...weekSized, results });
    const baseBytes = envelopeBytes([withFirstTitle(compact, ''), completeSibling]);
    const title = 'a'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - baseBytes + 1);
    const large = build('p'.repeat(2_300_000), title);
    const compactLarge = withFirstTitle(compact, title);
    const mixedBytes = envelopeBytes([compactLarge, completeSibling]);
    expect(mixedBytes).toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES + 1);

    const [largeDelivery, smallDelivery] = await invokeBatch({
      ...large, results: [...large.results, ...sibling.results],
    }, 'cli');
    expect(largeDelivery).toEqual(compactLarge);
    expect(smallDelivery).toBeDefined();
    if (!largeDelivery || !smallDelivery) throw new Error('Missing delivered slices');
    const bothCompactBytes = envelopeBytes([largeDelivery, smallDelivery]);
    expect(bothCompactBytes).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(envelopeBytes([...large.results, completeSibling]) - mixedBytes)
      .toBeGreaterThan(mixedBytes - bothCompactBytes);
    for (const [delivered, admitted] of [[largeDelivery, large.results[0]!], [smallDelivery, completeSibling]] as const) {
      expect(delivered.incomplete).toEqual({
        reason: 'response_size_limit', omittedSections: ['workSessionDetail'], recovery: 'narrow_query',
      });
      expect(delivered.work).toEqual({ ...admitted.work, allocations: [], branchAllocations: [] });
      expect(delivered.accounting?.totals).toEqual(admitted.accounting?.totals);
      expect(delivered.workSummary).toEqual(admitted.workSummary);
      expect(delivered.mergedOutcomes).toEqual(admitted.mergedOutcomes);
      expect(delivered.sources).toEqual(admitted.sources);
      expect(delivered.sources.find(row => row.source === 'work')).toMatchObject({
        status: 'partial', asOfMs: 7, unreadSessions: { machine_unavailable: 1 },
      });
      expect(delivered.howYouWork).toEqual(admitted.howYouWork);
      expect(delivered.coach).toEqual(admitted.coach);
    }

    const linksTooLarge = build('project', 'p'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES));
    const [omitted, siblingDelivery] = await invokeBatch({
      ...linksTooLarge, results: [...linksTooLarge.results, ...sibling.results],
    }, 'cli');
    expect(siblingDelivery).toEqual(completeSibling);
    expect(omitted).toBeDefined();
    if (!omitted) throw new Error('missing oversized result');
    expect(omitted.work).toBeUndefined();
    expect(omitted.incomplete?.omittedSections).toEqual(['work']);
    expect(omitted.workSummary).toEqual(complete.workSummary);
  }, 0);

  it('marks oversized transcript detail incomplete without discarding admitted Coach or accounting', async () => {
    const event = { evidenceId: 'phase-0', sessionId: 'session-0', turnId: 'turn-0', observedAtMs: 150,
      kind: 'read' as const, method: 'tool_classification' as const };
    // Cross the real byte boundary with ordinary content-free transcript facts,
    // not a test-only production limit or oversized individual string.
    const count = Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / new TextEncoder().encode(JSON.stringify(event)).byteLength);
    const phaseEvents = Array.from({ length: count }, (_, index) => ({ ...event, evidenceId: `phase-${index}` }));
    const rich = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: accounting }],
      howYouWork: [{ query, detail: { status: 'available', phaseEvents } }],
    }, bundledUsageModelPriceCatalog);
    const lastEvent = rich.results[0]!.howYouWork!.autopsy!.events.at(-1)!;
    const evidenceId = lastEvent.evidenceId;
    let evidenceReads = 0;
    // Observe traversal of one real evidence leaf without replacing the byte owner.
    Object.defineProperty(lastEvent, 'evidenceId', { enumerable: true, get: () => { evidenceReads++; return evidenceId; } });
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(rich)).toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const onePassReads = evidenceReads;
    evidenceReads = 0;
    usageDelivery.projectUsageQueryDelivery(rich);
    expect(evidenceReads, 'one evidence measurement per query, including size-driven omission').toBe(onePassReads);
    const deps: Partial<ActionExecutorDeps> = { usageActions: { query: async () => rich } };
    const result = await createActionExecutor(deps as ActionExecutorDeps).execute('usage.query', { queries: [query] }, { surface: 'mcp' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected useful admitted Usage facts');
    const batch = UsageQueryBatchResultSchema.parse(result.result);
    expect(batch.results[0]).toMatchObject({ accounting: { totals: accounting.totals }, coach: rich.results[0]?.coach,
      incomplete: { reason: 'response_size_limit', omittedSections: ['howYouWork'], recovery: 'narrow_query' } });
    expect(batch.results[0]?.howYouWork).toBeUndefined();
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(result.result)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(rich.results[0]?.howYouWork?.autopsy?.events).toHaveLength(count);
    // Both ordinary evidence bodies exceed the envelope after the other is
    // removed; a second omission must use the exact remaining byte count.
    const sibling = normalizeUsageQuery({ ...query, metric: 'cost' });
    const paired = resolveUsagePageAggregation({ queries: [query, sibling],
      accounting: [query, sibling].map(query => ({ query, status: 'available' as const, value: accounting })),
      howYouWork: [query, sibling].map(query => ({ query, detail: { status: 'available' as const, phaseEvents } })),
    }, bundledUsageModelPriceCatalog);
    const pairedDelivery = usageDelivery.projectUsageQueryDelivery(paired);
    expect(pairedDelivery.results).toHaveLength(2);
    for (const slice of pairedDelivery.results) {
      expect(slice.incomplete?.omittedSections).toEqual(['howYouWork']);
      expect(slice.howYouWork).toBeUndefined();
    }
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(pairedDelivery)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    console.info('[PERF usage delivery]', JSON.stringify({ section: 'howYouWork', rows: count,
      richBytes: measureExternalActionResultResponseEnvelopeUtf8BytesV1(rich),
      deliveredBytes: measureExternalActionResultResponseEnvelopeUtf8BytesV1(result.result) }));
  }, 0); // Real envelope-scale byte contract, not a five-second throughput gate.
  it('delivers bytes proportional to visible slices while explicit exports retain selected raw inputs', async () => {
    const noEvidence = { includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false };
    const summary = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, ...noEvidence });
    let count = 20; // EXPORT-C's observed accounting population; 401 is the existing Session-scale fixture.
    const deps: Partial<ActionExecutorDeps> = { usageActions: { query: async input => {
      const contributions = Array.from({ length: count }, (_, index) => ({ id: `raw-${index}`, observedAtMs: 150,
        sessionId: null, turnId: null, agentId: 'codex', modelId: null, machineId: null, projectKey: null,
        workspaceId: null, source: 'runtime', tokens: accounting.totals.tokens, cost: accounting.totals.cost }));
      const value = { ...accounting, contributions, priceCatalog: bundledUsageModelPriceCatalog };
      return resolveUsagePageAggregation({ queries: input.queries,
        accounting: input.queries.map(query => ({ query, value, status: 'available' as const })) }, bundledUsageModelPriceCatalog);
    } } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const two = await executor.execute('usage.query', { queries: [summary, { ...summary, metric: 'cost' }, summary] }, { surface: 'cli' });
    count = 401;
    const one = await executor.execute('usage.query', { queries: [summary, summary] }, { surface: 'cli' });
    expect(two.ok && one.ok).toBe(true);
    if (!two.ok || !one.ok) throw new Error('Expected admitted query results');
    const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(serializedBytes(one.result), 'more raw accounting cannot outweigh an additional visible summary slice')
      .toBeLessThan(serializedBytes(two.result));
    expect(JSON.stringify(one.result)).not.toContain('raw-');
    expect(UsageQueryBatchResultSchema.parse(one.result).results[0]?.accounting?.priceCatalog).toBeUndefined();
    const exported = await executor.execute('usage.export', { query: summary, format: 'json',
      fields: ['contributions', 'priceCatalog'] }, { surface: 'cli' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error('Expected explicit raw export');
    const file = exported.result as { base64: string };
    const document = JSON.parse(new TextDecoder().decode(decodeBase64(file.base64)));
    expect(document.query).toEqual(summary);
    expect(document.accounting.contributions).toHaveLength(401);
    expect(document.accounting.priceCatalog.provenance).toEqual(bundledUsageModelPriceCatalog.provenance);
  });

  it('offers a grouped Project once in agent Usage choices, for usage stamped by any of its checkouts (owner 11-08)', async () => {
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, breakdowns: {
      project: [{ key: 'project-1', label: 'App', ...accounting.totals }, { key: 'member', ...accounting.totals }] } });
    const refs = ['project-1', 'member'].map(id => ({ id, serverId: 'home-1', machineId: `m-${id}`, rootPath: '/app', projectKey: 'project-1', createdAtMs: 1 }));
    const deps: Partial<ActionExecutorDeps> = {
      projectWorkspaceRefs: async () => ({ workspaceRefs: refs }),
      usageActions: { query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: request.queries.map(query => ({ query, value, status: 'available' as const })) }, bundledUsageModelPriceCatalog) } };
    expect(await resolveInputOptions({ deps: deps as ActionExecutorDeps, ctx: { surface: 'agent', serverId: 'home-1' }, actionId: null,
      optionsSourceId: 'usage.filters.projects', input: {}, readFailure: () => null,
      resolveSessionId: () => null, reviewScope: () => undefined })).toEqual({ ok: true, result: [{ value: 'project-1', label: 'App' }] });
  });

  it('keeps open-start Project choices and matches usage.query for explicit UTC and local periods', async () => {
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    const outside = 'c'.repeat(64);
    const observedAtMs = Date.parse('2026-11-15T23:30:00Z');
    const nowMs = Date.parse('2026-11-22T10:00:00Z');
    const options = [
      { value: first, label: 'Archive' },
      { value: second, label: 'Notes' },
    ];
    const projectFacts = new Map([...options, { value: outside, label: 'Unused' }]
      .map(({ value, label }) => [value, { label }]));
    const deps: Partial<ActionExecutorDeps> = {
      projectWorkspaceRefs: async () => ({ workspaceRefs: [], usageProjects: projectFacts }),
      usageActions: { query: async ({ queries }) => resolveUsagePageAggregation({ queries,
        accounting: queries.map(query => {
          const { startMs } = resolveUsageQueryPeriod(query, nowMs);
          const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting,
            scopeKeys: [{ dimension: 'project', keys: startMs === undefined || startMs <= observedAtMs ? [first, second] : [] }] });
          return { query, value, status: 'available' as const };
        }),
      }, bundledUsageModelPriceCatalog) },
    };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const input = { actionId: 'usage.query', optionsSourceId: 'usage.filters.projects' };
    const context = { surface: 'agent', serverId: 'home-1' } as const;
    expect(await executor.execute('action.options.resolve', input, context))
      .toMatchObject({ ok: true, result: { options } });

    const period = { relative: '7days' } as const;
    const pageDraft = { period, timeZoneOffsetMinutes: 60 };
    for (const [draftInput, expectedOptions] of [[pageDraft, options], [{ period }, []]] as const) {
      const queryResult = await executor.execute('usage.query', { queries: [draftInput] }, context);
      expect(queryResult).toMatchObject({ ok: true, result: { results: [{ accounting: {
        scopeKeys: [{ dimension: 'project', keys: expectedOptions.map(option => option.value) }],
      } }] } });
      expect(await executor.execute('action.options.resolve', { ...input, draftInput }, context))
        .toMatchObject({ ok: true, result: { options: expectedOptions } });
    }

    const pagedInput = { ...input, draftInput: pageDraft, limit: 1 };
    const page = await executor.execute('action.options.resolve', pagedInput, context);
    expect(page).toMatchObject({ ok: true, result: { options: [options[0]], nextCursor: expect.any(String) } });
    if (!page.ok || !page.result || typeof page.result !== 'object' || !('nextCursor' in page.result)) {
      throw new Error('Expected a project continuation');
    }
    const last = await executor.execute('action.options.resolve', { ...pagedInput, cursor: page.result.nextCursor }, context);
    expect(last).toMatchObject({ ok: true, result: { options: [options[1]] } });
    if (!last.ok) throw new Error('Expected the final Project page');
    expect(last.result).not.toHaveProperty('nextCursor');
  });

  it('resolves Usage filter choices from admitted accounting instead of execution target identities', async () => {
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, breakdowns: {
      agent: [{ key: 'claude', label: 'Claude', ...accounting.totals }],
      machine: [{ key: 'machine-1', label: 'Laptop', ...accounting.totals }],
      project: [{ key: 'project-1', label: 'App', ...accounting.totals }],
      source: [{ key: 'native', label: 'Native', ...accounting.totals }],
    } });
    // The authenticated accounting transport is the boundary; option/key/admission logic is real.
    const requested: ReturnType<typeof normalizeUsageQuery>[] = [];
    const deps: Partial<ActionExecutorDeps> = { machinesList: async () => ({ items: [{ id: 'machine-1', label: 'Laptop' }, { id: 'unaccounted', label: 'Another machine' }] }),
      usageActions: { query: async request => {
        requested.push(...request.queries);
        return resolveUsagePageAggregation({ queries: request.queries,
          accounting: request.queries.map(query => ({ query, value, status: 'available' as const })) }, bundledUsageModelPriceCatalog);
      } } };
    // Call-through instrumentation only: production parsing and envelope logic remain real.
    const delivery = vi.spyOn(usageDelivery, 'projectUsageQueryDelivery');
    const measurement = vi.spyOn(strictJson, 'measureSerializedValidatedStrictPluginJsonUtf8Bytes');
    const parse = vi.spyOn(UsageQueryBatchResultSchema, 'parse');
    const safeParse = vi.spyOn(UsageQueryBatchResultSchema, 'safeParse');
    try {
      for (const [field, expected] of [['agents', { value: 'claude', label: 'Claude' }],
        ['machines', { value: 'machine-1', label: 'Laptop' }], ['projects', { value: 'project-1', label: 'App' }],
        ['sources', { value: 'native', label: 'Native' }]] as const) {
        expect(await resolveInputOptions({ deps: deps as ActionExecutorDeps, ctx: { surface: 'ui', serverId: 'home-1' }, actionId: null,
          optionsSourceId: `usage.filters.${field}`, input: {}, readFailure: () => null,
          resolveSessionId: () => null, reviewScope: () => undefined })).toEqual({ ok: true, result: [expected] });
      }
      expect(requested).toHaveLength(4);
      expect(new Set(requested.map(getUsageQueryKey)).size).toBe(1);
      expect(requested[0]).toMatchObject({ includeAccounting: true,
        includeContributions: false, includeComparison: false, includeQuotaHistory: false,
        includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
        includeSeries: false, includeInsights: false, includeActivity: false, includeLeaders: false,
        includeModelTimeline: false, includeMessageStats: false,
        breakdown: ['agent', 'machine', 'project', 'source'], topLimit: 20 });
      expect(delivery).not.toHaveBeenCalled();
      expect(measurement).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(safeParse).not.toHaveBeenCalled();
    } finally { delivery.mockRestore(); measurement.mockRestore(); parse.mockRestore(); safeParse.mockRestore(); }
  });
  it('publishes Coach evidence states through the same admitted query Action', async () => {
    const coachQuery = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async input => resolveUsagePageAggregation({ queries: input.queries,
        accounting: [{ query: coachQuery, value: accounting, status: 'available', asOfMs: 200 }] }, bundledUsageModelPriceCatalog),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('usage.query', { queries: [coachQuery] }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { results: [{ coach: {
        period: { startMs: 100, endMs: 200 },
        evaluations: expect.arrayContaining([
          expect.objectContaining({ detectorId: 'duplicated_instructions', status: 'insufficient_evidence' }),
          expect.objectContaining({ detectorId: 'cache_busting_prompt_changes', status: 'insufficient_evidence' }),
        ]),
      } }] } });
  });
  it('preserves exact-query accounting and witnessed Work through the Action result', async () => {
    const workQuery = normalizeUsageQuery({ session: 'session', period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ ...workQuery, agents: ['other'] });
    const contribution = { id: 'cost', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null, tokens: accounting.totals.tokens,
      cost: { reportedUsd: 0.02, estimatedUsd: 0, currency: 'USD' } };
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, contributions: [contribution] });
    const witness: UsageWorkEvidence = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo',
      checkpointRef: 'checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Work', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open',
      } };
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async input => resolveUsagePageAggregation({ queries: input.queries,
        accounting: [{ query: workQuery, value, status: 'available' }], work: [{ query: workQuery, status: 'partial', evidence: [witness] }] }, bundledUsageModelPriceCatalog),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('usage.query', { queries: [workQuery, other] }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { v: 1, results: expect.arrayContaining([
        expect.objectContaining({ requestedQuery: workQuery, accounting: expect.objectContaining({ contributions: [contribution] }),
          work: expect.objectContaining({ allocations: [expect.objectContaining({ contributionId: contribution.id,
          reason: 'allocated', outcome: expect.objectContaining({ repositoryKey: 'repo' }) })] }) }),
        expect.objectContaining({ requestedQuery: other }),
      ]) } });
  });
  it.each([
    { scenario: 'undated link', merge: {}, measured: false },
    { scenario: 'outside-period link', merge: { mergedAtMs: 99 }, measured: false },
    { scenario: 'in-period link', merge: { mergedAtMs: 150 }, measured: false },
    { scenario: 'read-empty', merge: null, measured: true },
    { scenario: 'failed refresh after a complete positive read', merge: { mergedAtMs: 150 }, measured: false, refreshFailed: true },
    { scenario: 'failed refresh after a complete empty read', merge: null, measured: false, refreshFailed: true },
  ])('uses the admitted Work read for exact merged counts: $scenario', async ({ merge, measured, refreshFailed }) => {
    const workQuery = normalizeUsageQuery({ ...query, period: { startMs: 100, endMs: 200 }, includeWorkEvidence: true });
    const contributions = ['read', 'sibling'].map(sessionId => ({
      id: sessionId, sessionId, turnId: 'turn', observedAtMs: 150, agentId: 'codex', modelId: null,
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime' as const,
      tokens: accounting.totals.tokens, cost: accounting.totals.cost,
    }));
    const evidence: UsageWorkEvidence[] = merge === null ? [] : [{
      sessionId: 'read', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Work', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature',
        state: 'merged', ...merge,
      },
    }];
    const accountingReads = [{ query: workQuery, status: 'available' as const, value: { ...accounting, contributions } }];
    const complete = measured || refreshFailed;
    const initial = resolveUsagePageAggregation({ queries: [workQuery], accounting: accountingReads,
      work: [{ query: workQuery, status: complete ? 'available' : 'partial', asOfMs: 200, evidence,
        pullRequestReadSessions: complete ? ['read', 'sibling'] : ['read'],
        ...(complete ? {} : { unreadSessions: { failed: 1 } }) }],
    }, bundledUsageModelPriceCatalog);
    if (refreshFailed) expect(initial.results[0]?.workSummary?.mergedPrCount).toBe(evidence.length);
    const batch = refreshFailed ? resolveUsagePageAggregation({ queries: [workQuery], accounting: accountingReads, previous: initial,
      work: [{ query: workQuery, status: 'error', errorCode: 'work_evidence_failed', unreadSessions: { failed: 2 } }],
    }, bundledUsageModelPriceCatalog) : initial;
    const slice = batch.results[0]!;
    const executor = createActionExecutor({ usageActions: { query: async () => batch } } as ActionExecutorDeps);
    const result = await executor.execute('usage.query', { queries: [workQuery] }, { surface: 'cli' });
    expect(result).toMatchObject({ ok: true, result: batch });
    if (refreshFailed) expect(slice.sources).toContainEqual({ source: 'work', status: 'stale', asOfMs: 200,
      errorCode: 'work_evidence_failed', unreadSessions: { failed: 2 } });
    expect(slice.work?.outcomes).toHaveLength(evidence.length);
    if (measured || evidence.length) expect(slice.mergedOutcomes?.outcomes).toHaveLength(evidence.length);
    else expect.soft(slice.mergedOutcomes).toBeUndefined();
    expect.soft(slice.workSummary?.pullRequestsRead).toBe(measured ? true : undefined);
    expect.soft(slice.mergedOutcomes?.mergedInPeriodCount).toBe(measured ? 0 : undefined);
    expect.soft(slice.workSummary?.mergedPrCount).toBe(measured ? 0 : undefined);
    expect.soft(slice.workSummary?.mergedSessionCount).toBe(measured ? 0 : undefined);
    if (!measured && slice.mergedOutcomes) {
      const forged = createActionExecutor({ usageActions: { query: async () => ({ ...batch, results: [
        { ...slice, mergedOutcomes: { ...slice.mergedOutcomes!, mergedInPeriodCount: merge?.mergedAtMs === 150 ? 1 : 0 } },
      ] }) } } as ActionExecutorDeps);
      expect(await forged.execute('usage.query', { queries: [workQuery] }, { surface: 'cli' }))
        .toMatchObject({ ok: false, errorCode: 'usage_query_result_invalid' });
    }
  });

  it('treats reversed batches as the same canonical set of independently resolved slices', async () => {
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async request => resolveUsagePageAggregation({ queries: request.queries }, bundledUsageModelPriceCatalog),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const pinned = { ...query, period: { startMs: 0, endMs: 100 } };
    const first = await executor.execute('usage.query', { queries: [query, pinned] }, { surface: 'cli' });
    const second = await executor.execute('usage.query', { queries: [pinned, query, query] }, { surface: 'cli' });
    expect(first).toEqual(second);
  });
  it('returns deduplicated complete identities and independent snapshot slices without awaiting pending sources', async () => {
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      // Authenticated read transport is the boundary; query/key/aggregation logic stays real.
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, status: 'available', value: accounting }], quota: { status: 'pending' } }, bundledUsageModelPriceCatalog),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const pinned = { ...query, period: { startMs: 0, endMs: 100 } };
    const result = await executor.execute('usage.query', { queries: [query, { ...query, agents: ['b', 'a', 'a'] }, pinned] }, { surface: 'cli' });
    expect(result).toMatchObject({ ok: true, result: { results: expect.arrayContaining([
      expect.objectContaining({ requestedQuery: query, shownQuery: query, accounting, pending: true }),
      expect.objectContaining({ requestedQuery: pinned, shownQuery: pinned, pending: true }),
    ]) } });
  });
  it('refuses incomplete or foreign slice sets instead of presenting unrequested accounting', async () => {
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async () => resolveUsagePageAggregation({ queries: [normalizeUsageQuery({ agents: ['foreign'] })],
        accounting: [{ query: normalizeUsageQuery({ agents: ['foreign'] }), status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('usage.query', { queries: [query] }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'usage_query_result_invalid' });
  });
  it('exports selected facts through the same authorized read and the single canonical byte serializer', async () => {
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async request => {
        expect(request.queries[0]).toMatchObject({ includeAccounting: true, includeContributions: false, includeComparison: false,
          includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
        return resolveUsagePageAggregation({ queries: request.queries,
          accounting: request.queries.map(query => ({ query, status: 'available' as const, value: accounting, asOfMs: 150 })) }, bundledUsageModelPriceCatalog);
      },
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const request = { query, format: 'json' as const, fields: ['totals' as const] };
    const result = await executor.execute('usage.export', request, { surface: 'cli' });
    expect(result).toMatchObject({ ok: true, result: { mediaType: 'application/json', fields: ['totals'], asOfMs: 150 } });
    if (result.ok && result.result && typeof result.result === 'object' && 'base64' in result.result) {
      const content = JSON.parse(new TextDecoder().decode(decodeBase64(String(result.result.base64))));
      expect(content.accounting).toEqual({ totals: accounting.totals });
      expect(content.query).toEqual(query);
    }
  });
  it('keeps typed read denial and late cancellation from disclosing file or accounting bytes', async () => {
    const controller = new AbortController();
    const deniedDeps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async () => ({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }),
    } };
    const denied = createActionExecutor(deniedDeps as ActionExecutorDeps);
    expect(await denied.execute('usage.export', { query, format: 'json', fields: ['totals'] }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    const retiredDeps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async request => { controller.abort(); return resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog); },
    } };
    const retired = createActionExecutor(retiredDeps as ActionExecutorDeps);
    expect(await retired.execute('usage.query', { queries: [query] }, { surface: 'cli', signal: controller.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
  it('returns the typed Accounting source refusal without export bytes when the Usage batch is valid', async () => {
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async ({ queries }) => resolveUsagePageAggregation({ queries,
        accounting: queries.map(query => ({ query, status: 'error', errorCode: 'credential_scope_denied' })),
      }, bundledUsageModelPriceCatalog),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('usage.export', { query, format: 'json', fields: ['totals'] }, { surface: 'cli' }))
      .toEqual({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
  });
  it('reports unknown accounting freshness without substituting the export clock', async () => {
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: request.queries.map(query => ({ query, status: 'available' as const, value: accounting })) }, bundledUsageModelPriceCatalog),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('usage.export', { query, format: 'json', fields: ['totals'] }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { asOfMs: null, fileName: 'usage.json' } });
  });
});
