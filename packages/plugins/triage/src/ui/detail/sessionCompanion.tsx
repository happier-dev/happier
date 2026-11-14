import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  defineUiSurface,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

import { sameTriageSourceIdentity } from '../../corpus/identity/components.js';
import { selectObservationInstance } from '../../corpus/selection/selectObservationInstance.js';
import type { TriageListLaneV1 } from '../../projection/listWindow.js';
import { useTriageConfiguredSources } from '../configuration/useTriageConfiguredSources.js';
import { parseTriageRouteSubPathV1 } from '../navigation/location.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { useTriageEntryDetail } from './useTriageEntryDetail.js';
import { useTriagePostMutationRow } from './useTriagePostMutationRow.js';
import { TriageSessionPanel } from './sessionPanel.js';

const EMPTY_LANES: readonly TriageListLaneV1[] = Object.freeze([]);

/**
 * The entry's linked Session beside its story (Plan T `both`): the detail's Session item opens this companion,
 * so the live chat sits next to the entry instead of replacing it.
 *
 * It decides nothing of its own. Which entry comes from the opening page's current location (the host's
 * `openedFrom`, read through Triage's one route codec). The page's selected connection travels with it; older
 * identity-only locations use configured-source admission. The entry itself is the one exact read the
 * page uses for an entry outside its window, and its linked Sessions come from the detail's one reader. It reads
 * no list: the side pane shares no window with the page and must not walk one.
 */
function TriageEntrySessionCompanion(): React.ReactElement {
  const { openedFrom } = useSurfaceContext();
  const subPath = openedFrom?.subPath ?? null;
  const route = React.useMemo(
    () =>
      parseTriageRouteSubPathV1(subPath ?? undefined),
    [subPath],
  );
  const entryRef = route.selection;
  const configured = useTriageConfiguredSources();
  const selection = React.useMemo(() => {
    if (entryRef === null) return null;
    // The page already selected this exact connection; never substitute another when it disappears.
    if (route.selectionSourceInstanceId !== undefined) {
      return { sectionId: null, entryRef, sourceInstanceId: route.selectionSourceInstanceId };
    }
    const active = configured.sources
      .filter((source) => sameTriageSourceIdentity(source.configured.instance.source, entryRef.source))
      .map((source) => source.sourceInstanceId);
    const selected = selectObservationInstance([], active, null, { allowUnobserved: true });
    return selected.kind === 'none'
      ? null
      : { sectionId: null, entryRef, sourceInstanceId: selected.sourceInstanceId };
  }, [configured.sources, entryRef, route.selectionSourceInstanceId]);
  const { row, readFailed } = useTriagePostMutationRow(null, EMPTY_LANES, selection);
  const source = React.useMemo(() => {
    const selected =
      row === null ? null : readTriageSelectedObservationV1(row);
    return row === null || selected === null
      ? null
      : {
          selection: {
            entryRef: row.entryRef,
            sourceInstanceId: selected.sourceInstanceId,
            ...(selected.sourceInstanceRowId === undefined
              ? {}
              : { sourceInstanceRowId: selected.sourceInstanceRowId }),
          },
          observation: selected.observation,
        };
  }, [row]);
  const detail = useTriageEntryDetail(source);

  if (entryRef === null || (configured.loaded && selection === null)) {
    return (
      <EmptyState
        titleKey="plugins.triage.surface.detail.session.companion.noEntry"
        title="Open an entry to follow its Session here."
      />
    );
  }
  if (readFailed && detail === null) {
    return (
      <ErrorState
        titleKey="plugins.triage.surface.detail.accountError.title"
        title="These details could not be read"
      />
    );
  }
  if (detail === null || detail.kind === 'reading') {
    return (
      <LoadingState
        layout="line"
        titleKey="plugins.triage.surface.detail.reading"
        title="Reading this entry"
      />
    );
  }
  if (detail.kind === 'unreachable') {
    return (
      <ErrorState
        titleKey="plugins.triage.surface.detail.accountError.title"
        title="These details could not be read"
        descriptionKey="plugins.triage.surface.detail.accountError.description"
        description="This entry's details are unavailable right now. Try again when the connection is available."
        action={
          detail.failure?.retryable === false ? undefined : (
            <Button
              titleKey="plugins.triage.surface.actions.retry"
              title="Retry"
              variant="secondary"
              onPress={detail.retry}
            />
          )
        }
      />
    );
  }
  if (detail.kind === 'unavailable') {
    return (
      <EmptyState
        titleKey="plugins.triage.surface.detail.removedConnection.title"
        title="This connection is no longer configured"
      />
    );
  }
  if (detail.kind === 'refused') {
    return (
      <EmptyState
        titleKey="plugins.triage.surface.detail.prepareError.title"
        title="These details could not be prepared"
      />
    );
  }
  if (detail.linkedSessions.length === 0) {
    return (
      <EmptyState
        titleKey="plugins.triage.surface.detail.session.companion.none"
        title="No Session is linked to this entry."
      />
    );
  }
  return (
    <TriageSessionPanel
      sessions={detail.linkedSessions}
      entryRef={detail.input.observation.entryRef}
      sourceInstanceId={detail.input.instance.instance.sourceInstanceId}
      onUnlinked={detail.refreshLinkedSessions}
      continuation={{ hasMore: detail.linkedSessionsNextCursor !== undefined,
        pageState: detail.linkedSessionsPageState, onLoadMore: detail.loadMoreLinkedSessions }}
      header="pane"
    />
  );
}

export const renderSurface: RenderSurface = defineUiSurface(
  TriageEntrySessionCompanion,
);
