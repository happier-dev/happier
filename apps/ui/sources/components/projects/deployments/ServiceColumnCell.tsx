import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { StackedSeriesChart, type HappierSeries } from '@happier-dev/plugin-ui/presentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';
import type { DeploymentEnvironmentResourceColumn } from './deploymentEnvironmentColumns';
import { useServiceColumnValue } from './ServiceColumnResources';
import { serviceCheckWindowEnds } from './serviceCheckPresentation';

/** A scalar and its picture. The tooltip and accessible text preserve the producer's full value and window. */
export function ServiceColumnCell(props: Readonly<{ column: DeploymentEnvironmentResourceColumn;
  environmentId: string; collectorMachineId: string | null }>) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const value = useServiceColumnValue({ ...props, pluginId: props.column.pluginId, field: props.column.field });
  const locale = getPreferredLanguage();
  const scalar = value?.value;
  const text = scalar === null || scalar === undefined ? '—' : typeof scalar === 'number'
    ? new Intl.NumberFormat(locale, { maximumSignificantDigits: 21 }).format(scalar) : Array.isArray(scalar) ? scalar.join(', ') : String(scalar);
  const measurement = value?.measurement;
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
  const series = React.useMemo((): readonly HappierSeries[] => [{ id: props.column.key, label: props.column.title,
    color: theme.colors.text.secondary, points: (value?.trend ?? []).map(interval => ({
      id: `${interval.since}:${interval.until}`, x: interval.until, y: interval.value ?? null,
    })) }], [props.column.key, props.column.title, theme.colors.text.secondary, value?.trend]);
  const line = series[0]!.points.filter(point => point.y !== null).length >= 2;
  return <Tooltip label={label} accessibilityLabel={label}>
    {/* One line, as the column reads down (lab p8Columns selected, LAB-P7 Services 1A): the trend, then its figure. */}
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8,
        justifyContent: props.column.align === 'end' ? 'flex-end' : 'flex-start' }}>
      {line ? <StackedSeriesChart theme={pluginTheme} label={props.column.title} series={series} variant="line" size="inline"
        decorative showAxis={false} showGrid={false} showScaleValues={false} fitLine width={84} /> : null}
      <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary, ...Typography.tabular() }}
        numberOfLines={1}>{text}</Text>
    </View>
  </Tooltip>;
}
