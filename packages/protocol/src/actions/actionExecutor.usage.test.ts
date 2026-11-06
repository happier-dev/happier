import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getUsageQueryKey, normalizeUsageQuery } from '../inputs/usageQuery.js';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema } from '../usage/resolveUsagePageAggregation.js';
import { enforceExternalActionResponseEnvelopeLimitV1 } from './externalActionApi.js';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from './externalActionLimits.js';
import { UsageAnalyticsQueryResponseSchema } from '../usage/usageAnalyticsContracts.js';
import { decodeBase64 } from '../crypto/base64.js';
import type { UsageWorkEvidence } from '../usage/usageOutcomeAllocation.js';
import { resolveInputOptions } from '../inputs/inputOptions.js';
import { bundledUsageModelPriceCatalog } from '../usage/usageModelPriceCatalog.js';
import * as usageDelivery from '../usage/projectUsageQueryDelivery.js';

const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } });
const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: ['a', 'b'] });

// Check the supplied authenticated transport ports before adapting this fixture
// to the cross-family executor; unrelated family ports are unreachable here.
describe('personal usage Action execution', () => {
  it('keeps exact accounting and small siblings when requested Work evidence exceeds the response envelope', async () => {
    const heavy = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 },
      includeQuotaHistory: true, includeSessionEvidence: true, includeTranscriptEvidence: true, includeWorkEvidence: true });
    const small = normalizeUsageQuery({ ...heavy, session: 'session-0' });
    // The performance lane's Account-scale shape: 1k Sessions linked to one PR.
    // Repeating the shared outcome's contribution identities in every allocation
    // exceeds the real envelope without oversized strings or a lowered test cap.
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
    });
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(rich)).toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    let reads = 0;
    let admitted = rich;
    const deps: Partial<ActionExecutorDeps> = { usageActions: { query: async () => { reads += 1; return admitted; } } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const result = await executor.execute('usage.query', { queries: [heavy, small, heavy] }, { surface: 'cli' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected useful admitted Usage facts');
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(result.result)).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    expect(enforceExternalActionResponseEnvelopeLimitV1({ v: 1, actionId: 'usage.query', requestId: 'evidence-heavy', execution: result }))
      .toMatchObject({ execution: { ok: true } });
    const batch = UsageQueryBatchResultSchema.parse(result.result);
    const bounded = batch.results.find(slice => slice.key === getUsageQueryKey(heavy))!;
    expect(bounded).toMatchObject({ requestedQuery: heavy, shownQuery: heavy, accounting: { totals: accounting.totals },
      incomplete: { reason: 'response_size_limit', omittedSections: ['work'], recovery: 'narrow_query' } });
    expect(bounded.work).toBeUndefined();
    expect(bounded.accounting?.contributions).toBeUndefined();
    expect(bounded.coach).toEqual(rich.results.find(slice => slice.key === bounded.key)?.coach);
    const narrow = batch.results.find(slice => slice.key !== bounded.key)!;
    expect(narrow.work?.allocations).toHaveLength(1);
    expect(narrow).not.toHaveProperty('incomplete');
    expect(UsageQueryBatchResultSchema.safeParse({ ...batch, results: [{ ...narrow, incomplete: bounded.incomplete }] }).success).toBe(false);
    expect(reads).toBe(1);
    expect(rich.results.find(slice => slice.key === bounded.key)?.work?.allocations).toHaveLength(1_000);
    // A caller-driven narrower read near the actual budget retains every row;
    // an arbitrary Session/row cap would incorrectly truncate this control.
    const selected = contributions.slice(0, 698); // Measured near-envelope valid fixture; 700 occupies 24,066,346 bytes.
    const near = normalizeUsageQuery({ ...heavy, session: selected.map(row => row.sessionId) });
    admitted = resolveUsagePageAggregation({ queries: [near], accounting: [{ query: near, status: 'available',
      value: { ...accounting, contributions: selected } }], work: [{ query: near, status: 'available', evidence }] });
    const nearBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(admitted);
    expect(nearBytes).toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES * 0.9);
    expect(nearBytes).toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const recovered = await executor.execute('usage.query', { queries: [near] }, { surface: 'cli' });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('Expected caller-selected evidence');
    const recoveredSlice = UsageQueryBatchResultSchema.parse(recovered.result).results[0]!;
    expect(recoveredSlice.work?.allocations).toHaveLength(selected.length);
    expect(recoveredSlice).not.toHaveProperty('incomplete');
    expect(reads).toBe(2);
    console.info('[PERF usage delivery]', JSON.stringify({ section: 'work',
      richBytes: measureExternalActionResultResponseEnvelopeUtf8BytesV1(rich),
      deliveredBytes: measureExternalActionResultResponseEnvelopeUtf8BytesV1(result.result), nearBytes, nearRows: selected.length }));
  }, 0); // Real envelope-scale byte contract, not a five-second throughput gate.
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
    });
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
    });
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
        accounting: input.queries.map(query => ({ query, value, status: 'available' as const })) });
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

  it('resolves Usage filter choices from admitted accounting instead of execution target identities', async () => {
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, breakdowns: {
      agent: [{ key: 'claude', label: 'Claude', ...accounting.totals }],
      machine: [{ key: 'machine-1', label: 'Laptop', ...accounting.totals }],
      project: [{ key: 'project-1', label: 'App', ...accounting.totals }],
      source: [{ key: 'native', label: 'Native', ...accounting.totals }],
    } });
    // The authenticated accounting transport is the boundary; option/key/admission logic is real.
    const deps: Partial<ActionExecutorDeps> = { machinesList: async () => ({ items: [{ id: 'machine-1', label: 'Laptop' }, { id: 'unaccounted', label: 'Another machine' }] }),
      usageActions: { query: async (request: { queries: ReturnType<typeof normalizeUsageQuery>[] }) =>
      resolveUsagePageAggregation({ queries: request.queries, accounting: request.queries.map(query => ({ query, value, status: 'available' as const })) }) } };
    for (const [field, expected] of [['agents', { value: 'claude', label: 'Claude' }],
      ['machines', { value: 'machine-1', label: 'Laptop' }], ['projects', { value: 'project-1', label: 'App' }],
      ['sources', { value: 'native', label: 'Native' }]] as const) {
      expect(await resolveInputOptions({ deps: deps as ActionExecutorDeps, ctx: { surface: 'ui', serverId: 'home-1' }, actionId: null,
        optionsSourceId: `usage.filters.${field}`, input: {}, readFailure: () => null,
        resolveSessionId: () => null, reviewScope: () => undefined })).toEqual({ ok: true, result: [expected] });
    }
  });
  it('publishes Coach evidence states through the same admitted query Action', async () => {
    const coachQuery = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async input => resolveUsagePageAggregation({ queries: input.queries,
        accounting: [{ query: coachQuery, value: accounting, status: 'available', asOfMs: 200 }] }),
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
        accounting: [{ query: workQuery, value, status: 'available' }], work: [{ query: workQuery, status: 'partial', evidence: [witness] }] }),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('usage.query', { queries: [workQuery, other] }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { v: 1, results: expect.arrayContaining([
        expect.objectContaining({ requestedQuery: workQuery, work: expect.objectContaining({ allocations: [expect.objectContaining({ contribution,
          reason: 'allocated', outcome: expect.objectContaining({ repositoryKey: 'repo' }) })] }) }),
        expect.objectContaining({ requestedQuery: other }),
      ]) } });
  });
  it('treats reversed batches as the same canonical set of independently resolved slices', async () => {
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async request => resolveUsagePageAggregation({ queries: request.queries }),
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
        accounting: [{ query, status: 'available', value: accounting }], quota: { status: 'pending' } }),
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
        accounting: [{ query: normalizeUsageQuery({ agents: ['foreign'] }), status: 'available', value: accounting }] }),
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
          accounting: request.queries.map(query => ({ query, status: 'available' as const, value: accounting, asOfMs: 150 })) });
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
        accounting: [{ query, status: 'available', value: accounting }] }); },
    } };
    const retired = createActionExecutor(retiredDeps as ActionExecutorDeps);
    expect(await retired.execute('usage.query', { queries: [query] }, { surface: 'cli', signal: controller.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
  it('reports unknown accounting freshness without substituting the export clock', async () => {
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: request.queries.map(query => ({ query, status: 'available' as const, value: accounting })) }),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('usage.export', { query, format: 'json', fields: ['totals'] }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { asOfMs: null, fileName: 'usage.json' } });
  });
});
