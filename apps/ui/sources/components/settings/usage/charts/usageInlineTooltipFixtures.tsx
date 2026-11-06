import type { ReactElement } from 'react';
import { BurnUpChart, HappierDataMetric, HappierDataRows, IntervalTimeline, OutcomeScatter } from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { lightTheme } from '@/theme';
import { formatTokenCount } from '@/utils/format/usageNumbers';

const theme = projectPluginUiTheme(lightTheme);

/** Real public renderers for the shared ChartTooltip + Popover input-modality contract. */
export const usageInlineTooltipFixtures: readonly Readonly<{ name: string; value: string; body: ReactElement }>[] = [
  { name: 'Inline metric precision', value: '4,186,010 tokens', body: <HappierDataMetric theme={theme}
    testID="inline-metric" label="Tokens" value={4186010} unit="tokens" valueFormatter={formatTokenCount} /> },
  { name: 'Ranked row precision', value: '4,186,010', body: <HappierDataRows theme={theme}
    testID="inline-rows" label="Projects" columns={[{ label: 'Project' }, { label: 'Tokens', proportion: true }]}
    rows={[[ 'Glass', 4186010 ]]} valueFormatter={formatTokenCount} showProportionShares={false} /> },
  { name: 'Scatter point precision', value: 'Tokens: 4.2M (4,186,010) · Merged: 2', body: <OutcomeScatter theme={theme}
    testID="inline-scatter" label="Session value" xLabel="Tokens" yLabel="Merged" formatX={formatTokenCount}
    geometry={{ width: 500, height: 320 }} points={[{ id: 'a', label: 'Audit', x: 4186010, y: 2 }, { id: 'b', label: 'Docs', x: 1, y: 0 }]} /> },
  { name: 'Timeline event precision', value: 'Weekly, Start: 12', body: <IntervalTimeline theme={theme}
    testID="inline-timeline" label="Resets" domain={{ start: 0, end: 24 }} geometry={{ width: 500, height: 160 }}
    intervals={[{ id: 'reset', kind: 'point', label: 'Weekly', start: 12, end: 12 }]} /> },
  { name: 'Unadapted series precision', value: 'Used: 12% (12.345)', body: <BurnUpChart theme={theme}
    testID="inline-series" label="Allowance" width={320} size="full" valueFormatter={value => `${Math.round(value)}%`}
    series={[{ id: 'used', label: 'Used', points: [{ id: 'mon', x: 'Mon', y: 12.345 }, { id: 'tue', x: 'Tue', y: 25 }] }]} /> },
];
