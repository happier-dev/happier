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
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceSchemas';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachineServiceResource } from '@/components/machines/resources/useMachineServiceResource';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { usageMeterFill } from '@/components/settings/usage/usageAccent';
import { UsageWidgetBody, type UsageWidgetSuppliedFacts } from '@/components/settings/usage/widgets/UsageWidgetBody';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { readUsageAppCallsPriceOverrides } from '@/sync/api/account/usageAppCallsAccounting';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { appCallsUsageSlice, usageAppCallsSourceId } from '@/sync/domains/usage/usageAppCallsSource';
import { t } from '@/text';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';

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
  const router = useRouter();
  const { createResourceClient } = React.useContext(TelemetryCaptureTransportContext);
  const costsReference = React.useMemo(() => reads.costsReference(selection, windowMs), [reads, selection, windowMs]);
  const callsReference = React.useMemo(() => reads.listReference('traces', windowMs, selection), [reads, selection, windowMs]);
  const demand = { accountLifetime: lifetime, targetMachineId: reads.targetMachineId, active, follow: true, createClient: createResourceClient };
  const costs = useMachineServiceResource({ ...demand, reference: costsReference, projection: COSTS_PROJECTION });
  const calls = useMachineServiceResource({ ...demand, reference: callsReference, projection: CALLS_PROJECTION });
  const [service, setService] = React.useState(selection.serviceName ?? '');
  const [version, setVersion] = React.useState(selection.serviceVersion ?? '');
  const serviceName = service.trim() || undefined;
  const serviceVersion = version.trim() || undefined;
  const selectionChanged = selection.serviceName !== serviceName || selection.serviceVersion !== serviceVersion;
  const scope = lifetime?.scope ?? null;
  const totals = costs?.value ?? null;
  const { pricing, failure: pricingFailure, retry: retryPricing } = useAppCallsPricing(scope, totals);
  const granularity = telemetryCostsGranularity(windowMs);

  // The window as Usage's App calls subject: this Environment, priced at API prices with the viewer's overrides.
  const priced = React.useMemo(() => {
    if (!totals || !pricing) return null;
    const query: UsageQuery = normalizeUsageQuery({
      period: { startMs: totals.since, endMs: totals.until }, metric: 'cost', costBasis: 'api_equivalent', granularity,
      breakdown: ['model'], sources: [usageAppCallsSourceId(environmentId)], includeComparison: false,
    });
    const usage = projectAppCallsUsageV1(totals, pricing.catalog, pricing.viewerOverrides, { granularity, costMode: 'api_equivalent' });
    return { query, usage, slice: appCallsUsageSlice({ key: `environment-llm:${environmentId}`, query, usage,
      catalog: pricing.catalog, readAtMs: totals.until }) };
  }, [environmentId, granularity, pricing, totals]);
  const refreshAll = React.useCallback(async () => {
    await Promise.all([costs?.refresh(), calls?.refresh(), retryPricing()]);
  }, [calls, costs, retryPricing]);
  const facts = React.useMemo((): UsageWidgetSuppliedFacts | null => scope && priced ? {
    authority: scope, query: priced.query, slice: priced.slice, pending: false, error: null, refresh: refreshAll,
  } : null, [priced, refreshAll, scope]);

  const filters = (
    <ItemGroup>
      <View style={styles.facts}>
        <FieldItem label={t('deploymentTelemetry.metrics.service')} style={styles.fact}>
          <FieldTextInput testID="project-deployments.telemetry.llm.service" accessibilityLabel={t('deploymentTelemetry.metrics.service')}
            value={service} onChangeText={setService} autoCapitalize="none" />
        </FieldItem>
        <FieldItem label={t('common.version')} style={styles.fact}>
          <FieldTextInput testID="project-deployments.telemetry.llm.version" accessibilityLabel={t('common.version')}
            value={version} onChangeText={setVersion} autoCapitalize="none" />
        </FieldItem>
      </View>
      <View style={styles.note}>
        <TextLinkButton testID="project-deployments.telemetry.llm.applyFilters" label={t('common.apply')} disabled={!selectionChanged}
          onPress={() => {
            onSelect({ ...(serviceName ? { serviceName } : {}), ...(serviceVersion ? { serviceVersion } : {}) });
          }} />
      </View>
    </ItemGroup>
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
  const coverage = totals?.coverage ?? null;
  const routes = priced?.usage.routeBreakdown ?? [];
  const routeRows = routes.map((entry, index) => ({
    id: entry.key,
    label: entry.label ?? entry.key,
    value: resolveUsageCostBasis(entry.cost, 'api_equivalent')?.amountUsd ?? null,
    annotation: t('deploymentTelemetry.llm.tokens', { count: formatTokenCount(entry.tokens.total ?? null, locale) }),
    color: usageMeterFill(theme, index === 0),
  }));
  const card = (testID: string, title: string | null, children: React.ReactNode) => (
    <WidgetFrame testID={testID} frameStyle="card" placement="home" rows={0} title={title}
      body={{ kind: 'content', children }} />
  );
  const usageCard = (id: 'usage_cost_facts' | 'usage_daily', testID: string, title: string | null) => card(`${testID}.frame`, title,
    facts ? <UsageWidgetBody id={id} input={NO_INPUT} serverId={facts.authority.serverId} testID={testID} facts={facts} /> : (
      <SurfaceStateCard testID={`${testID}.reading`} kind="loading" size="line" title={t('deploymentTelemetry.llm.reading')} />
    ));
  return (
    <View style={styles.body} testID="project-deployments.telemetry.llm">
      {filters}
      {usageCard('usage_cost_facts', 'project-deployments.telemetry.llm.costFacts', null)}
      {usageCard('usage_daily', 'project-deployments.telemetry.llm.daily', t('deploymentTelemetry.llm.dailyCost'))}
      {routeRows.length > 0 ? card('project-deployments.telemetry.llm.routes.frame', t('deploymentTelemetry.llm.byRoute'),
        <UsageBreakdownsBody theme={chartTheme} spacing={theme.space} testID="project-deployments.telemetry.llm.routes" model={{
          namedByCard: true,
          blocks: [{
            id: 'route', label: t('deploymentTelemetry.llm.byRoute'), rows: routeRows, unknownLabel: '—',
            testID: 'project-deployments.telemetry.llm.routes.rows',
            valueFormatter: value => formatUsageCost(value, 'USD', locale),
          }],
        }} />) : null}
      {coverage && (coverage.lostObservations > 0 || coverage.reason !== null) ? (
        <Text variant="meta" style={[styles.quiet, styles.partial]} testID="project-deployments.telemetry.llm.partial">
          {t('deploymentTelemetry.measurement.partial')}
        </Text>
      ) : null}
      <CaptureAppLlmCalls
        items={calls?.value ?? []}
        loading={reading}
        locale={locale}
        onOpen={onOpenCall}
      />
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

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s16 },
  facts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space.s24,
    rowGap: theme.space.s16,
    paddingVertical: theme.space.s16,
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
  },
  fact: { flexGrow: 1, flexBasis: 160, minWidth: 0 },
  quiet: { color: theme.colors.text.secondary },
  partial: { paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
  // The note stands on the cards' text edge, as the lab's footnote does.
  note: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s16, paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
  noteText: { flex: 1, minWidth: 0 },
}));
