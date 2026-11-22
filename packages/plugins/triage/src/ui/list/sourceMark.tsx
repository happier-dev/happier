import * as React from 'react';
import { BrandMark } from '@happier-dev/plugin-ui';
import { REVIEW_TRIAGE_SOURCE_V1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_ISSUE_WATCH_SOURCES_V1 } from '@happier-dev/triage-sources/runtime';

import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';

/**
 * Where an entry lives, as a mark: the source's own brand (GitHub, Linear, Sentry), or Happier's mark for an entry
 * Happier holds itself (a personal task, a Review), never the Triage plugin's pull-request glyph. Every list row, detail line
 * and picker row reads its source mark here. Decorative: the place label beside it names the source.
 */
export function TriageSourceMark(props: Readonly<{
  source: Readonly<{ pluginId: string; localId?: string }>;
  pixelSize?: number;
}>): React.ReactElement {
  const { source } = props;
  // Happier holds tasks and Reviews itself (both under the Triage plugin's id), and its own exceptions (the telemetry
  // plugin's Account-data source), so all three wear Happier's mark rather than a letter for a plugin with no brand.
  const exceptions = TRIAGE_ISSUE_WATCH_SOURCES_V1.telemetry;
  const happier = (source.pluginId === INTERNAL_TASK_SOURCE_V1.pluginId
    && (source.localId === undefined || source.localId === INTERNAL_TASK_SOURCE_V1.localId
      || (source.pluginId === REVIEW_TRIAGE_SOURCE_V1.pluginId && source.localId === REVIEW_TRIAGE_SOURCE_V1.localId)))
    || (source.pluginId === exceptions.pluginId && (source.localId === undefined || source.localId === exceptions.localId));
  return happier
    ? <BrandMark host size="small" externallyLabelled {...(props.pixelSize === undefined ? {} : { pixelSize: props.pixelSize })} />
    : <BrandMark pluginId={source.pluginId} size="small" externallyLabelled
      {...(props.pixelSize === undefined ? {} : { pixelSize: props.pixelSize })} />;
}
