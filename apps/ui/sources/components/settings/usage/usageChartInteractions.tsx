import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { ChartInteractionProvider, type HappierChartDatumRenderer } from '@happier-dev/plugin-ui/presentation';

import { ChartTooltip } from '@/components/ui/charts';
import { usageSignatureAccent } from './usageAccent';

/** The same tooltip owner used by Daily and Rhythm, bound once for every Usage widget surface. */
export function UsageChartInteractions(props: Readonly<{ children: React.ReactNode }>) {
    const { theme } = useUnistyles();
    const accent = usageSignatureAccent(theme);
    const renderDatum = React.useCallback<HappierChartDatumRenderer>((datum, visual, testID, renderTrigger) =>
        <ChartTooltip title={datum.label} value={datum.value} subtitle={datum.subtitle} accentColor={datum.color ?? accent}
            triggerTestID={testID} keyboard={datum.keyboard} renderTrigger={renderTrigger}>
            {visual}
        </ChartTooltip>, [accent]);
    return <ChartInteractionProvider renderDatum={renderDatum}>{props.children}</ChartInteractionProvider>;
}
