import * as React from 'react';
import {
  scaleTextStyleMetrics,
  usePluginAccessibility,
  usePluginTheme,
} from '@happier-dev/plugin-ui';

import {
  resolveTriageDetailPaneMinimumWidthV1,
  resolveTriageListPaneMinimumWidthV1,
  type TriageScaledTypeMetricsV1,
} from './layout.js';

/**
 * The reader's own type size applied to the host's four measured text roles.
 *
 * The scaling itself belongs to `plugin-ui`'s canonical text-scale owner, the
 * same one every `Text` on this page goes through. Multiplying the host's
 * typography here instead would be a second text-scale decision, and the two
 * would disagree the first time either rounded differently — with the pane
 * minima quietly measuring a size nothing on screen is drawn at.
 */
function readTriageScaledTypeMetricsV1(
  typography: ReturnType<typeof usePluginTheme>['typography'],
  textScale: number,
): TriageScaledTypeMetricsV1 {
  return {
    title: scaleTextStyleMetrics(typography.title, textScale),
    body: scaleTextStyleMetrics(typography.body, textScale),
    caption: scaleTextStyleMetrics(typography.caption, textScale),
    label: scaleTextStyleMetrics(typography.label, textScale),
  };
}

/**
 * The list and detail pane minima at the reader's text size: where the list page splits, and so where an entry
 * opened on its own page stops being the pushed detail.
 */
export function useTriagePaneMinimumWidthsV1(): Readonly<{
  minListWidth: number;
  minDetailWidth: number;
}> {
  const theme = usePluginTheme();
  const { textScale } = usePluginAccessibility();
  const scaledType = React.useMemo(
    () => readTriageScaledTypeMetricsV1(theme.typography, textScale),
    [textScale, theme.typography],
  );
  const paneMeasure = { type: scaledType, spacing: theme.spacing };
  return {
    minListWidth: resolveTriageListPaneMinimumWidthV1(paneMeasure),
    minDetailWidth: resolveTriageDetailPaneMinimumWidthV1(paneMeasure),
  };
}
