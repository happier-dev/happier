import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '../actions/externalActionLimits.js';
import { UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { resolveUsagePageAggregation, resolveUsageComparisonQuery, UsageQueryBatchResultSchema } from './resolveUsagePageAggregation.js';
import { projectUsageQueryDelivery } from './projectUsageQueryDelivery.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';

describe('agent Usage coverage delivery', () => {
  it('delivers source status/kind counts through Usage Actions below the Pi tool budget, with CLI facts and Session recovery', async () => {
    // Reload 157: 288 coverage sources / 54,688 B, 142 Sessions / 2,077
    // contributions. Preserve that shape with synthetic content-free identities.
    const sources = Array.from({ length: 288 }, (_, index) => ({
      source: `runtime-source-${index}`.padEnd(23, 'x'),
      path: index < 286 ? 'runtime' as const : 'native' as const,
      status: index < 132 ? 'unknown' as const : index < 240 ? 'partial' as const : 'available' as const,
      machineId: `machine-${index}`.padEnd(36, 'x'), captureKind: index < 286 ? 'measured' as const : 'from_logs' as const,
      asOfMs: 1_799_999_999_999, eventCount: 1, historyComplete: false,
    }));
    const tokens = { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 };
    const contributions = Array.from({ length: 2_077 }, (_, index) => ({ id: `row-${index}`,
      observedAtMs: 150, sessionId: `session-${index % 142}`, turnId: `turn-${index}`, agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens,
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
    }));
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
      totals: { eventCount: contributions.length, tokens: { ...tokens, input: 10 * contributions.length,
        output: 2 * contributions.length, total: 12 * contributions.length },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions,
      coverage: { status: 'partial', reasons: ['missing_baseline', 'incomplete_history'], sources,
        missingDimensions: [], range: { startMs: 100, endMs: 200, complete: false }, ranked: [] },
    });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const comparison = resolveUsageComparisonQuery(query)!;
    const rich = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: accounting, status: 'available' },
        { query: comparison, value: { ...accounting, coverage: { ...accounting.coverage!,
          range: { startMs: 0, endMs: 100, complete: false } } }, status: 'available' }],
      work: [{ query, evidence: [], status: 'available' }],
    });
    // Substitute only the authenticated query transport. Action validation,
    // surface selection, aggregation and delivery all run their real owners.
    const invoke = async (batch: typeof rich, surface: 'cli' | 'agent' | 'mcp') => {
      // Other Action families are unreachable; this fixture supplies only the
      // authenticated Usage transport required by the production dispatcher.
      const executor = createActionExecutor({ usageActions: { query: async () => batch } } as ActionExecutorDeps);
      const result = await executor.execute('usage.query', {
        queries: batch.results.map(slice => slice.requestedQuery),
      }, { surface });
      if (!result.ok) throw new Error(`Usage Action refused: ${result.errorCode}`);
      return UsageQueryBatchResultSchema.parse(result.result);
    };
    const cli = await invoke(rich, 'cli');
    expect(cli.results[0]?.accounting?.coverage?.sources).toHaveLength(288);
    // Existing Pi TOOL_OUTPUT_MAX_BYTES, extensionSource.ts:18. No Usage cap.
    const toolBudget = 50 * 1024;
    const cliBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(cli);
    expect(cliBytes).toBeGreaterThan(toolBudget);
    for (const surface of ['agent', 'mcp'] as const) {
      const delivery = await invoke(rich, surface);
      const deliveredBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(delivery);
      expect(deliveredBytes).toBeLessThan(toolBudget);
      const slice = UsageQueryBatchResultSchema.parse(delivery).results[0]!;
      expect(slice.accounting?.totals).toEqual(accounting.totals);
      expect(slice.workSummary).toMatchObject({ sessionCount: 142, contributionCount: 2_077 });
      expect(slice.accounting?.coverage).toMatchObject({ sources: [], reasons: accounting.coverage!.reasons,
        sourceSummary: { sourceCount: 288, groups: [
          { path: 'runtime', captureKind: 'measured', status: 'unknown', sourceCount: 132, eventCount: 132 },
          { path: 'runtime', captureKind: 'measured', status: 'partial', sourceCount: 108, eventCount: 108 },
          { path: 'runtime', captureKind: 'measured', status: 'available', sourceCount: 46, eventCount: 46 },
          { path: 'native', captureKind: 'from_logs', status: 'available', sourceCount: 2, eventCount: 2 },
        ] } });
      expect(slice.comparison?.accounting?.totals).toEqual(accounting.totals);
      expect(slice.comparison?.accounting?.coverage).toMatchObject({ sources: [],
        sourceSummary: slice.accounting!.coverage!.sourceSummary, reasons: accounting.coverage!.reasons });
      expect(projectUsageQueryDelivery(delivery, surface)).toEqual(delivery);
    }
    const selected = normalizeUsageQuery({ ...query, session: 'session-0' });
    const detail = resolveUsagePageAggregation({ queries: [selected],
      accounting: [{ query: selected, value: { ...accounting,
        coverage: { ...accounting.coverage!, sources: sources.slice(0, 1) },
        contributions: contributions.filter(row => row.sessionId === 'session-0') }, status: 'available' }],
      work: [{ query: selected, evidence: [], status: 'available' }],
    });
    for (const surface of ['agent', 'mcp'] as const) {
      const recovered = (await invoke(detail, surface)).results[0]!;
      expect(recovered.accounting?.coverage?.sources).toEqual(sources.slice(0, 1));
      expect(recovered.work?.allocations.length).toBeGreaterThan(0);
    }
    expect(rich.results[0]?.accounting?.coverage?.sources).toHaveLength(288);
  });
});
