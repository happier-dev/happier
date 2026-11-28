import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DatabaseCaptureCostsReadResultV1 } from '@happier-dev/database-protocol';
import {
  CaptureAppLlmCalls,
  type CaptureAppLlmCallV1,
} from '@happier-dev/plugins-telemetry/capture-views';
import type { PluginUiResourceProjection } from '@happier-dev/plugin-ui/hostApi';
import { UsageBreakdownsBody } from '@happier-dev/plugin-ui/presentation';
import {
  appCallsPricingModelIds,
  projectAppCallsUsageV1,
  readAppCallsPricingV1,
} from '@happier-dev/plugin-sdk/usage';
import { normalizeUsageQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageCostSelection } from '@happier-dev/protocol/usage/usageCostFacts';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceSchemas';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachineServiceResource } from '@/components/machines/resources/useMachineServiceResource';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { usageMeterFill } from '@/components/settings/usage/usageAccent';
import { rankUsageBreakdownEntries } from '@/components/settings/usage/widgets/UsageBreakdownsWidget';
import { UsageWidgetBody, type UsageWidgetSuppliedFacts } from '@/components/settings/usage/widgets/UsageWidgetBody';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { readUsageAppCallsPriceOverrides } from '@/sync/api/account/usageAppCallsAccounting';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { appCallsUsageSlice, usageAppCallsSourceId } from '@/sync/domains/usage/usageAppCallsSource';
import { t } from '@/text';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { usageModelLabel } from '@/sync/domains/usage/usageLabels';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';

import { TelemetryCard } from './TelemetryCard';
import { usageSeriesTitle } from '@/components/settings/usage/widgets/usageChartLabels';
import {
  readTelemetryCaptureCostsSnapshot,
  readTelemetryCaptureListSnapshot,
  telemetryCaptureFailureCode,
  telemetryCostsGranularity,
  TelemetryCaptureTransportContext,
  useTelemetryUsagePricesRead,
  type TelemetryAppLlmCallSelection,
  type TelemetryCaptureReads,
} from './telemetryCaptureReads';

type Totals = Extract<DatabaseCaptureCostsReadResultV1, { ok: true }>;
const COSTS_PROJECTION: PluginUiResourceProjection<Totals> = {
  decode: content => readTelemetryCaptureCostsSnapshot(content.bytes),
};
const CALLS_PROJECTION: PluginUiResourceProjection<readonly CaptureAppLlmCallV1[]> = {
  decode: content => {
    const { page } = readTelemetryCaptureListSnapshot('traces', content.bytes);
    return page.list === 'traces' ? page.items : [];
  },
};
const NO_INPUT = Object.freeze({});
const providerDeclarations = readAccountProviderDeclarations({ kind: 'account' });
const appCallProviderLabel = (id: string) => providerDeclarations.find(
  declaration => declaration.definition.id === id,
)?.definition.name ?? id;
const appCallModelLabel = (id: string) => usageModelLabel(id).label;
type Pricing = Readonly<{ catalog: UsageModelPriceCatalog; viewerOverrides: UsageModelPriceOverridesV1 }>;

/**
 * The viewer's Usage prices for the models in the window, read once per set of models through Usage's own pricing
 * owner. The last settled prices stay while a new model appears, so the cards never flash empty.
 */
function useAppCallsPricing(scope: ServerAccountScope | null, totals: Totals | null) {
  const readPrices = useTelemetryUsagePricesRead();
  const modelIds = React.useMemo(() => totals ? appCallsPricingModelIds([totals]).sort() : null, [totals]);
  const key = scope && modelIds ? JSON.stringify([scope.serverId, scope.accountId, modelIds]) : null;
  const [attempt, setAttempt] = React.useState(0);
  const [settled, setSettled] = React.useState<Readonly<{ key: string; pricing: Pricing | null; failure: string | null }> | null>(null);
  // A pushed window with the same models keeps the same key: the prices are not read again for it.
  const demand = React.useRef({ scope, modelIds });
  demand.current = { scope, modelIds };
  React.useEffect(() => {
    const { scope: current, modelIds: ids } = demand.current;
    if (!key || !current || !ids) return;
    const abort = new AbortController();
    readAppCallsPricingV1({
      modelIds: ids,
      readOverrides: () => readUsageAppCallsPriceOverrides(current),
      readCatalog: catalogIds => readPrices({ scope: current, modelIds: catalogIds, signal: abort.signal }),
    }).then(
      pricing => { if (!abort.signal.aborted) setSettled({ key, pricing, failure: null }); },
      error => { if (!abort.signal.aborted) setSettled(previous => ({ key, pricing: previous?.pricing ?? null, failure: telemetryCaptureFailureCode(error) })); },
    );
    return () => abort.abort();
  }, [key, attempt, readPrices]);
  const retry = React.useCallback(async () => { setAttempt(value => value + 1); }, []);
  return { pricing: settled?.pricing ?? null, failure: settled?.key === key ? settled.failure : null, retry };
}

/**
 * Telemetry → LLM calls (P7 J4, lab p7Cost-env): the app's own model calls in the window, priced with the viewer's Usage
 * prices and drawn by the same Usage bodies as Usage → Your apps (cost facts, daily cost by model), then the routes that
 * spend it and each retained call, which opens its own trace. Agents' use is never added to it.
 */
export function TelemetryAppLlmCalls(
  props: Readonly<{
    reads: TelemetryCaptureReads;
    environmentId: string;
    lifetime: ServerAccountScopeLifetime | null;
    active: boolean;
    windowMs: number;
    locale: string;
    selection: TelemetryAppLlmCallSelection;
    onSelect: (selection: TelemetryAppLlmCallSelection) => void;
    onOpenCall: (call: CaptureAppLlmCallV1) => void;
  }>,
) {
  const { reads, environmentId, lifetime, active, windowMs, locale, selection, onSelect, onOpenCall } = props;
  const { theme } = useUnistyles();
  const chartTheme = usePluginUiTheme(theme);
  const formatCallCost = React.useCallback((amount: number, currency: string) => formatUsageCost(amount, currency, locale), [locale]);
  const router = useRouter();
  const { createResourceClient } = React.useContext(TelemetryCaptureTransportContext);
  const costsReference = React.useMemo(() => reads.costsReference(selection, windowMs), [reads, selection, windowMs]);
  const callsReference = React.useMemo(() => reads.listReference('traces', windowMs, selection), [reads, selection, windowMs]);
  const demand = { accountLifetime: lifetime, targetMachineId: reads.targetMachineId, active, follow: true, createClient: createResourceClient };
  const costs = useMachineServiceResource({ ...demand, reference: costsReference, projection: COSTS_PROJECTION });
  const calls = useMachineServiceResource({ ...demand, reference: callsReference, projection: CALLS_PROJECTION });
  const scope = lifetime?.scope ?? null;
  const totals = costs?.value ?? null;
  const { pricing, failure: pricingFailure, retry: retryPricing } = useAppCallsPricing(scope, totals);
  const granularity = telemetryCostsGranularity(windowMs);

  const priced = React.useMemo(() => {
    if (!totals || !pricing) return null;
    const usage = projectAppCallsUsageV1(totals, pricing.catalog, pricing.viewerOverrides, { granularity, costMode: 'api_equivalent' });
    const facts = usage.accounting.costFacts ?? [];
    const hasApiPrice = facts.some(fact => fact.kind === 'api_equivalent' && fact.source !== 'no_tokens' && fact.amountUsd !== null);
    const hasReportedCost = facts.some(fact => fact.kind === 'reported' && fact.amountUsd !== null);
    const query: UsageQuery = normalizeUsageQuery({
      period: { startMs: totals.since, endMs: totals.until }, metric: 'cost',
      costBasis: !hasApiPrice && hasReportedCost ? 'reported' : 'api_equivalent', granularity,
      breakdown: ['model'], sources: [usageAppCallsSourceId(environmentId)], includeComparison: false,
    });
    return { query, usage, slice: appCallsUsageSlice({ key: `environment-llm:${environmentId}`, query, usage,
      catalog: pricing.catalog, viewerOverrides: pricing.viewerOverrides, readAtMs: totals.until }) };
  }, [environmentId, granularity, pricing, totals]);
  const refreshAll = React.useCallback(async () => {
    await Promise.all([costs?.refresh(), calls?.refresh(), retryPricing()]);
  }, [calls, costs, retryPricing]);
  const facts = React.useMemo((): UsageWidgetSuppliedFacts | null => scope && priced ? {
    authority: scope, query: priced.query, slice: priced.slice, pending: false, error: null, refresh: refreshAll,
  } : null, [priced, refreshAll, scope]);

  // What the window shows, as the page's filter chips (lab p7Flows-metrics chips): the services and versions the
  // retained calls report. A choice applies at once; the chosen one stays offered while it narrows the calls.
  const services = React.useMemo(() => [...new Set([...(calls?.value ?? []).flatMap(call => call.serviceName ? [call.serviceName] : []),
    ...(selection.serviceName ? [selection.serviceName] : [])])].sort(), [calls?.value, selection.serviceName]);
  const versions = React.useMemo(() => [...new Set([...(calls?.value ?? []).flatMap(call =>
    call.serviceVersion && (!selection.serviceName || call.serviceName === selection.serviceName) ? [call.serviceVersion] : []),
  ...(selection.serviceVersion ? [selection.serviceVersion] : [])])].sort(), [calls?.value, selection.serviceName, selection.serviceVersion]);
  const allServices = t('deploymentTelemetry.llm.allServices');
  const allVersions = t('deploymentTelemetry.metrics.allVersions');
  const filters = (
    <View style={styles.chips}>
      <SelectionListFilterChip filter={{
        id: 'project-deployments.telemetry.llm.service', testID: 'project-deployments.telemetry.llm.service',
        label: t('deploymentTelemetry.metrics.service'), valueLabel: selection.serviceName ?? allServices,
        selectedId: selection.serviceName ?? ALL, muted: !selection.serviceName,
        options: [{ id: ALL, label: allServices }, ...services.map(name => ({ id: name, label: name }))],
        onChange: (id: string) => onSelect(id === ALL ? {} : { serviceName: id }),
      }} />
      {versions.length > 0 || selection.serviceVersion ? <SelectionListFilterChip filter={{
        id: 'project-deployments.telemetry.llm.version', testID: 'project-deployments.telemetry.llm.version',
        label: t('common.version'), valueLabel: selection.serviceVersion ?? allVersions,
        selectedId: selection.serviceVersion ?? ALL, muted: !selection.serviceVersion,
        options: [{ id: ALL, label: allVersions }, ...versions.map(version => ({ id: version, label: version }))],
        onChange: (id: string) => onSelect({ ...(selection.serviceName ? { serviceName: selection.serviceName } : {}),
          ...(id === ALL ? {} : { serviceVersion: id }) }),
      }} /> : null}
    </View>
  );

  const failure = costs?.error ?? calls?.error;
  if (failure || (!priced && pricingFailure)) {
    return (
      <View style={styles.body} testID="project-deployments.telemetry.llm">
        {filters}
        <SurfaceStateCard
          testID="project-deployments.telemetry.llm.unavailable"
          kind="unavailable"
          size="line"
          title={t('deploymentTelemetry.llm.unavailable')}
          diagnosticCode={failure?.code ?? pricingFailure ?? 'telemetry_unavailable'}
          action={{ label: t('common.retry'), onPress: () => { void refreshAll(); } }}
        />
      </View>
    );
  }
  const reading = !facts || !calls?.value;
  const routes = priced?.usage.routeBreakdown ?? [];
  // Ranked by the cost they draw, as every Usage breakdown body ranks its rows.
  const routeSelection = resolveUsagePageCostSelection(routes.map(entry => entry.cost), priced?.query.costBasis ?? 'api_equivalent');
  const routeRows = rankUsageBreakdownEntries(routes, 'cost', routeSelection).map(({ entry, tokens, value }, index) => ({
    id: entry.key,
    label: entry.label ?? t('usage.board.plans.cellUnknown'),
    value,
    annotation: t('deploymentTelemetry.llm.tokens', { count: formatTokenCount(tokens.total, locale) }),
    color: usageMeterFill(theme, index === 0),
  }));
  const usageCard = (id: 'usage_cost_facts' | 'usage_daily', testID: string, title: string | null) => (
    <TelemetryCard testID={`${testID}.frame`} title={title}>
      {facts ? <UsageWidgetBody id={id} input={NO_INPUT} serverId={facts.authority.serverId} testID={testID} facts={facts}
        coveragePresentation={id === 'usage_cost_facts' ? 'summary' : 'elsewhere'} /> : (
        <SurfaceStateCard testID={`${testID}.reading`} kind="loading" size="line" title={t('deploymentTelemetry.llm.reading')} />
      )}
    </TelemetryCard>
  );
  return (
    <View style={styles.body} testID="project-deployments.telemetry.llm">
      {filters}
      {usageCard('usage_cost_facts', 'project-deployments.telemetry.llm.costFacts', t('usage.cost'))}
      {/* Titled by its bars' bucket, as Usage titles this chart; its caption says the measure and period once. */}
      {usageCard('usage_daily', 'project-deployments.telemetry.llm.daily', usageSeriesTitle(granularity))}
      {routeRows.length > 0 ? <TelemetryCard testID="project-deployments.telemetry.llm.routes.frame" title={t('deploymentTelemetry.llm.byRoute')}>
        <UsageBreakdownsBody theme={chartTheme} spacing={theme.space} testID="project-deployments.telemetry.llm.routes" model={{
          namedByCard: true,
          blocks: [{
            id: 'route', label: t('deploymentTelemetry.llm.byRoute'), rows: routeRows, unknownLabel: '—',
            testID: 'project-deployments.telemetry.llm.routes.rows',
            valueFormatter: value => formatUsageCost(value, 'USD', locale),
          }],
        }} /></TelemetryCard> : null}
      {/* The retained calls are a card of their own, titled like the cards above them (design review D5). */}
      <TelemetryCard testID="project-deployments.telemetry.llm.calls.frame" title={t('deploymentTelemetry.llm.calls')}>
        <CaptureAppLlmCalls
          items={calls?.value ?? []}
          loading={reading}
          locale={locale}
          modelLabel={appCallModelLabel}
          providerLabel={appCallProviderLabel}
          formatCost={formatCallCost}
          onOpen={onOpenCall}
        />
      </TelemetryCard>
      <View style={styles.note}>
        <Text variant="meta" style={[styles.quiet, styles.noteText]}>
          {t('deploymentTelemetry.llm.note')}
        </Text>
        <TextLinkButton
          testID="project-deployments.telemetry.llm.usage"
          label={t('deploymentTelemetry.llm.openUsage')}
          size="meta"
          onPress={() => router.push('/settings/usage' as never)}
        />
      </View>
    </View>
  );
}

const ALL = '';

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s8,
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
  quiet: { color: theme.colors.text.secondary },
  // The note stands on the cards' text edge, as the lab's footnote does.
  note: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s16, paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
  noteText: { flex: 1, minWidth: 0 },
}));
