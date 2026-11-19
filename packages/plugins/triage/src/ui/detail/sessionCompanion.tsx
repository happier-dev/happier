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

import { parseTriageEntryDetailLaunchInput } from '../../composer/entryDetailLaunchInput.js';
import type { TriageListLaneV1 } from '../../projection/listWindow.js';
import { parseTriageRouteSubPathV1 } from '../navigation/location.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { useTriageEntryDetail } from './useTriageEntryDetail.js';
import { useTriagePostMutationRow } from './useTriagePostMutationRow.js';
import { TriageSessionPanel } from './sessionPanel.js';

const EMPTY_LANES: readonly TriageListLaneV1[] = Object.freeze([]);

/**
 * The entry's linked Session beside its story (Plan T `both`): the detail's Session item opens this companion,
 * so the live chat sits next to the entry instead of replacing it.
 *
 * The opening page supplies its admitted selection privately through `openedFrom`. The location
 * confirms which entry the page is showing. The pane uses the existing exact entry and linked Session
 * readers, so it does not need its own list window or connection selection.
 */
function TriageEntrySessionCompanion(): React.ReactElement {
  const { openedFrom } = useSurfaceContext();
  const subPath = openedFrom?.subPath ?? null;
  const launchInput = openedFrom?.launchInput;
  const selection = React.useMemo(() => {
    const entryRef = parseTriageRouteSubPathV1(subPath ?? undefined).selection;
    const parsed = parseTriageEntryDetailLaunchInput(launchInput);
    if (entryRef === null || parsed.status !== 'valid' || !sameTriageEntryRefV1(entryRef, parsed.input.entryRef)) return null;
    return { sectionId: null, entryRef, sourceInstanceId: parsed.input.sourceInstance.sourceInstanceId };
  }, [launchInput, subPath]);
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

  if (selection === null) {
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
