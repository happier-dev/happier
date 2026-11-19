import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import {
  UsageFilterBar,
  usageTokensCostMetricOptions,
} from '@/components/settings/usage/UsageFilterBar';
import {
  USAGE_SCOPE_FILTER_ALL,
  createUsageAppFilters,
  withShowChoice,
  type UsageWidgetPageFilter,
} from '@/components/settings/usage/useUsageWidgetPageFilters';
import type { UsageAppEnvironment } from '@/sync/api/account/usageAppCallsAccounting';
import { t } from '@/text';
import { normalizeUsageQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { getWidgetSizeFootprintV1 } from '@happier-dev/protocol/widgets';
import { projectAppCallsUsageSourcesV1 as projectDatabaseCaptureUsageSourcesV1 } from '@happier-dev/plugin-sdk/usage';
import { usageAppCallsSourceId } from '@/sync/domains/usage/usageAppCallsSource';
import { UsageBreakdownsWidget } from '@/components/settings/usage/widgets/UsageBreakdownsWidget';
import { UsageAppsNothingRecorded } from '@/components/settings/usage/UsageAppsNothingRecorded';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import {
  WidgetFrameBodyCaptionContext,
  WidgetFrameBodyIdentityContext,
  type WidgetFrameBodyIdentity,
} from '@/components/widgets/frame/widgetFrameBodyCaption';
import { readUsageBreakdownsInstanceTitle } from '@/components/settings/usage/usageBreakdownTitle';

/**
 * Development specimen (`/dev/usage-your-apps`, lab p7Cost-usage / p7Cost-sources): the real Usage filter bar and its
 * real filter owner with fixture app Environments, in both states of the exclusive Agents / Your apps choice; then the
 * Costs ranking in Your apps (lab p7Cost-usage "By environment") through the real breakdowns body and frame, and the
 * apps' empty period (lab p7Cost-empty). Fixture data only; selections are not written anywhere.
 */
const ENVIRONMENTS: readonly UsageAppEnvironment[] = [
  {
    environmentId: 'env-prod',
    serverId: 'specimen',
    name: 'Production',
    projectSourceId: 'billing',
    projectName: 'billing-api',
    collectorMachineId: 'collector',
  },
  {
    environmentId: 'env-staging',
    serverId: 'specimen',
    name: 'Staging',
    projectSourceId: 'billing',
    projectName: 'billing-api',
    collectorMachineId: 'collector',
  },
  {
    environmentId: 'env-preview',
    serverId: 'specimen',
    name: 'Preview #212',
    projectSourceId: 'billing',
    projectName: 'billing-api',
    collectorMachineId: 'collector',
  },
];
const accept = () => true;

/** One million tokens; the fixture's counts are whole millions so its dollars add up exactly. */
const M = 1_000_000;
/** gpt-5-mini at the catalog's list price: $0.25 per million in, $2 per million out. */
const CATALOG: UsageModelPriceCatalog = {
  v: 1,
  models: { 'gpt-5-mini': { inputUsdPerMillion: 0.25, outputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.025, cacheWriteUsdPerMillion: 0.25 } },
  provenance: { source: 'litellm', origin: 'fetched', asOfMs: Date.UTC(2026, 10, 14), revision: 'catalog-nov-14', fetchStatus: 'ready' },
};
/** Production $166 (200M in, 58M out), Staging $21 (20M, 8M), Preview #212 $2 (4M, 0.5M): $189 in all. */
const APP_CALLS: Readonly<Record<string, readonly [input: number, output: number, calls: number]>> = {
  'env-prod': [200 * M, 58 * M, 46_210],
  'env-staging': [20 * M, 8 * M, 6_480],
  'env-preview': [4 * M, 0.5 * M, 290],
};

/** The App calls slice through the real producer the Usage reader uses (`readUsageAppCallsAccounting`). */
function appCallsSlice(): Readonly<{ slice: UsageQueryResultSlice; query: UsageQuery }> {
  const until = Date.now();
  const since = until - 30 * 86_400_000;
  const parts = ENVIRONMENTS.map((environment) => {
    const [input, output, callCount] = APP_CALLS[environment.environmentId]!;
    const tokens = { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: input + output };
    return {
      source: usageAppCallsSourceId(environment.environmentId),
      label: environment.name,
      read: {
        ok: true as const, source: { kind: 'environment' as const, serverId: environment.serverId, environmentId: environment.environmentId },
        since, until,
        items: [{ bucketStartMs: since, provider: 'openai', modelId: 'gpt-5-mini', requestedModel: 'gpt-5-mini', operation: 'chat',
          callCount, tokens, tokenCategories: tokens, reportedCost: null, firstSeenMs: since, lastSeenMs: until }],
        coverage: { callCount, tokenCategoryCallCount: callCount, reportedCostCallCount: 0, lostObservations: 0, reason: null },
      },
    };
  });
  const query = normalizeUsageQuery({ period: { relative: '30days' }, metric: 'cost', breakdown: ['agent'], costBasis: 'api_equivalent',
    sources: ENVIRONMENTS.map((environment) => usageAppCallsSourceId(environment.environmentId)) });
  const accounting = { ...projectDatabaseCaptureUsageSourcesV1(parts, CATALOG, {}, { granularity: 'day' }).accounting, priceCatalog: CATALOG };
  // Specimen boundary: the Resource slice fields the ranking reads; the rest is not modelled.
  const slice = { key: 'usage-your-apps-specimen', requestedQuery: query, shownQuery: query, accounting, pending: false,
    sources: [{ source: 'accounting', status: 'available' }] } as unknown as UsageQueryResultSlice;
  return { slice, query };
}

/** The Costs preset's ranking card (`breakdown: ['agent']`) in Your apps: the real body lends the frame its title. */
function CostsRankingCard() {
  const { slice, query } = React.useMemo(appCallsSlice, []);
  const [caption, setCaption] = React.useState<string | null>(null);
  const [identity, setIdentity] = React.useState<WidgetFrameBodyIdentity | null>(null);
  const model = React.useMemo(() => ({ refresh: async () => {} }), []);
  const instanceTitle = readUsageBreakdownsInstanceTitle({ definition: { kind: 'builtin', id: 'usage_breakdowns' },
    bindings: { breakdown: { kind: 'value', value: ['agent'] } } });
  const body = React.useMemo(() => ({ kind: 'content' as const, children: (
    <WidgetFrameBodyCaptionContext.Provider value={setCaption}>
      <WidgetFrameBodyIdentityContext.Provider value={setIdentity}>
        <UsageBreakdownsWidget id="usage_breakdowns" model={model} slice={slice} query={query} serverId="specimen" testID="specimen.ranking" />
      </WidgetFrameBodyIdentityContext.Provider>
    </WidgetFrameBodyCaptionContext.Provider>
  ) }), [model, slice, query]);
  return (
    <WidgetFrame
      testID="specimen.ranking.frame"
      frameStyle="card"
      placement="home"
      widgetPresentation={{ size: 'tall', footprint: getWidgetSizeFootprintV1('corePage', 'tall')! }}
      mark="list-bullets"
      title={identity?.title ?? instanceTitle}
      source={caption ?? undefined}
      body={body}
    />
  );
}

function agentFilters(): readonly UsageWidgetPageFilter[] {
  const all = (what: string) => ({
    id: USAGE_SCOPE_FILTER_ALL,
    label: t('usage.board.page.filterAllOf', {
      what: what.toLocaleLowerCase(),
    }),
  });
  const filter = (
    field: UsageWidgetPageFilter['field'],
    key: Parameters<typeof t>[0],
    options: UsageWidgetPageFilter['options'],
  ) =>
    ({
      field,
      title: t(key),
      selected: [],
      options: [all(t(key)), ...options],
      select: accept,
    }) satisfies UsageWidgetPageFilter;
  return [
    withShowChoice(
      filter('sources', 'usage.board.page.filterSources', [
        { id: 'claude', label: 'Claude', agentId: 'claude' },
        { id: 'codex', label: 'Codex', agentId: 'codex' },
      ]),
      ENVIRONMENTS,
      accept,
    ),
    filter('agents', 'usage.board.page.filterAgents', [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
    ]),
    filter('machines', 'usage.board.page.filterMachines', [
      { id: 'studio', label: 'Studio Mac' },
    ]),
    filter('projects', 'usage.board.page.filterProjects', [
      { id: 'happier', label: 'happier' },
    ]),
  ];
}

function Bar(
  props: Readonly<{
    filters: readonly UsageWidgetPageFilter[];
    testID: string;
  }>,
) {
  const metricOptions = React.useMemo(() => usageTokensCostMetricOptions(), []);
  return (
    <UsageFilterBar
      period="30days"
      costBasis="api_equivalent"
      coverageIncomplete={false}
      scopeFilters={props.filters}
      costBasisOptions={['auto', 'reported', 'estimated', 'api_equivalent']}
      costBasisPending={false}
      onPeriodChange={async () => true}
      onCostBasisChange={async () => true}
      metricOptions={metricOptions}
      metric="cost"
      onMetricChange={() => {}}
      testID={props.testID}
    />
  );
}

export default function UsageYourAppsSpecimen() {
  const agents = React.useMemo(agentFilters, []);
  const apps = React.useMemo(
    () =>
      createUsageAppFilters(
        ENVIRONMENTS,
        ENVIRONMENTS.map((row) => row.environmentId),
        accept,
      ),
    [],
  );
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.note}>
        Development specimen · fixture Environments · not product data
      </Text>
      <View style={styles.state}>
        <Text style={styles.title}>Agents (default)</Text>
        <Bar filters={agents} testID="specimen.agents" />
      </View>
      <View style={styles.state}>
        <Text style={styles.title}>Your apps · billing-api</Text>
        <Bar filters={apps} testID="specimen.apps" />
      </View>
      <View style={styles.state}>
        <Text style={styles.title}>Your apps · Costs ranking · 30 days ($166 + $21 + $2 = $189)</Text>
        <Bar filters={apps} testID="specimen.appsRanking" />
        <View style={styles.half}>
          <CostsRankingCard />
        </View>
      </View>
      <View style={styles.state}>
        <Text style={styles.title}>Your apps · no model calls in the period (the scene stands in the cards' place)</Text>
        <Bar filters={apps} testID="specimen.appsEmpty" />
        <UsageAppsNothingRecorded />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    padding: theme.space.s24,
    gap: theme.space.s32,
    maxWidth: 1180,
    width: '100%',
    alignSelf: 'center',
  },
  note: { color: theme.colors.text.secondary },
  state: { gap: theme.space.s12 },
  title: { color: theme.colors.text.primary },
  half: { maxWidth: 560, width: '100%' },
}));
