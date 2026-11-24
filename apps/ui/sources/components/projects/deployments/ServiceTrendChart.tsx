import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { StackedSeriesChart, type HappierSeries } from '@happier-dev/plugin-ui/presentation';

import { vitalsAreaWash } from '@/components/machines/vitals/vitalsFormat';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

/** The decorative trend beside a service fact. Its adjacent readout carries the value and context. */
export const ServiceTrendChart = React.memo(function ServiceTrendChart(props: Readonly<{
  seriesId: string;
  label: string;
  points: HappierSeries['points'];
  color: string;
  form?: 'line' | 'area';
  width?: number;
}>) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const { color, form = 'line', label, points, seriesId, width = 84 } = props;
  const fillOpacity = form === 'area' ? vitalsAreaWash(theme.dark) : undefined;
  const series = React.useMemo((): readonly HappierSeries[] | null => {
    if (points.filter(point => point.y !== null).length < 2) return null;
    return [{ id: seriesId, label, color, points, ...(fillOpacity === undefined ? {} : { fillOpacity }) }];
  }, [color, fillOpacity, label, points, seriesId]);
  if (!series) return null;
  return (
    <StackedSeriesChart
      theme={pluginTheme}
      label={label}
      series={series}
      variant={form}
      size={form === 'area' ? 'tile' : 'inline'}
      decorative
      showAxis={false}
      showGrid={false}
      showScaleValues={false}
      fitLine
      {...(form === 'line' ? { width } : {})}
    />
  );
});
