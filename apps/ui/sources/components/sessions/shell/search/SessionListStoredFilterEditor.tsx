import * as React from 'react';

import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { buildSessionListFilterEditorLabels } from './SessionListFilterControl';
import { SessionListFilterEditor } from './SessionListFilterEditor';
import {
  removeUnavailableSessionListFilterSelections,
  type SessionListViewFilters,
} from './sessionListViewFilters';
import {
  fromStoredSessionListFilter,
  toStoredSessionListFilter,
} from './storedSessionListFilter';
import { useSessionListFilterEditorOptions } from './useSessionListFilterEditorOptions';

/**
 * The Sessions list's own filter editor bound to a stored selector on one Home, for a step that edits a filter
 * the list doesn't own (the composer's Matching, a Follow rule). It shows Sessions only; the footer says whom the
 * filter reaches now and its action keeps the filter, never the rows it shows.
 */
export function SessionListStoredFilterEditor(
  props: Readonly<{
    serverId: string;
    filter: SessionListFilterV1;
    onFilterChange: (next: SessionListFilterV1) => void;
    /** Where Reset goes: the step's own starting filter. */
    onReset: () => void;
    /** One line: whom it reaches now, or why that isn't known. */
    summary: string;
    doneLabel: string;
    canDone: boolean;
    onDone: () => void;
    maxHeight?: number;
  }>,
) {
  const { onFilterChange, serverId } = props;
  const mounted = React.useMemo(() => [serverId], [serverId]);
  const fixedHomes = React.useMemo(() => new Set(mounted), [mounted]);
  const filters = React.useMemo(
    () => fromStoredSessionListFilter(props.filter, mounted),
    [mounted, props.filter],
  );
  const options = useSessionListFilterEditorOptions(
    mounted,
    filters.homeServerIds,
  );
  const latest = React.useRef(filters);
  latest.current = filters;
  const save = React.useCallback(
    (next: SessionListViewFilters) =>
      onFilterChange(toStoredSessionListFilter(next)),
    [onFilterChange],
  );
  const labels = React.useMemo(
    () => ({ ...buildSessionListFilterEditorLabels(), done: props.doneLabel }),
    [props.doneLabel],
  );

  return (
    <SessionListFilterEditor
      {...options}
      filters={filters}
      includeInactive={false}
      inactiveVisibilityAvailable={false}
      fixedShow="sessions"
      evaluator="daemonRule"
      fixedHomeServerIds={fixedHomes}
      labels={labels}
      updateFilters={save}
      removeAuthoritativelyDeletedSelections={(deleted) => {
        const next = removeUnavailableSessionListFilterSelections(
          latest.current,
          deleted,
        );
        if (next !== latest.current) save(next);
      }}
      setIncludeInactive={noop}
      setSource={(source) => save({ ...latest.current, source })}
      resetFilters={props.onReset}
      resultSummary={props.summary}
      onDone={props.onDone}
      doneDisabled={!props.canDone}
      maxHeight={props.maxHeight}
    />
  );
}

function noop() {}
