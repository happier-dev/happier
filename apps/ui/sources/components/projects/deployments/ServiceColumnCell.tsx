import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';
import type { DeploymentEnvironmentBylineFact, DeploymentEnvironmentResourceColumn } from './deploymentEnvironmentColumns';
import { useServiceColumnValue } from './ServiceColumnResources';
import { formatServiceCheckLatency, formatServiceCheckShare, serviceCheckWindowEnds } from './serviceCheckPresentation';
import { ServiceTrendChart } from './ServiceTrendChart';

/** A scalar and its picture. The tooltip and accessible text preserve the producer's full value and window. */
export function ServiceColumnCell(props: Readonly<{ column: DeploymentEnvironmentResourceColumn;
  environmentId: string; collectorMachineId: string | null }>) {
  const { theme } = useUnistyles();
  const value = useServiceColumnValue({ ...props, pluginId: props.column.pluginId, field: props.column.field });
  const locale = getPreferredLanguage();
  const scalar = value?.value;
  const text = scalar === null || scalar === undefined ? '—' : typeof scalar === 'number'
    ? new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 }).format(scalar) : Array.isArray(scalar) ? scalar.join(', ') : String(scalar);
  const measurement = value?.provenance;
  const declared = props.column.field.declaration.value;
  const fullValue = scalar === null || scalar === undefined ? t('common.unavailable') : typeof scalar === 'number' && declared.kind === 'number'
    ? declared.unit === '{request}' ? t('projects.deployments.monitoring.keyFlowRequests', { count: scalar, formatted: text })
      : `${text} ${declared.unit}` : text;
  const windowEnds = measurement ? serviceCheckWindowEnds(measurement.window.since, measurement.window.until, Date.now()) : null;
  const label = [props.column.title, fullValue, props.column.source,
    ...(measurement && windowEnds ? [`${windowEnds[0]} – ${windowEnds[1]}`,
      ...measurement.producers.map(producer => [producer.serviceName, producer.serviceVersion, producer.serviceInstanceId].filter(Boolean).join(' · ')),
      ...(measurement.basis === 'sampled_spans' || measurement.basis === 'mixed_telemetry' ? [t('deploymentTelemetry.measurement.sampled')] : []),
      ...(measurement.completeness === 'partial' ? [t('deploymentTelemetry.measurement.partial')]
        : measurement.completeness === 'unknown' ? [t('deploymentTelemetry.measurement.unknown')] : [])] : [])].filter(Boolean).join(' · ');
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

export function ServiceBylineFact(props: Readonly<{ fact: DeploymentEnvironmentBylineFact;
  environmentId: string; collectorMachineId: string | null }>) {
  const value = useServiceColumnValue({ ...props, pluginId: props.fact.pluginId, field: props.fact.field });
  const { theme } = useUnistyles();
  const locale = getPreferredLanguage();
  const scalar = value?.value;
  if (scalar == null) return null;
  const declared = props.fact.field.declaration.value;
  const text = typeof scalar === 'number' && declared.kind === 'number'
    ? declared.unit === 'ms' ? formatServiceCheckLatency(scalar)
      : declared.unit === '1' ? formatServiceCheckShare(scalar)
        : `${new Intl.NumberFormat(locale).format(scalar)} ${declared.unit}`
    : Array.isArray(scalar) ? scalar.join(', ') : String(scalar);
  const label = `${props.fact.title} ${text}`;
  const measurement = value?.provenance;
  const windowEnds = measurement && serviceCheckWindowEnds(measurement.window.since, measurement.window.until, Date.now());
  const accessibilityLabel = [label, props.fact.source, windowEnds?.join(' – '),
    measurement?.basis === 'sampled_spans' ? t('deploymentTelemetry.measurement.sampled') : null,
    measurement?.completeness === 'partial' ? t('deploymentTelemetry.measurement.partial') : null,
  ].filter(Boolean).join(' · ');
  return <Text variant="meta" style={{ color: theme.colors.text.secondary }} accessibilityLabel={accessibilityLabel}
    numberOfLines={1}>{label}</Text>;
}
