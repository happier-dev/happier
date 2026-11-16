import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { ChartDatum, HappierDataMetric, HappierDataRows, RankedRows, StackedSeriesChart, UsageConstellation } from '@happier-dev/plugin-ui/presentation';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui/components';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsageComparisonQuery, resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectUsagePageCost, resolveUsageCostForSelection} from '@happier-dev/protocol/usage/usageCostFacts';
import { repriceUsageAnalyticsResponse} from '@happier-dev/protocol/usage/usageCost';
import { type UsageAnalyticsContribution } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { addUsageMeasuredTokens, createEmptyUsageTokens } from '@happier-dev/protocol/usage/usageAggregation';
import { allocateUsageOutcomes, projectUsageWorkSummary, resolveUsageWorkOutcomeAdmissions } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { resolveUsageTokenCategories } from '@happier-dev/protocol/usage/usageTokenCategories';
import { projectUsageAnalyticsSummary } from '@happier-dev/protocol/usage/usageCost';
import { ScmPullRequestWorkEvidenceSchema } from '@happier-dev/protocol/scm/pullRequests';
import { summarizeUsageWork } from './usageWorkPresentation';
import { usagePageCostTrend } from '../usageCostPresentation';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { UsagePeriodSummaryWidget } from './UsagePeriodSummaryWidget';
import { formatUsageDurationCompact } from './usageHowYouWorkPresentation';
import { UsageFootprintWidget } from './UsageFootprintWidget';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { UsageCostFactsWidget } from './UsageCostFactsWidget';
import { UsageSourceCoverageWidget, UsageUnpricedWidget } from './UsageSourcePanels';
import { UsageDailyWidget } from './UsageDailyWidget';
import { UsageFlowWidget } from './UsageFlowWidget';
import { UsageBreakdownsWidget } from './UsageBreakdownsWidget';
import { UsageConstellationBody } from './UsageChartStyleBodies';
import { usageAgentTitle } from '@/sync/domains/usage/usageLabels';
import { leadingUsageRows, UsageCoverageLine, UsageShowAllRows, usagePartialHistoryLabel } from './usageBodyKit';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { UsageEfficiencyWidget } from './UsageEfficiencyWidget';
import { UsageModelPricesEditor } from './UsageModelPrices';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';

let controlsHome: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => { standardCleanup(); await controlsHome?.dispose(); controlsHome = undefined; });
async function renderControls(children: React.ReactNode) {
  controlsHome = await serveActionHomes({ homes: [{ key: 'cost', serverUrl: 'https://usage-cost-controls.test', accountId: 'cost-account' }],
    route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
  const server = controlsHome.homes.cost!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  return renderMountedCurrentUiContext(children);
}

const day = 86_400_000;
const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
function mountedCosts(unpriced: boolean | 'all' = false, tokenCount = 10) {
  const tokens = { input: tokenCount, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: tokenCount };
  const query = normalizeUsageQuery({ period: { startMs: 0, endMs: day }, metric: 'cost', costBasis: 'auto', breakdown: ['agent'] });
  const contributions: UsageAnalyticsContribution[] = [
    { id: 'a', sessionId: 's', turnId: 'a', observedAtMs: 1, eventCount: 1, agentId: 'claude', modelId: 'unknown-a',
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' }, tokens,
      cost: unpriced === 'all' ? { reportedUsd: null, estimatedUsd: null, currency: 'USD', costSource: 'none' }
        : { reportedUsd: 1, estimatedUsd: 0.5, invoiceUsd: 0.2, currency: 'USD' } },
    { id: 'b', sessionId: 's', turnId: 'b', observedAtMs: 2, eventCount: 1, agentId: 'claude', modelId: 'unknown-b',
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' }, tokens,
      cost: unpriced ? { reportedUsd: null, estimatedUsd: null, currency: 'USD', costSource: 'none' }
        : { reportedUsd: 2, estimatedUsd: 0.7, currency: 'USD' } },
  ];
  const cost = { reportedUsd: unpriced ? 1 : 3, estimatedUsd: unpriced ? 0.5 : 1.2, invoiceUsd: 0.2, currency: 'USD', costSource: 'none' as const };
  const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: repriceUsageAnalyticsResponse({
    v: 1, totals: { eventCount: 2, tokens: { ...tokens, input: tokenCount * 2, total: tokenCount * 2 }, cost }, contributions,
    series: [{ bucketStartMs: 0, bucketEndMs: day, eventCount: 2, tokens: { ...tokens, input: tokenCount * 2, total: tokenCount * 2 }, cost }],
    breakdowns: { agent: [{ key: 'claude', eventCount: 2, tokens: { ...tokens, input: tokenCount * 2, total: tokenCount * 2 }, cost }] },
    engineTimeline: [{ bucketStartMs: 0, bucketEndMs: day, leaders: [{ key: 'claude', eventCount: 2,
      tokens: { ...tokens, input: tokenCount * 2, total: tokenCount * 2 }, cost }] }],
  }, bundledUsageModelPriceCatalog) }] }, bundledUsageModelPriceCatalog).results[0]!;
  const identity = { query, authority: { serverId: 'home', accountId: 'usage-account' } };
  const model: UsageWidgetBodyModel = { requestedQuery: identity, shownQuery: identity, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
  return { query, slice, model, serverId: 'home' };
}

describe('one selected money basis across Usage bodies', () => {
  it('renders measured parts across breakdowns, cost facts and unpriced usage', async () => {
    const base = mountedCosts('all');
    const query = normalizeUsageQuery({ ...base.query, metric: 'tokens', breakdown: ['model'] });
    const parts = { input: 1710, output: 3, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
    const source = base.slice.accounting!;
    const accounting = repriceUsageAnalyticsResponse({ ...source,
      totals: { ...source.totals, tokens: parts },
      contributions: source.contributions!.slice(0, 1).map(row => ({ ...row, modelId: 'parts-model', tokens: parts })),
      breakdowns: { model: [{ key: 'parts-model', eventCount: 1, tokens: parts, cost: source.contributions![0]!.cost }] },
    }, bundledUsageModelPriceCatalog);
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<>
      <UsageBreakdownsWidget {...base} query={query} slice={slice} id="usage_breakdowns" testID="parts-breakdown" />
      <UsageCostFactsWidget {...base} query={query} slice={slice} id="usage_cost_facts" testID="parts-facts" />
      <UsageUnpricedWidget {...base} query={query} slice={slice} id="usage_unpriced" testID="parts-unpriced" />
    </>);
    expect.soft(screen.findAllByType(RankedRows)[0]?.props.rows ?? []).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'parts-model', value: 1713 }),
    ]));
    const metrics = screen.findAllByType(HappierDataMetric);
    expect.soft(metrics.find(row => row.props.testID === 'parts-facts.fact.unpriced')?.props.value).toBe(1713);
    expect.soft(metrics.find(row => row.props.testID === 'parts-unpriced.tokens')?.props.value).toBe(1713);
  });
  it('omits unmeasured model rows while retaining measured zero and known model amounts', async () => {
    const base = mountedCosts();
    const query = normalizeUsageQuery({ ...base.query, metric: 'tokens', breakdown: ['model'] });
    const cost = base.slice.accounting!.totals.cost;
    const unknownTokens = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
    const entries = [
      { key: 'unknown', eventCount: 1, tokens: unknownTokens, cost },
      { key: 'measured-zero', eventCount: 1, tokens: { ...tokens, input: 0, total: 0 }, cost },
      { key: 'measured-model', eventCount: 1, tokens, cost },
    ];
    const slice = { ...base.slice, accounting: { ...base.slice.accounting!, breakdowns: { model: entries } } };
    const screen = await renderScreen(<UsageBreakdownsWidget {...base} query={query} slice={slice}
      id="usage_breakdowns" testID="model-measurements" />);
    const rows = screen.findByType(RankedRows).props.rows;
    expect(rows.map((row: { id: string; value: number | null }) => ({ id: row.id, value: row.value }))).toEqual([
      { id: 'measured-model', value: 10 }, { id: 'measured-zero', value: 0 },
    ]);
    const measuredUnknown = { ...slice, accounting: { ...slice.accounting, breakdowns: { model: [
      { ...entries[0]!, tokens: { ...tokens, input: 0, total: 0 } }, entries[2]!,
    ] } } };
    await screen.update(<UsageBreakdownsWidget {...base} query={query} slice={measuredUnknown}
      id="usage_breakdowns" testID="model-measurements" />);
    expect(screen.findByType(RankedRows).props.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'unknown', value: 0 }), expect.objectContaining({ id: 'measured-model', value: 10 }),
    ]));
  });

  it('ranks an agent with unmeasured usage under a quiet dash, its reason on its own line, never a bold word', async () => {
    const base = mountedCosts();
    const query = normalizeUsageQuery({ ...base.query, metric: 'tokens', breakdown: ['agent'] });
    const accounting = base.slice.accounting!;
    const unmeasured = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
    const slice = { ...base.slice, accounting: { ...accounting, breakdowns: { agent: [
      ...accounting.breakdowns!.agent!, { key: 'codex', eventCount: 1, tokens: unmeasured, cost: accounting.totals.cost },
    ] } } };
    const screen = await renderScreen(<UsageBreakdownsWidget {...base} query={query} slice={slice}
      id="usage_breakdowns" testID="unmeasured-agents" />);
    expect(screen.getTextContent()).not.toContain(t('usage.board.plans.cellUnknown'));
    expect(screen.getTextContent()).toContain('—');
  });

  it('says a chosen ranking with nothing recorded is waiting for usage, never asks to choose a breakdown (C5)', async () => {
    const base = mountedCosts();
    const query = normalizeUsageQuery({ ...base.query, metric: 'tokens', breakdown: ['model'] });
    const accounting = base.slice.accounting!;
    const slice = { ...base.slice, accounting: { ...accounting, totals: { ...accounting.totals, eventCount: 0 }, breakdowns: { model: [] } } };
    const screen = await renderScreen(<UsageBreakdownsWidget {...base} query={query} slice={slice}
      id="usage_breakdowns" testID="first-models" />);
    expect(screen.getTextContent()).not.toContain(t('usage.board.page.breakdownEmptyReason'));
    expect(screen.findHostByTestId('first-models.empty')).not.toBeNull();
    // The daily bars say the same once, instead of a plot of unrecorded days on a 0-to-0 axis.
    const daily = await renderScreen(<UsageDailyWidget {...base} query={query} slice={slice}
      id="usage_daily" testID="first-daily" />);
    expect(daily.findHostByTestId('first-daily.drawn')).toBeNull();
    expect(daily.findHostByTestId('first-daily.empty')).not.toBeNull();
    // And the flow says no usage, not that it needs more history.
    const flow = await renderScreen(<UsageFlowWidget {...base} query={query} slice={slice}
      id="usage_flow" testID="first-flow" />);
    expect(flow.getTextContent()).toContain(t('usage.board.page.noUsageTitle'));
    expect(flow.getTextContent()).not.toContain(t('usage.board.page.flowEmptyTitle'));
  });
  it('tells a new Account that models appear after recorded usage instead of an empty price sheet (C6)', async () => {
    const base = mountedCosts();
    const slice = { ...base.slice, accounting: { ...base.slice.accounting!, contributions: [], breakdowns: {} } };
    const screen = await renderScreen(<UsageModelPricesEditor slice={slice} serverId="home" testID="prices" />);
    expect(screen.findHostByTestId('prices.empty')).not.toBeNull();
    const priced = await renderScreen(<UsageModelPricesEditor slice={base.slice} serverId="home" testID="priced" />);
    expect(priced.findHostByTestId('priced.empty')).toBeNull();
  });
  it('keeps unknown token figures as dashes in the period summary and unpriced fact widgets', async () => {
    const base = mountedCosts(true);
    const unknownTokens = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
    const query = normalizeUsageQuery({ ...base.query, metric: 'tokens' });
    const slice = { ...base.slice, accounting: { ...base.slice.accounting!,
      totals: { ...base.slice.accounting!.totals, tokens: unknownTokens } }, costFactTotals: [
        { kind: 'unpriced' as const, eventCount: 1, currency: 'USD', amountUsd: null, tokens: unknownTokens, complete: false,
          sources: ['runtime'], asOfMs: 1 },
      ] };
    const props = { ...base, query, slice, model: { ...base.model, slice } };
    const screen = await renderScreen(<>
      <UsagePeriodSummaryWidget {...props} id="usage_period_summary" testID="unknown-summary" />
      <UsageUnpricedWidget {...props} id="usage_unpriced" testID="unknown-unpriced" />
      <UsageCostFactsWidget {...props} id="usage_cost_facts" testID="unknown-facts" />
    </>);
    expect(screen.findAllByType(HappierDataMetric).find(node => node.props.label === t('usage.tokens'))?.props.value).toBe('—');
    expect(screen.findHostByTestId('unknown-summary.hero')?.props.accessibilityLabel).toContain(`${t('usage.tokens')}: —`);
    expect(screen.findAllByType(HappierDataMetric).find(node => node.props.testID === 'unknown-summary.hero')?.props.caption).toBe(t('common.unavailable'));
    expect(screen.findAllByType(HappierDataMetric).find(node => node.props.testID === 'unknown-unpriced.tokens')?.props.value).toBe('—');
    expect(screen.findAllByType(HappierDataMetric).find(node => node.props.testID === 'unknown-facts.fact.unpriced')?.props.value).toBe('—');
    const measured = mountedCosts(false, 0);
    await screen.update(<UsagePeriodSummaryWidget {...measured} query={query}
      id="usage_period_summary" testID="unknown-summary" />);
    expect(screen.findAllByType(HappierDataMetric).find(node => node.props.testID === 'unknown-summary.hero')?.props.value).toBe(0);
    expect(screen.findHostByTestId('unknown-summary.hero')?.props.accessibilityLabel).toContain(`${t('usage.tokens')}: 0`);
  });

  it('leads the period summary with the measured token parts when no agent reported a total (USAGE-ACCEPT #13)', async () => {
    const base = mountedCosts();
    const partTokens = { input: 6900, output: 16, reasoning: null, cacheRead: 0, cacheWrite: 0, total: null };
    const query = normalizeUsageQuery({ ...base.query, metric: 'tokens' });
    const slice = { ...base.slice, accounting: { ...base.slice.accounting!,
      totals: { ...base.slice.accounting!.totals, tokens: partTokens } } };
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...base} query={query} slice={slice}
      id="usage_period_summary" testID="parts-summary" />);
    const hero = screen.findAllByType(HappierDataMetric).find(node => node.props.testID === 'parts-summary.hero')!;
    expect(hero.props.value).toBe(6916);
    expect(hero.props.caption).toBe(t('usage.board.page.tokensFromParts'));
    expect(screen.getTextContent()).not.toContain(t('common.unavailable'));
  });

  it('leads Cost facts with the one page cost the summary shows, the separate facts beneath it (USAGE-ACCEPT #3)', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<>
      <UsagePeriodSummaryWidget {...props} id="usage_period_summary" testID="summary" />
      <UsageCostFactsWidget {...props} id="usage_cost_facts" testID="facts" />
    </>);
    const metrics = screen.findAllByType(HappierDataMetric);
    const summary = metrics.find(metric => metric.props.testID === 'summary.hero')!;
    const total = metrics.find(metric => metric.props.testID === 'facts.total')!;
    expect(total.props.size).toBe('hero');
    expect(total.props.value).toBe(summary.props.value);
    expect(total.props.caption).toBe(summary.props.caption);
    // The separate facts stay beneath as supporting detail, each with its own token basis.
    expect(metrics.find(metric => metric.props.testID === 'facts.fact.reported')?.props.size).toBe('stat');
    expect(metrics.find(metric => metric.props.testID === 'facts.fact.invoice')?.props.value).toBe(0.2);
  });

  it('draws no empty river plot when weeks were read but no agent recorded a share (C7)', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, metric: 'tokens', includeActivity: true });
    const slice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: props.slice.accounting! }],
      howYouWork: [{ query, asOfMs: day, detail: { status: 'available', facts: [] } }],
    }, bundledUsageModelPriceCatalog).results[0]!;
    const calendar = slice.howYouWork!.agentCalendar!;
    const week = (startMs: number) => ({ startMs, endMs: startMs + 7 * day, date: '', weekday: 1, hour: null,
      totals: { ...calendar.periodSummary.totals, tokens: null, eventCount: 0 }, agents: [], leaders: calendar.periodSummary.leaders });
    const empty = { ...slice, howYouWork: { ...slice.howYouWork!, agentCalendar: { ...calendar,
      weeks: [week(0), week(7 * day)], weeklyAgentMix: [] } } };
    const screen = await renderScreen(<UsageFlowWidget {...props} query={query} slice={empty} presentation={{ style: 'agentRiver' }}
      id="usage_flow" testID="river" />);
    expect(screen.findHostByTestId('river.river')).toBeNull();
    expect(screen.findHostByTestId('river.needsData')).not.toBeNull();
  });
  it('uses the agent presentation owner for Constellation unattributed identities', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, includeActivity: true });
    const slice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: props.slice.accounting! }],
      howYouWork: [{ query, asOfMs: day, detail: { status: 'available', facts: [] } }],
    }, bundledUsageModelPriceCatalog).results[0]!;
    const calendar = slice.howYouWork!.agentCalendar!;
    const member = calendar.periodSummary.agents[0]!;
    const unknowns = { ...slice, howYouWork: { ...slice.howYouWork!, agentCalendar: { ...calendar,
      periodSummary: { ...calendar.periodSummary, agents: [
        { ...member, agentId: 'legacy', shares: { ...member.shares, tokens: 0.5 } },
        { ...member, agentId: null, shares: { ...member.shares, tokens: 0.5 } },
      ] },
    } } };
    const screen = await renderScreen(<UsageConstellationBody {...props} query={query} slice={unknowns} id="usage_constellation" testID="constellation" />);
    const chart = screen.findByType(UsageConstellation);
    await act(async () => {
      chart.findAll(node => node.props.testID === 'constellation.constellationChart' && typeof node.props.onLayout === 'function')[0]!
        .props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 330 } } });
    });
    expect(screen.findByTestId('constellation.constellationChart.node.legacy')).not.toBeNull();
    expect(screen.findByTestId('constellation.constellationChart.node.null')).not.toBeNull();
    expect(screen.getTextContent()).toContain(usageAgentTitle(''));
    expect(screen.getTextContent()).not.toContain(t('usage.board.charts.unknownAgent'));
  });
  it('retains measured Agent money beside unpriced observations', async () => {
    const props = mountedCosts(true);
    const screen = await renderScreen(<UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="agents" />);
    const row = screen.findByType(RankedRows).props.rows.find((row: { id: string }) => row.id === 'claude');
    expect(row.value).toBe(1);
    expect(row.annotation).toContain(t('usage.board.page.kindReported'));
    expect(row.annotation).not.toContain(t('usage.board.page.costUnpricedCaption'));
  });
  it('names exact token breakdown amounts in tokens rather than the dimension being ranked', async () => {
    const props = mountedCosts(false, 2_093_005);
    const query = normalizeUsageQuery({ ...props.query, metric: 'tokens' });
    const screen = await renderScreen(<UsageBreakdownsWidget {...props} query={query} id="usage_breakdowns" testID="token-units" />);
    const datum = screen.findAllByType(ChartDatum).find(node => node.props.testID === 'token-units.agent-datum-0');
    expect(datum?.props.datum.value).toContain('4,186,010');
    expect(datum?.props.datum.value).toContain(t('usage.board.page.tokensUnit'));
  });
  it('keeps waffle marks for pointer inspection and exposes the mix once through Exact values', async () => {
    const props = mountedCosts();
    const tokenValues = { input: 94, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 100 };
    const tokenCategories = resolveUsageTokenCategories(tokenValues, { inputIncludesCache: false });
    if (tokenCategories === null) throw new Error('Expected categorized tokens for an explicit accounting convention');
    const accounting = { ...props.slice.accounting!, totals: { ...props.slice.accounting!.totals, tokens: tokenValues }, tokenCategories };
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'small',
      footprint: { columns: 2, columnSpan: 1, rowSpan: 1, height: 'compact', width: 'half' }, geometry: { width: 320, height: 384 } }}>
      <UsageEfficiencyWidget {...props} slice={{ ...props.slice, accounting }} id="usage_efficiency" testID="waffle" />
    </WidgetPresentationProvider>);
    const marks = screen.findAllHostsByTestId('usage-efficiency-mix-trigger');
    expect(marks).toHaveLength(50);
    expect(marks.every(mark => mark.props.accessible === false && mark.props.focusable === false)).toBe(true);
    const toggle = screen.findHostByTestId('waffle.mix-values-toggle');
    expect(toggle?.props.accessibilityLabel).toContain(t('usage.board.charts.showValues'));
    await screen.pressByTestIdAsync('waffle.mix-values-toggle');
    expect(screen.findHostByTestId('waffle.mix-values-row-0')?.props.accessibilityLabel).toContain('94');
    expect(screen.findHostByTestId('waffle.mix-values-row-1')?.props.accessibilityLabel).toContain('6');
  });
  it('keeps exact cache-hit precision in percentage units rather than the fractional numeric model', async () => {
    const props = mountedCosts();
    const tokens = { input: 2, output: 0, reasoning: 0, cacheRead: 1, cacheWrite: 0, total: 3 };
    const tokenCategories = resolveUsageTokenCategories(tokens, { inputIncludesCache: false });
    if (tokenCategories === null) throw new Error('Expected categorized tokens for an explicit accounting convention');
    const accounting = { ...props.slice.accounting!, totals: { ...props.slice.accounting!.totals,
      tokens }, tokenCategories };
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} slice={{ ...props.slice, accounting }} id="usage_efficiency" testID="efficiency" />);
    expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'efficiency.cacheHit.detail')?.props.datum.value).toContain('33.33%');
  });
  it('formats explicit precision in the selected app language rather than the browser default locale', async () => {
    const previous = getPreferredLanguage();
    try {
      setPreferredLanguageFromSettings('fr');
      await preloadTranslations();
      const screen = await renderScreen(<UsageCostFactsWidget {...mountedCosts(false, 2093005)} id="usage_cost_facts" testID="facts" />);
      expect(screen.findAllByType(ChartDatum).find(row => row.props.testID === 'facts.fact.reported.detail')?.props.datum.subtitle).toContain('4\u202f186\u202f010');
    } finally { setPreferredLanguageFromSettings(previous); await preloadTranslations(); }
  });
  it('reveals the exact token basis of a money fact whose inline token caption is abbreviated', async () => {
    const props = mountedCosts(false, 2093005);
    const screen = await renderScreen(<UsageCostFactsWidget {...props} id="usage_cost_facts" testID="facts" />);
    const reported = screen.findAllByType(ChartDatum).find(row => row.props.testID === 'facts.fact.reported.detail');
    expect(reported?.props.datum.subtitle).toContain('4,186,010');
    expect(screen.getTextContent()).toContain('4.2M');
  });
  it('keeps the private footprint as an accounted-token proxy with no fabricated estimate', async () => {
    const props = mountedCosts(false, 2093005);
    const slice = resolveUsagePageAggregation({ queries: [props.query],
      accounting: [{ query: props.query, status: 'available', value: props.slice.accounting! }],
      howYouWork: [{ query: props.query, asOfMs: day, detail: { status: 'available', facts: [] } }],
    }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsageFootprintWidget {...props} slice={slice} id="usage_footprint" testID="footprint" />);
    const metric = screen.findAllByType(HappierDataMetric).find(row => row.props.testID === 'footprint.tokens');
    expect(metric?.props.value).toBe(formatTokenCount(slice.accounting!.totals.tokens.total));
    expect(metric?.props.comparison.value).toBe(t('usage.board.howYouWork.footprintProxy'));
    expect(screen.getTextContent()).toContain(t('usage.board.howYouWork.footprintNoEstimate'));
    const datum = screen.findAllByType(ChartDatum).find(row => row.props.testID === 'footprint.tokens.detail');
    expect(datum?.props.datum.value).toContain('4,186,010');
    expect(datum?.findAllByType(UsageCoverageLine)).toHaveLength(0);
  });
  it('does not reaggregate unchanged comparison contributions on a source-progress render', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, period: { startMs: day, endMs: 2 * day } });
    // The page reads the canonical preceding-range query (totals only, no charts or insights).
    const priorQuery = resolveUsageComparisonQuery(query)!;
    let reads = 0;
    const previous = { ...props.slice.accounting!, contributions: props.slice.accounting!.contributions!.map(row =>
      new Proxy(row, { get(target, key, receiver) {
        if (key === 'cost') reads++;
        return Reflect.get(target, key, receiver);
      } })) };
    const withComparison = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: props.slice.accounting! },
      { query: priorQuery, status: 'available', value: previous },
    ] }, bundledUsageModelPriceCatalog).results[0]!;
    expect(reads).toBeGreaterThan(0);
    expect(withComparison.comparison!.accounting).not.toHaveProperty('contributions');
    reads = 0;
    const bodies = (current: typeof withComparison, includeEfficiency = true) => <>
      <UsagePeriodSummaryWidget {...props} query={query} slice={current} id="usage_period_summary" testID="comparison-summary" />
      {includeEfficiency ? <UsageEfficiencyWidget {...props} query={query} slice={current} id="usage_efficiency" testID="comparison-efficiency" /> : null}
    </>;
    const screen = await renderScreen(bodies(withComparison, false));
    expect(reads).toBe(0);
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
    const changedPrevious = repriceUsageAnalyticsResponse({ ...previous,
      totals: { ...previous.totals, cost: { ...previous.totals.cost, reportedUsd: (previous.totals.cost.reportedUsd ?? 0) * 2 } },
      contributions: previous.contributions.map(row => ({ ...row, cost: { ...row.cost, reportedUsd: (row.cost.reportedUsd ?? 0) * 2 } })),
    }, bundledUsageModelPriceCatalog);
    const changed = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: props.slice.accounting! },
      { query: priorQuery, status: 'available', value: changedPrevious },
    ] }, bundledUsageModelPriceCatalog).results[0]!;
    expect(changed.comparison!.accounting).not.toHaveProperty('contributions');
    await screen.update(bodies(changed));
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
    const expected = props.slice.costFactTotals!.filter(fact => fact.kind === 'unpriced').reduce((sum, fact) => sum + (fact.tokens.total ?? 0), 0);
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
      const slice = resolveUsagePageAggregation({ queries: [props.query], accounting: [{ query: props.query, status }] }, bundledUsageModelPriceCatalog).results[0]!;
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
    const slice = resolveUsagePageAggregation({ queries: [props.query], accounting: [{ query: props.query, status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderControls(<UsageSourceCoverageWidget {...props} slice={slice} id="usage_source_coverage" testID="coverage" />);
    expect(screen.findByType(HappierDataRows).props.rows).toHaveLength(1);
    expect(screen.getTextContent()).toContain(t('usage.board.page.sourceKindFromLogs'));
    // The caveat is one compact line; its reasons are one press away, never a paragraph under the rows.
    expect(screen.getTextContent()).not.toContain(t('usage.board.page.coverageReason_missing_baseline'));
    await screen.pressByTestIdAsync('coverage.detail.action');
    expect(screen.getTextContent()).toContain(t('usage.board.page.coverageReason_missing_baseline'));
  });
  it('lists source coverage as a short led list: identical captures across machines say so once with a count, distinct ones fold behind Show all', async () => {
    const props = mountedCosts();
    type CoverageSource = NonNullable<NonNullable<typeof props.slice.accounting>['coverage']>['sources'][number];
    const source: Omit<CoverageSource, 'source'> = { path: 'native', status: 'unknown', eventCount: 0, captureKind: 'measured', asOfMs: 100 };
    const coverageOf = (sources: readonly CoverageSource[]) => resolveUsagePageAggregation({ queries: [props.query],
      accounting: [{ query: props.query, status: 'available', value: { ...props.slice.accounting!, coverage: { status: 'partial' as const,
        reasons: [], missingDimensions: [], range: { startMs: 0, endMs: day, complete: false }, ranked: [], sources: [...sources] } } }] }, bundledUsageModelPriceCatalog).results[0]!;
    const twins = await renderScreen(<UsageSourceCoverageWidget {...props} id="usage_source_coverage" testID="coverage"
      slice={coverageOf([...Array.from({ length: 30 }, () => ({ ...source, source: 'claude-assistant-usage' })), { ...source, source: 'codex-token-count' }])} />);
    expect(twins.findByType(HappierDataRows).props.rows).toHaveLength(2);
    expect(twins.getTextContent()).toContain('30');
    // One source across machines whose captures differ in status is still one row, its statuses counted in it (N8).
    const mixed = await renderScreen(<UsageSourceCoverageWidget {...props} id="usage_source_coverage" testID="coverage"
      slice={coverageOf([...Array.from({ length: 3 }, () => ({ ...source, source: 'claude-assistant-usage' })),
        ...Array.from({ length: 2 }, () => ({ ...source, source: 'claude-assistant-usage', status: 'partial' as const }))])} />);
    const mixedRows = mixed.findByType(HappierDataRows).props.rows as readonly (readonly string[])[];
    expect(mixedRows).toHaveLength(1);
    // A human row: the source's name, then one status (the most limiting one) and how many machines report it,
    // never a stacked list of every capture's status.
    expect(mixedRows[0]![0]).not.toContain('×');
    expect(mixedRows[0]![1]).toContain(t('usage.board.page.machinesCount', { count: 5 }));
    expect(mixedRows[0]![1]).toContain(t('usage.board.page.factIncomplete'));
    expect(mixedRows[0]![1]).not.toContain(';');
    expect(mixedRows[0]![1]).not.toContain(t('usage.board.sources.coverageUnknown'));
    const distinct = await renderControls(<UsageSourceCoverageWidget {...props} id="usage_source_coverage" testID="coverage"
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
    }, bundledUsageModelPriceCatalog, {}, costBasis);
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<>
      <UsageDailyWidget {...props} query={query} slice={slice} id="usage_daily" testID="whole-daily" />
      <UsageBreakdownsWidget {...props} query={query} slice={slice} id="usage_breakdowns" testID="whole-breakdown" />
      <UsageCostFactsWidget {...props} query={query} slice={slice} id="usage_cost_facts" testID="whole-facts" />
      <UsagePeriodSummaryWidget {...props} query={query} slice={slice} id="usage_period_summary" testID="whole-summary" />
      <UsageEfficiencyWidget {...props} query={query} slice={slice} id="usage_efficiency" testID="whole-efficiency" />
    </>);
    const metrics = screen.findAllByType(HappierDataMetric);
    const selected = costBasis === 'auto' ? 11 : costBasis === 'estimated' ? 6 : costBasis === 'reported' ? 7 : 0;
    expect(projectUsagePageCost(slice.accounting!, costBasis).amountUsd).toBe(selected);
    expect(metrics.find(metric => metric.props.testID === 'whole-summary.hero')?.props.value).toBe(selected);
    expect(metrics.find(metric => metric.props.testID === 'whole-efficiency.perMtok')?.props.value).toBe(selected / total.tokens.total * 1e6);
    expect(metrics.find(metric => metric.props.testID === 'whole-facts.fact.reported')?.props.value).toBe(7);
    expect(metrics.find(metric => metric.props.testID === 'whole-facts.fact.estimated')?.props.value).toBe(6);
    expect(screen.findByType(RankedRows).props.rows[0].value).toBe(selected);
    const chart = screen.findByType(StackedSeriesChart);
    const points: { y: number | null }[] = chart.props.series.flatMap((entry: { points: { y: number | null }[] }) => entry.points);
    expect(points.reduce((sum, point) => sum + (point.y ?? 0), 0)).toBe(olderUnpriced ? 11 : selected ?? 0);
    if (olderUnpriced) {
      expect(points.some(point => point.y === null)).toBe(true);
      expect(slice.costFactTotals?.find(fact => fact.kind === 'unpriced')?.tokens.total).toBe(30);
      const unpriced = t('usage.board.page.costUnpricedCaption');
      expect(metrics.find(metric => metric.props.testID === 'whole-summary.hero')?.props.caption).not.toBe(unpriced);
      expect(metrics.find(metric => metric.props.testID === 'whole-efficiency.perMtok')?.props.caption).not.toBe(unpriced);
    }
  });
  it('draws a Breakdowns heading per dimension only while the card ranks several, since one dimension is the card\'s own title', async () => {
    const mounted = mountedCosts();
    const claude = mounted.slice.accounting!.breakdowns!.agent![0]!;
    const accounting = { ...mounted.slice.accounting!, breakdowns: { agent: [claude], model: [{ ...claude, key: 'opus' }] } };
    const headings = async (breakdown: readonly ('agent' | 'model')[]) => {
      const q = normalizeUsageQuery({ ...mounted.query, breakdown: [...breakdown] });
      const slice = resolveUsagePageAggregation({ queries: [q], accounting: [{ query: q, status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog).results[0]!;
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
    ] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query} slice={slice}
      id="usage_period_summary" testID="summary" />);
    const comparison = screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'summary.hero')?.props.comparison;
    if (previousTokens === 0) expect(comparison).toBeUndefined();
    else expect(comparison).toMatchObject({ value: previousTokens === 100 ? '▲ 228×' : '▲ 14%' });
  });
  it('does not compare a reported Period total against a prior mixed measured floor', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, period: { startMs: day, endMs: 2 * day }, metric: 'tokens' });
    const accounting = { ...props.slice.accounting!, totals: { ...props.slice.accounting!.totals,
      tokens: { ...tokens, total: 22_804 } } };
    const priorQuery = resolveUsageComparisonQuery(query)!;
    const previousTokens = { ...tokens, total: 100, measured: { total: 1800, fromParts: true as const } };
    const previous = { ...accounting, totals: { ...accounting.totals, tokens: previousTokens } };
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: accounting }, { query: priorQuery, status: 'available', value: previous },
    ] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query} slice={slice}
      id="usage_period_summary" testID="floor-comparison" />);
    const hero = screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'floor-comparison.hero')!;
    expect(hero.props.value).toBe(22_804);
    expect(hero.props.comparison).toBeUndefined();
  });
  it('says the Period cost once in Cost mode: the hero is the cost, so its column shows the tokens (R135 N2)', async () => {
    const props = mountedCosts(true);
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} id="usage_period_summary" testID="summary" />);
    const metrics = screen.findAllByType(HappierDataMetric);
    expect(metrics.filter(metric => metric.props.label === t('usage.cost'))).toHaveLength(1);
    expect(metrics.find(metric => metric.props.testID === 'summary.hero')?.props.label).toBe(t('usage.cost'));
    expect(metrics.find(metric => metric.props.label === t('usage.tokens'))?.props.value).toBe(props.slice.accounting!.totals.tokens.total);
  });
  it('keeps the Agent time slot stable and publishes only complete interval figures', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, includeSessionEvidence: true });
    const accounting = [{ query, status: 'available' as const, value: props.slice.accounting! }];
    const cold = resolveUsagePageAggregation({ queries: [query], accounting }, bundledUsageModelPriceCatalog);
    const facts = [{ workId: 'work', evidenceId: 'turn', agentId: null, machineId: null,
      kind: 'busy' as const, startMs: 0, endMs: 3_600_000 }];
    const partial = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'partial', facts: facts.map(fact => ({ ...fact, endMs: null })) } }] }, bundledUsageModelPriceCatalog);
    const complete = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'available', facts } }] }, bundledUsageModelPriceCatalog);
    // Transcript coverage can be partial while every admitted busy interval is
    // closed. Completeness of this duration belongs to the interval facet.
    const completeIntervals = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'partial', facts } }] }, bundledUsageModelPriceCatalog);
    const measuredZero = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'available', facts: [] } }] }, bundledUsageModelPriceCatalog);
    const pending = resolveUsagePageAggregation({ queries: [query], accounting, previous: complete,
      sources: [{ source: 'how_you_work', status: 'pending' }] }, bundledUsageModelPriceCatalog);
    const refused = resolveUsagePageAggregation({ queries: [query], accounting, previous: complete,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'unknown' } }] }, bundledUsageModelPriceCatalog);
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query}
      slice={cold.results[0]!} id="usage_period_summary" testID="summary" />);
    const statLabels = () => screen.findAllByType(HappierDataMetric)
      .filter(metric => metric.props.size === 'stat').map(metric => metric.props.label);
    // A Cost-mode hero is the cost, so the first column is the tokens (R135 N2).
    const expectedLabels = [t('usage.tokens'), t('usage.board.page.mergedPrs'), t('usage.board.page.agentTime')];
    for (const [batch, expected] of [[cold, '—'], [partial, '—'], [complete, formatUsageDurationCompact(3_600_000)], [completeIntervals, formatUsageDurationCompact(3_600_000)], [measuredZero, formatUsageDurationCompact(0)], [pending, formatUsageDurationCompact(3_600_000)], [partial, '—'], [refused, '—']] as const) {
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
  it('presents Agent time once as a duration without a second raw-seconds detail', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, includeSessionEvidence: true });
    const slice = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: props.slice.accounting! }],
      howYouWork: [{ query, asOfMs: day, detail: { status: 'available', facts: [
        { workId: 'work', evidenceId: 'turn', agentId: null, machineId: null, kind: 'busy', startMs: 0, endMs: 5_400_000 },
      ] } }],
    }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query} slice={slice}
      id="usage_period_summary" testID="duration-summary" />);
    const agent = screen.findAllByType(HappierDataMetric).find(metric => metric.props.label === t('usage.board.page.agentTime'))!;
    expect(agent.props.value).toBe(formatUsageDurationCompact(5_400_000));
    expect(screen.getTextContent()).not.toContain('5400');
    expect(screen.getTextContent()).not.toContain('1.5');
    expect(screen.findAllByType(ChartDatum).filter(node => node.props.datum?.label === t('usage.board.page.agentTime'))).toHaveLength(0);
  });
  it('renders observed merged counts from compact Work facts without allocation rows', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, includeWorkEvidence: true, workProjection: 'summary', includeSessionEvidence: false });
    const value = projectUsageAnalyticsSummary(props.slice.accounting!, UsageAnalyticsQueryRequestSchema.parse({
      dateRange: { startMs: 0, endMs: day }, costMode: 'auto',
    }));
    const evidence = ['a', 'b'].map(turnId => ScmPullRequestWorkEvidenceSchema.parse({ sessionId: 's', turnId, repositoryKey: 'repo',
      checkpointRef: `checkpoint/s/${turnId}`, checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed',
      pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Outcome', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'merged' },
    }));
    const summary = projectUsageWorkSummary(resolveUsageWorkOutcomeAdmissions({
      turns: evidence.map(({ sessionId, turnId }) => ({ sessionId, turnId })), evidence,
    }).outcomes);
    const slice = (merged: typeof summary) => resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value }], work: [{ query, status: 'available', summary: merged }],
    }, bundledUsageModelPriceCatalog).results[0]!;
    const current = slice(summary);
    expect(current.accounting).not.toHaveProperty('contributions');
    expect(current.work).toBeUndefined();
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query} slice={current} id="usage_period_summary" testID="summary" />);
    const merged = () => screen.findAllByType(HappierDataMetric).find(metric => metric.props.label === t('usage.board.page.mergedPrs'));
    expect(merged()?.props.value).toBe(1);
    expect(merged()?.props.caption).toBe(t('usage.board.page.linkedByEvidence'));
    await screen.update(<UsagePeriodSummaryWidget {...props} query={query} slice={slice(projectUsageWorkSummary([]))} id="usage_period_summary" testID="summary" />);
    expect(merged()?.props.value).toBe(0);
    expect(merged()?.props.caption).toBe(t('usage.board.page.noneLinkedByEvidence'));
  });
  it('says Agent time and merged work need a newer server, not "not measured yet", when this Home\'s server is too old to read them', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, includeSessionEvidence: true, includeWorkEvidence: true });
    const accounting = [{ query, status: 'available' as const, value: props.slice.accounting! }];
    const tooOld = (operation: string) => ({ status: 'error' as const, errorCode: 'update_required',
      updateRequired: { kind: 'update_required' as const, operation, component: 'server' as const, reason: 'session_read_batch_unsupported' } });
    const slice = resolveUsagePageAggregation({ queries: [query], accounting,
      sources: [{ source: 'how_you_work', ...tooOld('session.detail') }, { source: 'work', ...tooOld('work.outcomes') }] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query} slice={slice} id="usage_period_summary" testID="summary" />);
    const caption = (label: string) => screen.findAllByType(HappierDataMetric).find(metric => metric.props.label === label)?.props.caption;
    // Waiting cannot fill these in: the slot says why once, in the same words as the page header, and keeps its place.
    expect(caption(t('usage.board.page.agentTime'))).toBe(t('usage.board.page.needsNewerServer'));
    expect(caption(t('usage.board.page.mergedPrs'))).toBe(t('usage.board.page.needsNewerServer'));
  });
  it('uses reported then priced money per real QA row across Daily, Flow, Breakdowns, Leaders, Efficiency and Work', async () => {
    const query = normalizeUsageQuery({ metric: 'cost', breakdown: ['agent'], timeZoneOffsetMinutes: 120 });
    const captured = usageQaAccountingFixture();
    const candidates = [...new Set(captured.contributions!.map(row => row.agentId ?? 'unknown'))]
      .map(key => ({ key, eventCount: 1, tokens, cost: captured.totals.cost }));
    const accounting = repriceUsageAnalyticsResponse({ ...captured,
      breakdowns: { ...captured.breakdowns, agent: candidates }, leaders: { ...captured.leaders, agents: candidates },
    }, bundledUsageModelPriceCatalog);
    const rows = accounting.contributions!;
    const claudeCost = rows.filter(row => row.agentId === 'claude')
      .reduce((sum, row) => sum + (row.cost.apiEquivalentUsd ?? row.cost.estimatedUsd ?? 0), 0);
    const reportedCost = captured.totals.cost.reportedUsd ?? 0;
    const total = claudeCost + reportedCost;
    const page = projectUsagePageCost(accounting, 'auto');
    expect(page.amountUsd).toBeCloseTo(total);
    expect(page.selection).toMatchObject({ kind: 'mixed', currency: 'USD' });
    expect(usagePageCostTrend(page).reduce((sum, point) => sum + (point.cost ?? 0), 0)).toBeCloseTo(total);
    const expectedRowCost = (agentId: string) => rows.filter(row => (row.agentId ?? 'unknown') === agentId)
      .reduce((sum, row) => sum + (row.cost.reportedUsd || row.cost.apiEquivalentUsd || row.cost.estimatedUsd || 0), 0);
    for (const entries of [page.accounting.breakdowns!.agent!, page.accounting.leaders!.agents!]) {
      for (const row of entries) expect(resolveUsageCostForSelection(row.cost!, page.selection)).toBeCloseTo(expectedRowCost(row.key));
    }
    expect(resolveUsageCostForSelection(page.accounting.breakdowns!.model!.find(row => row.key === 'unknown')!.cost, page.selection)).toBeCloseTo(reportedCost);
    const summary = summarizeUsageWork(allocateUsageOutcomes({ contributions: rows, evidence: [] }), { metric: 'cost', costBasis: 'auto' });
    expect(summary.total).toBeCloseTo(total);
    expect(summary.moneyBasis).toMatchObject({ kind: 'mixed', currency: 'USD' });
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog).results[0]!;
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
      .toBeCloseTo(total / captured.totals.tokens.total! * 1e6);
  });
  it('groups the real QA Haiku aliases once, conserves their tokens, and keeps Haiku 5.5 distinct', async () => {
    const query = normalizeUsageQuery({ breakdown: ['model'], metric: 'tokens' });
    const accounting = usageQaAccountingFixture();
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }, bundledUsageModelPriceCatalog).results[0]!;
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
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: usageQaAccountingFixture() }] }, bundledUsageModelPriceCatalog).results[0]!;
    const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    const screen = await renderControls(<UsageBreakdownsWidget query={query} slice={slice} model={model} serverId="home" id="usage_breakdowns" testID="qa-machines" />);
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
  it.each(['parts', 'mixed'] as const)('uses measured %s tokens for current and previous cost per million', async kind => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, period: { startMs: day, endMs: 2 * day } });
    const measured = (amount: number) => kind === 'parts'
      ? { ...createEmptyUsageTokens(), input: amount }
      : addUsageMeasuredTokens({ ...tokens, input: amount / 4, total: amount / 4 },
        { ...createEmptyUsageTokens(), input: amount * 3 / 4 });
    const accounting = { ...props.slice.accounting!, totals: { ...props.slice.accounting!.totals, tokens: measured(400) } };
    const previous = { ...accounting, totals: { ...accounting.totals, tokens: measured(200) } };
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: accounting },
      { query: resolveUsageComparisonQuery(query)!, status: 'available', value: previous },
    ] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} query={query} slice={slice} id="usage_efficiency" testID="measured-efficiency" />);
    const metric = screen.findAllByType(HappierDataMetric).find(row => row.props.testID === 'measured-efficiency.perMtok');
    expect.soft(metric?.props.value).toBe(7_500);
    expect(metric?.props.comparison).toMatchObject({ value: '▼ 50%', meaning: 'good' });
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
    ] }, bundledUsageModelPriceCatalog).results[0]!;
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} query={query} slice={slice} id="usage_efficiency" testID="efficiency" />);
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'efficiency.perMtok')?.props.comparison)
      .toMatchObject({ value: previousTokens === 23 ? '▼ 8%' : '▲ 228×', meaning: previousTokens === 23 ? 'good' : 'bad' });
  });
  it('keeps all four efficiency figures in their slots, an unknown one a quiet dash with its reason, never a bold word', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} id="usage_efficiency" testID="efficiency" />);
    const metrics = screen.findAllByType(HappierDataMetric).filter(metric => String(metric.props.testID).startsWith('efficiency.'));
    expect(metrics.map(metric => metric.props.testID)).toEqual(['efficiency.cacheHit', 'efficiency.perMtok', 'efficiency.perMergedPr', 'efficiency.noKeptChange']);
    // No merged PR is linked in this slice, and nothing measures work that kept no change.
    expect(metrics.slice(2).map(metric => [metric.props.value, metric.props.caption]))
      .toEqual([['—', t('usage.board.page.noneLinkedByEvidence')],
        ['—', t('usage.board.page.notMeasuredYet')]]);
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
    const props = mountedCosts('all');
    const screen = await renderScreen(<>
      <UsagePeriodSummaryWidget {...props} id="usage_period_summary" testID="summary" />
      <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
      <UsageFlowWidget {...props} id="usage_flow" testID="flow" />
      <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="breakdown" />
    </>);
    // Unknown money is a quiet dash with its reason as the caption, never a headline word.
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'summary.hero')?.props.value).toBe('—');
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'summary.hero')?.props.caption).toBeTruthy();
    expect(screen.findByType(RankedRows).props.rows[0].value).toBeNull();
    expect(screen.findAllByType(StackedSeriesChart).flatMap(chart => chart.props.series)
      .every((entry: { points: { y: number | null }[] }) => entry.points.every(point => point.y === null))).toBe(true);
  });

  it('reads an empty population as a measured zero cost, never zero beside "Unavailable"', async () => {
    const base = mountedCosts();
    const zeroTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const empty = { v: 1 as const, totals: { eventCount: 0, tokens: zeroTokens, cost: { reportedUsd: null, estimatedUsd: null,
      invoiceUsd: null, currency: 'USD', costSource: 'none' as const } }, contributions: [], series: [], breakdowns: {} };
    for (const metric of ['cost', 'tokens'] as const) {
      const query = normalizeUsageQuery({ ...base.query, metric });
      const slice = resolveUsagePageAggregation({ queries: [query],
        accounting: [{ query, status: 'available', value: repriceUsageAnalyticsResponse(empty, bundledUsageModelPriceCatalog) }] }, bundledUsageModelPriceCatalog).results[0]!;
      const screen = await renderScreen(<UsagePeriodSummaryWidget {...base} query={query} slice={slice}
        id="usage_period_summary" testID="empty" />);
      const figure = screen.findAllByType(HappierDataMetric)
        .find(node => metric === 'cost' ? node.props.testID === 'empty.hero' : node.props.label === t('usage.cost'));
      expect([metric, figure?.props.value, figure?.props.caption]).toEqual([metric, 0, undefined]);
    }
  });

  it('leads a long breakdown with its largest rows and keeps the tail one press away', () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({ id: `m${index}` }));
    expect(leadingUsageRows(rows, false)).toEqual({ rows: rows.slice(0, 6), hidden: 10 });
    expect(leadingUsageRows(rows, true)).toEqual({ rows, hidden: 0 });
    // A list that is only a little longer shows whole: a disclosure for one or two rows is noise.
    expect(leadingUsageRows(rows.slice(0, 8), false)).toEqual({ rows: rows.slice(0, 8), hidden: 0 });
  });
});
