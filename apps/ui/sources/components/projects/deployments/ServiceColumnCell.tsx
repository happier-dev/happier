import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { AdmittedPluginListFilterFieldV1 } from '@happier-dev/plugin-sdk/ui';
import { Text } from '@/components/ui/text/Text';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';
import { formatMomentRange } from '@/utils/datetime/formatMoment';
import type { DeploymentEnvironmentBylineFact, DeploymentEnvironmentResourceColumn } from './deploymentEnvironmentColumns';
import { useServiceColumnValue, type ServiceColumnValue } from './ServiceColumnResources';
import { formatServiceCheckLatency, formatServiceCheckShare } from './serviceCheckPresentation';
import { ServiceTrendChart } from './ServiceTrendChart';

/**
 * The one readout of a contributed Services fact, for a column cell and a folded byline fact alike: its title, the
 * producer's full value and unit, where it comes from, its window and producers, and how complete the measurement is.
 */
export function serviceFieldReadout(fact: Pick<DeploymentEnvironmentBylineFact, 'title' | 'source'> & Readonly<{
  field: AdmittedPluginListFilterFieldV1 }>, value: ServiceColumnValue | null, locale: string, nowMs: number): string {
  const scalar = value?.value;
  const declared = fact.field.declaration.value;
  const full = new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 });
  const fullValue = scalar === null || scalar === undefined ? t('common.unavailable')
    : typeof scalar === 'number' && declared.kind === 'number'
      ? declared.unit === '1' ? new Intl.NumberFormat(locale, { style: 'percent', maximumSignificantDigits: 21 }).format(scalar)
        : declared.unit === '{request}' ? t('projects.deployments.monitoring.keyFlowRequests', { count: scalar, formatted: full.format(scalar) })
          : declared.unit === '{issue}' ? full.format(scalar) : `${full.format(scalar)} ${declared.unit}`
      : Array.isArray(scalar) ? scalar.join(', ') : String(scalar);
  const measurement = value?.provenance;
  // Producers are named by service and version; an instance id is the collector's key, and its replicas are one producer.
  const producers = measurement ? new Set(measurement.producers.map(producer =>
    [producer.serviceName, producer.serviceVersion].filter(Boolean).join(' · '))) : null;
  return [`${fact.title} ${fullValue}`, fact.source,
    ...(measurement && producers ? [formatMomentRange(measurement.window.since, measurement.window.until, nowMs),
      ...producers,
      ...(measurement.basis === 'sampled_spans' || measurement.basis === 'mixed_telemetry' ? [t('deploymentTelemetry.measurement.sampled')] : []),
      ...(measurement.completeness === 'partial' ? [t('deploymentTelemetry.measurement.partial')]
        : measurement.completeness === 'unknown' ? [t('deploymentTelemetry.measurement.unknown')] : [])] : [])].filter(Boolean).join(' · ');
}

/** A scalar and its picture. The readout (hover, focus, long press) and accessible text carry the full value and window. */
export function ServiceColumnCell(props: Readonly<{ column: DeploymentEnvironmentResourceColumn;
  environmentId: string; collectorMachineId: string | null }>) {
  const { theme } = useUnistyles();
  const value = useServiceColumnValue({ ...props, pluginId: props.column.pluginId, field: props.column.field });
  const locale = getPreferredLanguage();
  const scalar = value?.value;
  const text = scalar === null || scalar === undefined ? '—' : typeof scalar === 'number'
    ? new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 }).format(scalar) : Array.isArray(scalar) ? scalar.join(', ') : String(scalar);
  const label = serviceFieldReadout(props.column, value, locale, Date.now());
  const points = React.useMemo(() => (value?.trend ?? []).map(interval => ({
    id: String(interval.at), x: interval.at, y: interval.value,
  })), [value?.trend]);
  return <Tooltip label={label} accessibilityLabel={label}>
    {/* One line, as the column reads down (lab p8Columns selected, LAB-P7 Services 1A): the trend, then its figure. */}
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8,
        justifyContent: props.column.align === 'end' ? 'flex-end' : 'flex-start' }}>
      <ServiceTrendChart seriesId={props.column.key} label={props.column.title} color={theme.colors.text.secondary} points={points} />
      <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary, ...Typography.tabular() }}
        numberOfLines={1}>{text}</Text>
    </View>
  </Tooltip>;
}

/**
 * A fact folded into a row's second line ("Latency 182 ms"): the compact figure on the line, the full readout through
 * the shared tooltip on hover, keyboard focus and a long press. A tap still opens the row's Environment (`onOpen`).
 */
export function ServiceBylineFact(props: Readonly<{ fact: DeploymentEnvironmentBylineFact;
  environmentId: string; collectorMachineId: string | null; testID?: string; onOpen?: () => void }>) {
  const value = useServiceColumnValue({ ...props, pluginId: props.fact.pluginId, field: props.fact.field, includeTrend: false });
  const { theme } = useUnistyles();
  const locale = getPreferredLanguage();
  const scalar = value?.value;
  if (scalar == null) return null;
  const declared = props.fact.field.declaration.value;
  const text = typeof scalar === 'number' && declared.kind === 'number'
    ? declared.unit === 'ms' ? formatServiceCheckLatency(scalar)
      : declared.unit === '1' ? formatServiceCheckShare(scalar)
        : declared.unit === '{issue}' ? new Intl.NumberFormat(locale).format(scalar)
          : `${new Intl.NumberFormat(locale).format(scalar)} ${declared.unit}`
    : Array.isArray(scalar) ? scalar.join(', ') : String(scalar);
  const readout = serviceFieldReadout(props.fact, value, locale, Date.now());
  // The fact keeps its own width and gives way last: the deploy text before it ellipsizes first (lab phone row).
  return <Tooltip testID={props.testID} label={readout} accessibilityLabel={readout} onPress={props.onOpen}
    style={{ flexShrink: 0, minWidth: 0 }}>
    <Text variant="meta" style={{ color: theme.colors.text.secondary, ...Typography.tabular() }}
      numberOfLines={1}>{`${props.fact.title} ${text}`}</Text>
  </Tooltip>;
}
