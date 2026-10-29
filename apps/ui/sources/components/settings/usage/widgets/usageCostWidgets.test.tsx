import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { HappierDataMetric, HappierDataRows, RankedRows, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsageComparisonQuery, resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectUsagePageCost, resolveUsageCostForSelection, repriceUsageAnalyticsResponse, type UsageAnalyticsContribution } from '@happier-dev/protocol';
import { allocateUsageOutcomes } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { summarizeUsageWork } from './usageWorkPresentation';
import { usagePageCostTrend } from '../usageCostPresentation';
import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { UsagePeriodSummaryWidget } from './UsagePeriodSummaryWidget';
import { UsageFootprintWidget } from './UsageFootprintWidget';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { UsageCostFactsWidget } from './UsageCostFactsWidget';
import { UsageSourceCoverageWidget, UsageUnpricedWidget } from './UsageSourcePanels';
import { UsageDailyWidget } from './UsageDailyWidget';
import { UsageFlowWidget } from './UsageFlowWidget';
import { UsageBreakdownsWidget } from './UsageBreakdownsWidget';
import { leadingUsageRows, UsageShowAllRows, usagePartialHistoryLabel } from './usageBodyKit';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { UsageEfficiencyWidget } from './UsageEfficiencyWidget';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';

const day = 86_400_000;
const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
function mountedCosts(unpriced = false) {
  const query = normalizeUsageQuery({ period: { startMs: 0, endMs: day }, metric: 'cost', costBasis: 'auto', breakdown: ['agent'] });
  const contributions: UsageAnalyticsContribution[] = [
    { id: 'a', sessionId: 's', turnId: 'a', observedAtMs: 1, eventCount: 1, agentId: 'claude', modelId: 'unknown-a',
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' }, tokens,
      cost: { reportedUsd: 1, estimatedUsd: 0.5, invoiceUsd: 0.2, currency: 'USD' } },
    { id: 'b', sessionId: 's', turnId: 'b', observedAtMs: 2, eventCount: 1, agentId: 'claude', modelId: 'unknown-b',
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' }, tokens,
      cost: unpriced ? { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' }
        : { reportedUsd: 2, estimatedUsd: 0.7, currency: 'USD' } },
  ];
  const cost = { reportedUsd: unpriced ? 1 : 3, estimatedUsd: unpriced ? 0.5 : 1.2, invoiceUsd: 0.2, currency: 'USD', costSource: 'none' as const };
  const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: repriceUsageAnalyticsResponse({
    v: 1, totals: { eventCount: 2, tokens: { ...tokens, input: 20, total: 20 }, cost }, contributions,
    series: [{ bucketStartMs: 0, bucketEndMs: day, eventCount: 2, tokens: { ...tokens, input: 20, total: 20 }, cost }],
    breakdowns: { agent: [{ key: 'claude', eventCount: 2, tokens: { ...tokens, input: 20, total: 20 }, cost }] },
    engineTimeline: [{ bucketStartMs: 0, bucketEndMs: day, leaders: [{ key: 'claude', eventCount: 2,
      tokens: { ...tokens, input: 20, total: 20 }, cost }] }],
  }) }] }).results[0]!;
  const identity = { query, authority: { serverId: 'home', accountId: 'usage-account' } };
  const model: UsageWidgetBodyModel = { requestedQuery: identity, shownQuery: identity, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
  return { query, slice, model, serverId: 'home' };
}

describe('one selected money basis across Usage bodies', () => {
  it('keeps the private footprint as an accounted-token proxy with no fabricated estimate', async () => {
    const props = mountedCosts();
    const slice = resolveUsagePageAggregation({ queries: [props.query],
      accounting: [{ query: props.query, status: 'available', value: props.slice.accounting! }],
      howYouWork: [{ query: props.query, asOfMs: day, detail: { status: 'available', facts: [] } }],
    }).results[0]!;
    const screen = await renderScreen(<UsageFootprintWidget {...props} slice={slice} id="usage_footprint" testID="footprint" />);
    const metric = screen.findAllByType(HappierDataMetric).find(row => row.props.testID === 'footprint.tokens');
    expect(metric?.props.value).toBe(formatTokenCount(slice.accounting!.totals.tokens.total));
    expect(metric?.props.comparison.value).toBe(t('usage.board.howYouWork.footprintProxy'));
    expect(screen.getTextContent()).toContain(t('usage.board.howYouWork.footprintNoEstimate'));
  });
  it('does not reaggregate unchanged comparison contributions on a source-progress render', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, period: { startMs: day, endMs: 2 * day } });
    // The page reads the canonical preceding-range query (totals only, no charts or insights).
    const priorQuery = resolveUsageComparisonQuery(query)!;
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: props.slice.accounting! },
      { query: priorQuery, status: 'available', value: props.slice.accounting! },
    ] }).results[0]!;
    let reads = 0;
    const previous = { ...slice.comparison!.accounting!, contributions: slice.comparison!.accounting!.contributions!.map(row =>
      new Proxy(row, { get(target, key, receiver) {
        if (key === 'cost') reads++;
        return Reflect.get(target, key, receiver);
      } })) };
    const withComparison = { ...slice, comparison: { ...slice.comparison!, accounting: previous } };
    const bodies = (current: typeof withComparison, includeEfficiency = true) => <>
      <UsagePeriodSummaryWidget {...props} query={query} slice={current} id="usage_period_summary" testID="comparison-summary" />
      {includeEfficiency ? <UsageEfficiencyWidget {...props} query={query} slice={current} id="usage_efficiency" testID="comparison-efficiency" /> : null}
    </>;
    const screen = await renderScreen(bodies(withComparison, false));
    expect(reads).toBeGreaterThan(0);
    const metrics = () => screen.findAllByType(HappierDataMetric).filter(metric => metric.props.testID === 'comparison-summary.hero'
      || metric.props.testID === 'comparison-efficiency.perMtok');
    expect(metrics().map(metric => metric.props.comparison?.value)).toEqual(['▲ 0%']);
    reads = 0;
    await screen.update(bodies(withComparison));
    expect(reads).toBe(0);
    expect(metrics().map(metric => metric.props.comparison?.value)).toEqual(['▲ 0%', '▲ 0%']);
    reads = 0;
    await screen.update(bodies({ ...withComparison, pending: true }));
    expect(reads).toBe(0);
    expect(metrics().map(metric => metric.props.comparison?.value)).toEqual(['▲ 0%', '▲ 0%']);
    const changedPrevious = { ...previous, contributions: previous.contributions.map(row => ({ ...row,
      cost: { ...row.cost, reportedUsd: row.cost.reportedUsd * 2 } })) };
    await screen.update(bodies({ ...withComparison, comparison: { ...withComparison.comparison, accounting: changedPrevious } }));
    expect(metrics().map(metric => metric.props.comparison?.value)).toEqual(['▼ 50%', '▼ 50%']);
  });
  it('keeps unrequested calendar evidence unavailable in the period summary', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, metric: 'tokens', includeSessionEvidence: false, includeWorkEvidence: false });
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query}
      id="usage_period_summary" testID="summary" />);
    const metric = screen.findAllByType(HappierDataMetric)
      .find(value => value.props.label === t('usage.board.page.activeDays'));
    expect(metric?.props.value).toBe('—');
    expect(metric?.props.caption).toBeUndefined();
  });

  it('renders unpriced tokens from the canonical cost facts, never as money or a fabricated model estimate', async () => {
    const props = mountedCosts(true);
    const expected = props.slice.costFactTotals!.filter(fact => fact.kind === 'unpriced').reduce((sum, fact) => sum + fact.tokens.total, 0);
    expect(expected).toBeGreaterThan(0);
    const screen = await renderScreen(<UsageUnpricedWidget {...props} id="usage_unpriced" testID="unpriced" />);
    const metric = screen.findAllByType(HappierDataMetric).find(row => row.props.testID === 'unpriced.tokens');
    expect(metric?.props.value).toBe(expected);
    expect(metric?.props.unit).toBe(t('usage.board.page.tokensUnit'));
    expect(metric?.props.valueFormatter(expected)).not.toContain('$');
    expect(screen.findByTestId('unpriced.prices.open')).not.toBeNull();
  });
  it('keeps pending and failed accounting distinct from zero unpriced tokens', async () => {
    const props = mountedCosts();
    for (const status of ['pending', 'error'] as const) {
      const slice = resolveUsagePageAggregation({ queries: [props.query], accounting: [{ query: props.query, status }] }).results[0]!;
      const screen = await renderScreen(<UsageUnpricedWidget {...props} slice={slice} id="usage_unpriced" testID="unpriced" />);
      expect(screen.findAllByType(HappierDataMetric)).toHaveLength(0);
      expect(screen.findByTestId(status === 'pending' ? 'unpriced.loading' : 'unpriced.unavailable')).not.toBeNull();
    }
  });
  it('distinguishes an absent unpriced projection from a witnessed empty population', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<UsageUnpricedWidget {...props} slice={{ ...props.slice, costFactTotals: undefined }} id="usage_unpriced" testID="unpriced" />);
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'unpriced.tokens')?.props.value).toBe('—');
    await screen.update(<UsageUnpricedWidget {...props} slice={{ ...props.slice, costFactTotals: [] }} id="usage_unpriced" testID="unpriced" />);
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'unpriced.tokens')?.props.value).toBe(0);
  });
  it('renders witnessed source coverage and the canonical incomplete-range reasons instead of claiming a complete inventory', async () => {
    const props = mountedCosts();
    const accounting = { ...props.slice.accounting!, coverage: { status: 'partial' as const, reasons: ['missing_baseline' as const],
      missingDimensions: [], range: { startMs: 0, endMs: day, complete: false }, ranked: [],
      sources: [{ source: 'codex-token-count', path: 'native' as const, status: 'partial' as const,
        eventCount: 2, captureKind: 'from_logs' as const, historyComplete: false, asOfMs: 100 }] } };
    const slice = resolveUsagePageAggregation({ queries: [props.query], accounting: [{ query: props.query, status: 'available', value: accounting }] }).results[0]!;
    const screen = await renderScreen(<UsageSourceCoverageWidget {...props} slice={slice} id="usage_source_coverage" testID="coverage" />);
    expect(screen.findByType(HappierDataRows).props.rows).toHaveLength(1);
    expect(screen.getTextContent()).toContain(t('usage.board.page.coverageReason_missing_baseline'));
    expect(screen.getTextContent()).toContain(t('usage.board.page.sourceKindFromLogs'));
  });
  it('lists source coverage as a short led list: identical captures across machines say so once with a count, distinct ones fold behind Show all', async () => {
    const props = mountedCosts();
    const source = { path: 'native' as const, status: 'unknown' as const, eventCount: 0, captureKind: 'measured' as const, asOfMs: 100 };
    const coverageOf = (sources: readonly (typeof source & { source: string })[]) => resolveUsagePageAggregation({ queries: [props.query],
      accounting: [{ query: props.query, status: 'available', value: { ...props.slice.accounting!, coverage: { status: 'partial' as const,
        reasons: [], missingDimensions: [], range: { startMs: 0, endMs: day, complete: false }, ranked: [], sources: [...sources] } } }] }).results[0]!;
    const twins = await renderScreen(<UsageSourceCoverageWidget {...props} id="usage_source_coverage" testID="coverage"
      slice={coverageOf([...Array.from({ length: 30 }, () => ({ ...source, source: 'claude-assistant-usage' })), { ...source, source: 'codex-token-count' }])} />);
    expect(twins.findByType(HappierDataRows).props.rows).toHaveLength(2);
    expect(twins.getTextContent()).toContain('30');
    const distinct = await renderScreen(<UsageSourceCoverageWidget {...props} id="usage_source_coverage" testID="coverage"
      slice={coverageOf(Array.from({ length: 10 }, (_, index) => ({ ...source, source: `source-${index}` })))} />);
    expect(distinct.findByType(HappierDataRows).props.rows.length).toBeLessThan(10);
    await distinct.pressByTestIdAsync('coverage.showAll.toggle');
    expect(distinct.findByType(HappierDataRows).props.rows).toHaveLength(10);
  });
  it.each([7, 30].flatMap(days => (['auto', 'reported', 'estimated', 'api_equivalent'] as const)
    .map(costBasis => ({ days, costBasis, olderUnpriced: false }))).concat([
      { days: 30, costBasis: 'auto', olderUnpriced: true },
    ]))('shares selected $costBasis money across every body at $days days (older unpriced: $olderUnpriced)', async ({ days, costBasis, olderUnpriced }) => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, period: { startMs: 0, endMs: days * day }, costBasis });
    const base = props.slice.accounting!.contributions![0]!;
    const contributions: UsageAnalyticsContribution[] = [
      { ...base, id: 'covered', source: 'runtime', observedAtMs: day + 1,
        cost: { reportedUsd: 0, estimatedUsd: 2, currency: 'USD', costSource: 'pricing_estimate', reportedTotalId: 'final' } },
      { ...base, id: 'final', source: 'final', observedAtMs: day + 2,
        tokens: { ...tokens, input: 0, total: 0 },
        cost: { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported', reportedTotalContributionIds: ['covered'] } },
      { ...base, id: 'estimated', sessionId: 'other', source: 'native', observedAtMs: day + 3,
        cost: { reportedUsd: 0, estimatedUsd: 4, currency: 'USD', costSource: 'pricing_estimate' } },
    ];
    if (olderUnpriced) contributions.push({ ...base, id: 'older-unpriced', observedAtMs: 1, modelId: null,
      source: 'claude-assistant-usage',
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } });
    const known = { eventCount: 3, tokens: { ...tokens, input: 20, total: 20 },
      cost: { reportedUsd: 7, estimatedUsd: 6, currency: 'USD', costSource: 'none' as const } };
    const older = { eventCount: 1, tokens, cost: contributions.at(-1)!.cost };
    const total = { ...known, eventCount: contributions.length,
      tokens: { ...tokens, input: olderUnpriced ? 30 : 20, total: olderUnpriced ? 30 : 20 } };
    const accounting = repriceUsageAnalyticsResponse({ v: 1, totals: total, contributions,
      series: [{ ...known, bucketStartMs: day, bucketEndMs: 2 * day },
        ...(olderUnpriced ? [{ ...older, bucketStartMs: 0, bucketEndMs: day }] : [])],
      breakdowns: { agent: [{ key: 'claude', ...total }] },
      engineTimeline: [{ bucketStartMs: day, bucketEndMs: 2 * day, leaders: [{ key: 'claude', ...known }] },
        ...(olderUnpriced ? [{ bucketStartMs: 0, bucketEndMs: day, leaders: [{ key: 'claude', ...older }] }] : [])],
    }, undefined, {}, costBasis);
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
    const screen = await renderScreen(<>
      <UsageDailyWidget {...props} query={query} slice={slice} id="usage_daily" testID="whole-daily" />
      <UsageBreakdownsWidget {...props} query={query} slice={slice} id="usage_breakdowns" testID="whole-breakdown" />
      <UsageCostFactsWidget {...props} query={query} slice={slice} id="usage_cost_facts" testID="whole-facts" />
      <UsagePeriodSummaryWidget {...props} query={query} slice={slice} id="usage_period_summary" testID="whole-summary" />
      <UsageEfficiencyWidget {...props} query={query} slice={slice} id="usage_efficiency" testID="whole-efficiency" />
    </>);
    const metrics = screen.findAllByType(HappierDataMetric);
    const selected = olderUnpriced ? null : costBasis === 'auto' ? 11 : costBasis === 'estimated' ? 6 : null;
    expect(projectUsagePageCost(slice.accounting!, costBasis).amountUsd).toBe(selected);
    expect(metrics.find(metric => metric.props.testID === 'whole-summary.hero')?.props.value).toBe(selected ?? '—');
    expect(metrics.find(metric => metric.props.testID === 'whole-efficiency.perMtok')?.props.value).toBe(selected === null ? '—' : selected / 20 * 1e6);
    expect(metrics.find(metric => metric.props.testID === 'whole-facts.fact.reported')?.props.value).toBe(7);
    expect(metrics.find(metric => metric.props.testID === 'whole-facts.fact.estimated')?.props.value).toBe(6);
    expect(screen.findByType(RankedRows).props.rows[0].value).toBe(selected);
    const chart = screen.findByType(StackedSeriesChart);
    const points: { y: number | null }[] = chart.props.series.flatMap((entry: { points: { y: number | null }[] }) => entry.points);
    expect(points.reduce((sum, point) => sum + (point.y ?? 0), 0)).toBe(olderUnpriced ? 11 : selected ?? 0);
    if (selected === null && !olderUnpriced) expect(points.every(point => point.y === null)).toBe(true);
    if (olderUnpriced) {
      expect(points.some(point => point.y === null)).toBe(true);
      expect(slice.costFactTotals?.find(fact => fact.kind === 'unpriced')?.tokens.total).toBe(30);
      // An unavailable whole-period amount says why, never the candidate basis's "estimated where not reported".
      const unpriced = 'Some usage has no reported cost or price';
      expect(metrics.find(metric => metric.props.testID === 'whole-summary.hero')?.props.caption).toBe(unpriced);
      expect(metrics.find(metric => metric.props.testID === 'whole-efficiency.perMtok')?.props.caption).toBe(unpriced);
    }
  });
  it('draws a Breakdowns heading per dimension only while the card ranks several, since one dimension is the card\'s own title', async () => {
    const mounted = mountedCosts();
    const claude = mounted.slice.accounting!.breakdowns!.agent![0]!;
    const accounting = { ...mounted.slice.accounting!, breakdowns: { agent: [claude], model: [{ ...claude, key: 'opus' }] } };
    const headings = async (breakdown: readonly ('agent' | 'model')[]) => {
      const q = normalizeUsageQuery({ ...mounted.query, breakdown: [...breakdown] });
      const slice = resolveUsagePageAggregation({ queries: [q], accounting: [{ query: q, status: 'available', value: accounting }] }).results[0]!;
      const screen = await renderScreen(<UsageBreakdownsWidget {...mounted} query={q} slice={slice} id="usage_breakdowns" testID="heads" />);
      return screen.findAll(node => node.props.accessibilityRole === 'header').length;
    };
    expect(await headings(['model'])).toBe(0);
    expect(await headings(['agent', 'model'])).toBeGreaterThan(0);
  });
  it.each([0, 100, 20_000])('compares Period totals honestly against a prior base of %s', async previousTokens => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, period: { startMs: day, endMs: 2 * day }, metric: 'tokens' });
    const accounting = { ...props.slice.accounting!, totals: { ...props.slice.accounting!.totals,
      tokens: { ...tokens, total: 22_804, input: 22_804 } } };
    // The page reads the canonical preceding-range query (totals only, no charts or insights).
    const priorQuery = resolveUsageComparisonQuery(query)!;
    const previous = { ...accounting, totals: { ...accounting.totals,
      tokens: { ...tokens, total: previousTokens, input: previousTokens } } };
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: accounting }, { query: priorQuery, status: 'available', value: previous },
    ] }).results[0]!;
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query} slice={slice}
      id="usage_period_summary" testID="summary" />);
    const comparison = screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'summary.hero')?.props.comparison;
    if (previousTokens === 0) expect(comparison).toBeUndefined();
    else expect(comparison).toMatchObject({ value: previousTokens === 100 ? '▲ 228×' : '▲ 14%' });
  });
  it('keeps the Agent time slot stable and publishes only complete interval figures', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, includeSessionEvidence: true });
    const accounting = [{ query, status: 'available' as const, value: props.slice.accounting! }];
    const cold = resolveUsagePageAggregation({ queries: [query], accounting });
    const facts = [{ workId: 'work', evidenceId: 'turn', agentId: null, machineId: null,
      kind: 'busy' as const, startMs: 0, endMs: 3_600_000 }];
    const partial = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'partial', facts: facts.map(fact => ({ ...fact, endMs: null })) } }] });
    const complete = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'available', facts } }] });
    // Transcript coverage can be partial while every admitted busy interval is
    // closed. Completeness of this duration belongs to the interval facet.
    const completeIntervals = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'partial', facts } }] });
    const pending = resolveUsagePageAggregation({ queries: [query], accounting, previous: complete,
      sources: [{ source: 'how_you_work', status: 'pending' }] });
    const refused = resolveUsagePageAggregation({ queries: [query], accounting, previous: complete,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'unknown' } }] });
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query}
      slice={cold.results[0]!} id="usage_period_summary" testID="summary" />);
    const statLabels = () => screen.findAllByType(HappierDataMetric)
      .filter(metric => metric.props.size === 'stat').map(metric => metric.props.label);
    const expectedLabels = [t('usage.cost'), t('usage.board.page.mergedPrs'), t('usage.board.page.agentTime')];
    for (const [batch, expected] of [[cold, '—'], [partial, '—'], [complete, 1], [completeIntervals, 1], [pending, 1], [partial, '—'], [refused, '—']] as const) {
      await screen.update(<UsagePeriodSummaryWidget {...props} query={query}
        slice={batch.results[0]!} id="usage_period_summary" testID="summary" />);
      expect(statLabels()).toEqual(expectedLabels);
      expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.label === t('usage.board.page.agentTime'))?.props.value)
        .toBe(expected);
      // A dash carries its quiet reason in the caption slot, so the three cells stay even.
      const stat = (label: string) => screen.findAllByType(HappierDataMetric).find(metric => metric.props.label === label)!;
      expect(stat(t('usage.board.page.agentTime')).props.caption === t('usage.board.page.notMeasuredYet')).toBe(expected === '—');
      expect(stat(t('usage.board.page.mergedPrs')).props.caption).toEqual(expect.any(String));
    }
  });
  it('uses reported then priced money per real QA row across Daily, Flow, Breakdowns, Leaders, Efficiency and Work', async () => {
    const query = normalizeUsageQuery({ metric: 'cost', breakdown: ['agent'], timeZoneOffsetMinutes: 120 });
    const captured = usageQaAccountingFixture();
    const candidates = [...new Set(captured.contributions!.map(row => row.agentId ?? 'unknown'))]
      .map(key => ({ key, eventCount: 1, tokens, cost: captured.totals.cost }));
    const accounting = repriceUsageAnalyticsResponse({ ...captured,
      breakdowns: { ...captured.breakdowns, agent: candidates }, leaders: { ...captured.leaders, agents: candidates },
    });
    const rows = accounting.contributions!;
    const claudeCost = rows.filter(row => row.agentId === 'claude')
      .reduce((sum, row) => sum + (row.cost.apiEquivalentUsd ?? row.cost.estimatedUsd), 0);
    const reportedCost = captured.totals.cost.reportedUsd;
    const total = claudeCost + reportedCost;
    const page = projectUsagePageCost(accounting, 'auto');
    expect(page.amountUsd).toBeCloseTo(total);
    expect(page.selection).toMatchObject({ kind: 'mixed', currency: 'USD' });
    expect(usagePageCostTrend(page).reduce((sum, point) => sum + (point.cost ?? 0), 0)).toBeCloseTo(total);
    const expectedRowCost = (agentId: string) => rows.filter(row => (row.agentId ?? 'unknown') === agentId)
      .reduce((sum, row) => sum + (row.cost.reportedUsd || row.cost.apiEquivalentUsd || row.cost.estimatedUsd), 0);
    for (const entries of [page.accounting.breakdowns!.agent!, page.accounting.leaders!.agents!]) {
      for (const row of entries) expect(resolveUsageCostForSelection(row.cost!, page.selection)).toBeCloseTo(expectedRowCost(row.key));
    }
    expect(resolveUsageCostForSelection(page.accounting.breakdowns!.model!.find(row => row.key === 'unknown')!.cost, page.selection)).toBeCloseTo(reportedCost);
    const summary = summarizeUsageWork(allocateUsageOutcomes({ contributions: rows, evidence: [] }), { metric: 'cost', costBasis: 'auto' });
    expect(summary.total).toBeCloseTo(total);
    expect(summary.moneyBasis).toMatchObject({ kind: 'mixed', currency: 'USD' });
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
    const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    const props = { query, slice, model, serverId: 'home' };
    const screen = await renderScreen(<>
      <UsageDailyWidget {...props} id="usage_daily" testID="qa-cost-daily" />
      <UsageFlowWidget {...props} id="usage_flow" testID="qa-cost-flow" />
      <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="qa-cost-breakdowns" />
      <UsageEfficiencyWidget {...props} id="usage_efficiency" testID="qa-cost-efficiency" />
    </>);
    for (const chart of screen.findAllByType(StackedSeriesChart)) {
      const values = chart.props.series.flatMap((series: { points: { y: number | null }[] }) => series.points.map(point => point.y));
      expect(values.some((value: number | null) => value !== null && value > 0)).toBe(true);
      expect(values.reduce((sum: number, value: number | null) => sum + (value ?? 0), 0)).toBeCloseTo(total);
    }
    expect(screen.findByType(RankedRows).props.rows.find((row: { id: string }) => row.id === 'claude').value).toBeCloseTo(expectedRowCost('claude'));
    expect(screen.findByType(RankedRows).props.rows.find((row: { id: string }) => row.id === 'claude').annotation)
      .toContain(t('usage.board.page.kindMixed'));
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'qa-cost-efficiency.perMtok')?.props.value)
      .toBeCloseTo(total / captured.totals.tokens.total * 1e6);
  });
  it('groups the real QA Haiku aliases once, conserves their tokens, and keeps Haiku 5.5 distinct', async () => {
    const query = normalizeUsageQuery({ breakdown: ['model'], metric: 'tokens' });
    const accounting = usageQaAccountingFixture();
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
    const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    const screen = await renderScreen(<UsageBreakdownsWidget query={query} slice={slice} model={model} serverId="home" id="usage_breakdowns" testID="qa-models" />);
    const rows = screen.findByType(RankedRows).props.rows as { id: string; label: string; value: number }[];
    expect(rows.filter(row => row.label === 'Haiku 4.5')).toEqual([expect.objectContaining({ id: 'claude-haiku-4-5', value: 2773382 })]);
    expect(rows.find(row => row.id === 'claude-haiku-5-5')).toMatchObject({ label: 'Haiku 5.5', value: 299832 });
    expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(accounting.totals.tokens.total);
    expect(slice.accounting!.coverage!.ranked.find(row => row.dimension === 'model')).toMatchObject({ totalEntries: 5, returnedEntries: 5, complete: true });
  });
  it('distinguishes a folded returned ranking from the three real QA machines omitted by the query', async () => {
    const query = normalizeUsageQuery({ breakdown: ['machine'], metric: 'tokens' });
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: usageQaAccountingFixture() }] }).results[0]!;
    const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    const screen = await renderScreen(<UsageBreakdownsWidget query={query} slice={slice} model={model} serverId="home" id="usage_breakdowns" testID="qa-machines" />);
    expect(screen.findByType(RankedRows).props.rows).toHaveLength(6);
    // The folded list has one disclosure; the omitted-source count appears once its available rows are open.
    expect(screen.findByType(UsageShowAllRows).props).toMatchObject({ total: 20, hidden: 14, complete: false,
      unlisted: null });
    expect(screen.getTextContent()).toContain(`${t('usage.showAvailable')} · 20`);
    expect(screen.getTextContent()).not.toContain(t('usage.board.page.moreRows', { count: 3 }));
    await screen.pressByTestIdAsync('qa-machines.machine.more.toggle');
    expect(screen.findByType(RankedRows).props.rows).toHaveLength(20);
    expect(screen.getTextContent()).toContain(t('usage.board.page.moreRows', { count: 3 }));
    expect(slice.accounting!.coverage!.ranked.find(row => row.dimension === 'machine')).toMatchObject({ totalEntries: 23, returnedEntries: 20, complete: false });
  });
  it('uses selected page money rather than a legacy fallback for cost per million tokens', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} id="usage_efficiency" testID="efficiency" />);
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'efficiency.perMtok')?.props.value)
      .toBe(150_000);
  });
  it.each([23, 5_701])('uses the same comparison presentation for Efficiency with %s preceding tokens', async previousTokens => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, period: { startMs: day, endMs: 2 * day } });
    const accounting = { ...props.slice.accounting!, totals: { ...props.slice.accounting!.totals,
      tokens: { ...tokens, input: 25, total: 25 } } };
    const previous = { ...accounting, totals: { ...accounting.totals,
      tokens: { ...tokens, input: previousTokens, total: previousTokens } } };
    // The page reads the canonical preceding-range query (totals only, no charts or insights).
    const priorQuery = resolveUsageComparisonQuery(query)!;
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: accounting }, { query: priorQuery, status: 'available', value: previous },
    ] }).results[0]!;
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} query={query} slice={slice} id="usage_efficiency" testID="efficiency" />);
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'efficiency.perMtok')?.props.comparison)
      .toMatchObject({ value: previousTokens === 23 ? '▼ 8%' : '▲ 228×', meaning: previousTokens === 23 ? 'good' : 'bad' });
  });
  it('keeps all four efficiency figures in their slots, an unknown one as a dash with its reason', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} id="usage_efficiency" testID="efficiency" />);
    const metrics = screen.findAllByType(HappierDataMetric).filter(metric => String(metric.props.testID).startsWith('efficiency.'));
    expect(metrics.map(metric => metric.props.testID)).toEqual(['efficiency.cacheHit', 'efficiency.perMtok', 'efficiency.perMergedPr', 'efficiency.noKeptChange']);
    // No merged PR is linked in this slice, and nothing measures work that kept no change: each is a dash that says why.
    expect(metrics.slice(2).map(metric => [metric.props.value, metric.props.caption]))
      .toEqual([['—', t('usage.board.page.noneLinkedByEvidence')], ['—', t('usage.board.page.notMeasuredYet')]]);
  });
  it('uses the common reported basis rather than mixing one invoice with another reported charge', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<>
      <UsagePeriodSummaryWidget {...props} id="usage_period_summary" testID="summary" />
      <UsageCostFactsWidget {...props} id="usage_cost_facts" testID="facts" />
      <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
      <UsageFlowWidget {...props} id="usage_flow" testID="flow" />
      <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="breakdown" />
    </>);
    const metrics = screen.findAllByType(HappierDataMetric);
    expect(metrics.find(metric => metric.props.testID === 'summary.hero')?.props.value).toBe(3);
    expect(metrics.find(metric => metric.props.testID === 'facts.fact.invoice')?.props.value).toBe(0.2);
    expect(metrics.find(metric => metric.props.testID === 'facts.fact.reported')?.props.value).toBe(3);
    expect(screen.findAllByType(StackedSeriesChart).map(chart => chart.props.series.reduce(
      (sum: number, entry: { points: { y: number }[] }) => sum + entry.points[0]!.y, 0))).toEqual([3, 3]);
    expect(screen.findByType(RankedRows).props.rows.map((row: { value: number }) => row.value)).toEqual([3]);
  });

  it('says "partial history" once for the facts band when every fact shares it, never under each fact (R9)', async () => {
    const props = mountedCosts();
    const facts = (props.slice.costFactTotals ?? []).map(fact => ({ ...fact, complete: false }));
    expect(facts.length).toBeGreaterThan(1);
    const screen = await renderScreen(<UsageCostFactsWidget {...props} slice={{ ...props.slice, costFactTotals: facts }} id="usage_cost_facts" testID="facts" />);
    const captions = screen.findAllByType(HappierDataMetric).filter(metric => String(metric.props.testID).startsWith('facts.fact.'))
      .map(metric => String(metric.props.caption));
    expect(captions.length).toBeGreaterThan(1);
    expect(captions.some(caption => caption.includes(t('usage.board.page.factIncomplete')))).toBe(false);
    expect(String(screen.findByTestId('facts.partial')!.props.children)).toContain(usagePartialHistoryLabel());
  });

  it('keeps missing selected money unavailable instead of drawing a zero total or row', async () => {
    const props = mountedCosts(true);
    const screen = await renderScreen(<>
      <UsagePeriodSummaryWidget {...props} id="usage_period_summary" testID="summary" />
      <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
      <UsageFlowWidget {...props} id="usage_flow" testID="flow" />
      <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="breakdown" />
    </>);
    // Unknown money is a quiet dash with its reason as the caption, never a headline word.
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'summary.hero')?.props.value).toBe('—');
    expect(screen.getTextContent()).toContain(t('usage.board.page.costUnpricedCaption'));
    expect(screen.findByType(RankedRows).props.rows[0].value).toBeNull();
    expect(screen.findAllByType(StackedSeriesChart).flatMap(chart => chart.props.series)
      .every((entry: { points: { y: number | null }[] }) => entry.points.every(point => point.y === null))).toBe(true);
  });

  it('leads a long breakdown with its largest rows and keeps the tail one press away', () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({ id: `m${index}` }));
    expect(leadingUsageRows(rows, false)).toEqual({ rows: rows.slice(0, 6), hidden: 10 });
    expect(leadingUsageRows(rows, true)).toEqual({ rows, hidden: 0 });
    // A list that is only a little longer shows whole: a disclosure for one or two rows is noise.
    expect(leadingUsageRows(rows.slice(0, 8), false)).toEqual({ rows: rows.slice(0, 8), hidden: 0 });
  });
});
