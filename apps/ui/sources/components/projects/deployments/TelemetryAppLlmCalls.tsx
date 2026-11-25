import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DatabaseCaptureCostsReadResultV1 } from '@happier-dev/database-protocol';
import {
  CaptureAppLlmCalls,
  type CaptureAppLlmCallV1,
} from '@happier-dev/plugins-telemetry/capture-views';
import type { PluginUiResourceProjection } from '@happier-dev/plugin-ui/hostApi';
import { HappierDataMetric } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachineServiceResource } from '@/components/machines/resources/useMachineServiceResource';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';

import {
  readTelemetryCaptureCostsSnapshot,
  readTelemetryCaptureListSnapshot,
  TelemetryCaptureTransportContext,
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

/** The window's totals as the costs Action typed them: calls, tokens and each currency the provider reported. */
function summarize(totals: Totals) {
  let tokens = 0;
  let tokensKnown = false;
  const reported = new Map<string, number>();
  for (const item of totals.items) {
    const total = item.tokens.total ?? null;
    if (total !== null) {
      tokens += total;
      tokensKnown = true;
    }
    if (item.reportedCost)
      reported.set(
        item.reportedCost.currency,
        (reported.get(item.reportedCost.currency) ?? 0) +
          item.reportedCost.amount,
      );
  }
  return { tokens: tokensKnown ? tokens : null, reported: [...reported] };
}

/**
 * Telemetry → LLM calls (P7 J4): the window's model calls as the collector's costs Action totals them, with what the
 * provider reported and for how many calls, then each retained call; a call opens its own trace. The catalog estimate
 * at the viewer's own prices is Usage's (Your apps), one press away: this view never prices a second time.
 */
export function TelemetryAppLlmCalls(
  props: Readonly<{
    reads: TelemetryCaptureReads;
    lifetime: ServerAccountScopeLifetime | null;
    active: boolean;
    windowMs: number;
    locale: string;
    selection: TelemetryAppLlmCallSelection;
    onSelect: (selection: TelemetryAppLlmCallSelection) => void;
    onOpenCall: (call: CaptureAppLlmCallV1) => void;
  }>,
) {
  const { reads, lifetime, active, windowMs, locale, selection, onSelect, onOpenCall } = props;
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
  if (failure) {
    return (
      <View style={styles.body} testID="project-deployments.telemetry.llm">
        {filters}
        <SurfaceStateCard
          testID="project-deployments.telemetry.llm.unavailable"
          kind="unavailable"
          size="line"
          title={t('deploymentTelemetry.llm.unavailable')}
          diagnosticCode={failure.code ?? 'telemetry_unavailable'}
          action={{
            label: t('common.retry'),
            onPress: () => { void Promise.all([costs?.refresh(), calls?.refresh()]); },
          }}
        />
      </View>
    );
  }
  const ready = costs?.value && calls?.value ? { totals: costs.value, calls: calls.value } : null;
  const summary = ready ? summarize(ready.totals) : null;
  const coverage = ready?.totals.coverage ?? null;
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  const reportedValue =
    summary && summary.reported.length > 0
      ? summary.reported
          .map(([currency, amount]) =>
            formatUsageCost(amount, currency, locale),
          )
          .join(' + ')
      : '—';
  const reportedCaption = !coverage
    ? ''
    : coverage.reportedCostCallCount === 0
      ? t('deploymentTelemetry.llm.reportedNone')
      : t('deploymentTelemetry.llm.reportedFor', {
          reported: count(coverage.reportedCostCallCount),
          calls: count(coverage.callCount),
        });
  const partial =
    coverage && (coverage.lostObservations > 0 || coverage.reason !== null);
  return (
    <View style={styles.body} testID="project-deployments.telemetry.llm">
      {filters}
      <ItemGroup testID="project-deployments.telemetry.llm.totals">
        <View style={styles.facts}>
          <View style={styles.fact}>
            <HappierDataMetric
              testID="project-deployments.telemetry.llm.calls"
              theme={chartTheme}
              size="stat"
              showLabel
              label={t('deploymentTelemetry.llm.calls')}
              value={coverage ? count(coverage.callCount) : ''}
              pending={!ready}
              caption={
                summary
                  ? t('deploymentTelemetry.llm.tokens', {
                      count: formatTokenCount(summary.tokens, locale),
                    })
                  : ''
              }
            />
          </View>
          <View style={styles.fact}>
            <HappierDataMetric
              testID="project-deployments.telemetry.llm.reported"
              theme={chartTheme}
              size="stat"
              showLabel
              label={t('deploymentTelemetry.llm.reported')}
              value={ready ? reportedValue : ''}
              pending={!ready}
              caption={reportedCaption}
            />
          </View>
        </View>
        {partial ? (
          <Text
            variant="meta"
            style={[styles.quiet, styles.partial]}
            testID="project-deployments.telemetry.llm.partial"
          >
            {t('deploymentTelemetry.measurement.partial')}
          </Text>
        ) : null}
      </ItemGroup>
      <CaptureAppLlmCalls
        items={ready?.calls ?? []}
        loading={!ready}
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
  partial: { paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx, paddingBottom: theme.space.s16 },
  // The note stands on the cards' text edge, as the lab's footnote does.
  note: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s16, paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
  noteText: { flex: 1, minWidth: 0 },
}));
