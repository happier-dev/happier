import * as React from 'react';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  List,
  LoadingState,
  Row,
  Screen,
  Stack,
  Status,
  usePluginHostApi,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../../manifest.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import { TriageDetailRegion } from '../detail/region.js';
import { planTriageListSections } from '../list/sections.js';
import { renderTriageListRow } from '../list/rows.js';
import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import { useTriagePinnedEntries } from '../marks/useTriagePinnedEntries.js';
import {
  parseTriageRouteSubPathV1,
  readTriageRouteLensV1,
  writeTriageRouteLensV1,
} from '../navigation/location.js';
import {
  TRIAGE_SURFACE_INITIAL_STATE_V1,
  reduceTriageSurfaceV1,
  sameTriageEntryRefV1,
  type TriageSurfaceActionV1,
  type TriageSurfaceStateV1,
} from '../state/surface.js';
import { useTriageListWindow } from '../window/useTriageListWindow.js';
import { readTriageListEmptyState } from './emptyState.js';
import { resolveTriageListShellState } from './windowState.js';

/**
 * The mounted PRs & Issues shell.
 *
 * It composes already-projected facts and owns no provider I/O: the one window
 * store owns the passes, the pacing and the last-known-good retention, and this
 * file only decides what the reader is told about them. The two refresh
 * producers it wires are named ones — the mount itself, through the window hook,
 * and the explicit **Refresh** control. There is no timer, no interval and no
 * poller anywhere in this surface.
 *
 * It is also the one place the surface reducer and the route owner are actually
 * consumed. Row focus, keyboard traversal, the roving tab stop
 * and pointer activation all come from the shared `List`'s own selection owner;
 * this file turns the one activation it reports into the reducer's `rowActivated`
 * with the instance the window already qualified, and writes the resulting lens
 * back through the host's same-page replacement.
 *
 * A selection now mounts the detail region, which is what makes this a product
 * rather than a list. The composition is `core/SURFACE.md` §2.1's **stacked**
 * one: the list fills the region until a selection, and the selection replaces
 * it with the common header plus the source's own body. The split composition is
 * the same two children under a measured width, and it is the one part of §2.1
 * still missing — this surface has no measurement seam yet, and guessing a
 * desktop width is exactly what §2.1 forbids.
 *
 * The producer that was missing is now here: `entries/read-detail-v1` returns
 * the exact configured instance and the entry's Session links, which are the two
 * members of the strict detail input a mounted surface cannot reach on its own.
 * The third, the applied observation, is already in this mount's window.
 */

/** The lens fields a shareable location carries, as reducer seed values. */
function seedFromLocation(subPath: string | undefined): TriageSurfaceStateV1 {
  const lens = parseTriageRouteSubPathV1(subPath);
  return {
    ...TRIAGE_SURFACE_INITIAL_STATE_V1,
    grouping: lens.grouping,
    order: lens.order,
    search: { query: lens.query, composing: null },
  };
}

export type TriageListShellProps = Readonly<{
  /**
   * The host-owned plugin-local location this page was opened at. Triage owns
   * no router: this is read once as the reducer's seed and written back through
   * the one route owner.
   */
  subPath?: string;
}>;

export function TriageListShell(props: TriageListShellProps = {}): React.ReactElement {
  const hostApi = usePluginHostApi();
  const window = useTriageListWindow();
  const marks = useTriagePinnedEntries();
  const state = resolveTriageListShellState(window.snapshot);
  const [surface, dispatch] = React.useReducer(
    reduceTriageSurfaceV1,
    props.subPath,
    seedFromLocation,
  );
  const refresh = React.useCallback(() => window.refresh('manual'), [window]);

  // The named view producer (`core/CORPUS.md` §4.1). Mounting *this page* is
  // what asks for a pass; the window hook itself only reads, so the Composer
  // picker — which is not a producer — reaches nothing merely by opening
  // (`REQ-14`). The shared minimum interval still collapses this demand with
  // every other one from this mount.
  const demand = window.refresh;
  React.useEffect(() => {
    void demand('view');
  }, [demand]);
  const pinHandlers = React.useMemo(() => ({
    busyKey: marks.busyKey,
    unavailableReason: marks.unavailableReason,
    onSetPinned: marks.setPinned,
  }), [marks.busyKey, marks.setPinned, marks.unavailableReason]);

  const sections = React.useMemo(
    () => (state.kind === 'window'
      ? planTriageListSections({ rows: state.window.rows, pins: marks.pins })
      : []),
    [marks.pins, state],
  );
  const rowsByKey = React.useMemo(() => {
    const index = new Map<string, Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>>();
    for (const section of sections) {
      for (const row of section.data) index.set(row.key, { sectionId: section.key, row });
    }
    return index;
  }, [sections]);
  const rowCount = React.useMemo(
    () => sections.reduce((total, section) => total + section.data.length, 0),
    [sections],
  );

  /** Whether the reader has changed the lens yet; see `useTriageRouteBinding`. */
  const readerChangedLens = React.useRef(false);
  /**
   * The one activation path. The shared `List` reports pointer, touch and
   * keyboard activation through the same key, and a row the window could not
   * qualify carries no instance — selecting it would open somebody else's
   * connection, so it is refused rather than approximated.
   */
  const activateRow = React.useCallback((key: string) => {
    const hit = rowsByKey.get(key);
    if (hit === undefined || hit.row.sourceInstanceId === null) return;
    readerChangedLens.current = true;
    dispatch({
      kind: 'rowActivated',
      sectionId: hit.sectionId,
      entryRef: hit.row.entryRef,
      sourceInstanceId: hit.row.sourceInstanceId,
    });
  }, [rowsByKey]);

  const selectedKey = React.useMemo(() => {
    const selection = surface.selection;
    if (selection === null) return null;
    for (const [key, hit] of rowsByKey) {
      if (sameTriageEntryRefV1(hit.row.entryRef, selection.entryRef)) return key;
    }
    return null;
  }, [rowsByKey, surface.selection]);

  /**
   * The window row behind the selection.
   *
   * The detail region is composed from the projection row, not the display row:
   * the strict detail input needs the applied observation, and the display
   * projection deliberately keeps only what a list row shows.
   */
  const selectedRow = React.useMemo<TriageListRowV1 | null>(() => {
    const selection = surface.selection;
    if (selection === null || state.kind !== 'window') return null;
    return state.window.rows.find(
      (row) => sameTriageEntryRefV1(row.entryRef, selection.entryRef),
    ) ?? null;
  }, [state, surface.selection]);
  const selectedConnectionLabel = React.useMemo(() => {
    const selection = surface.selection;
    if (selection === null) return null;
    const summary = window.snapshot.configuredSources.find(
      (candidate) => candidate.sourceInstanceId === selection.sourceInstanceId,
    );
    return summary?.displayLabel ?? null;
  }, [surface.selection, window.snapshot.configuredSources]);

  const visibleOrder = React.useMemo(
    () => [...rowsByKey.values()].map((hit) => ({
      sectionId: hit.sectionId,
      entryRef: hit.row.entryRef,
    })),
    [rowsByKey],
  );
  const dismissDetail = React.useCallback(() => {
    readerChangedLens.current = true;
    dispatch({ kind: 'detailDismissed', visibleOrder });
  }, [visibleOrder]);

  useTriageRouteBinding(hostApi, surface, readerChangedLens);
  useTriageSettledLocation({
    subPath: props.subPath,
    surface,
    rowsByKey,
    dispatch,
    readerChangedLens,
  });

  if (state.kind === 'initial') {
    return (
      <Screen safeArea>
        <LoadingState title={`Reading ${TRIAGE_DISPLAY_NAME}`} />
      </Screen>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <Screen safeArea>
        <ErrorState
          title="The list could not be read"
          description={state.message}
          action={<Button title="Refresh" variant="secondary" onPress={refresh} />}
        />
      </Screen>
    );
  }

  if (state.kind === 'configureSources') {
    return (
      <Screen safeArea>
        <EmptyState
          title="No sources are configured"
          description="Connect a source in Settings to see its pull requests, issues and error groups here."
        />
      </Screen>
    );
  }

  const empty = readTriageListEmptyState(state, rowCount);

  /**
   * `core/SURFACE.md` §2.1, stacked composition: the selection replaces the
   * list rather than appearing under it, and the list is not duplicated
   * underneath. Generic page Back clears the selection first — the route owner
   * declares that step — and only an unhandled Back leaves the page.
   */
  if (surface.selection !== null) {
    return (
      <Screen safeArea>
        {selectedRow === null ? (
          /*
           * `core/SURFACE.md` §3.1: a selected entry that leaves the window
           * keeps its selection so the detail can say so. Returning to the list
           * on its own would look like the surface closed the detail by itself,
           * and the reader would have no idea their entry is gone.
           */
          <Stack gap="small">
            <Row justify="space-between" align="center">
              <Heading level={2} value="This entry is no longer in the list" />
              <Button title="Close" variant="secondary" onPress={dismissDetail} />
            </Row>
            <EmptyState
              title="Nothing to show for it"
              description="The current window no longer holds this entry, so there is nothing to open it with. It may return on the next refresh."
            />
          </Stack>
        ) : (
          <TriageDetailRegion
            row={selectedRow}
            lanes={state.window.lanes}
            connectionLabel={selectedConnectionLabel}
            onClose={dismissDetail}
          />
        )}
      </Screen>
    );
  }

  return (
    <Screen safeArea>
      <Stack gap="small">
        <Row justify="space-between" align="center">
          <Heading level={1} value={TRIAGE_DISPLAY_NAME} />
          <Button
            title="Refresh"
            variant="secondary"
            busy={state.refreshing}
            onPress={refresh}
          />
        </Row>

        {/*
          Freshness is said out loud rather than implied by silence. A stale
          window still shows its rows, so the only way a reader can tell the
          difference between "current" and "as of the last successful pass" is
          if the surface says which one they are looking at.
        */}
        <Status
          tone={state.refreshing ? 'info' : state.stale ? 'muted' : 'success'}
          pulsing={state.refreshing}
          label={state.refreshing
            ? 'Refreshing'
            : state.stale
              ? 'Showing the last known list'
              : 'Up to date'}
        />

        {/*
          Only beside rows. With none, the empty slot below is already the
          failure — `readTriageListEmptyState` renders the same sentence as an
          `ErrorState` with a retry — and a banner here would say it twice.
        */}
        {state.error === null || rowCount === 0 ? null : (
          <Banner
            tone="warning"
            title="Some sources could not be read"
            description={state.error}
          />
        )}

        {state.window.coverage === 'partial' && state.error === null && rowCount > 0 ? (
          <Banner
            tone="info"
            title="More entries may exist"
            description="This window is bounded; sources that had not finished are still walking."
          />
        ) : null}

        {/*
          Pins are durable user intent with no upstream owner, so the two ways
          they can be quietly lost are said out loud: a page that does not hold
          them all, and a store this mount could not reach.
        */}
        {marks.unavailableReason === null ? null : (
          <Banner
            tone="warning"
            title="Pins are unavailable"
            description={marks.unavailableReason}
          />
        )}

        {marks.more ? (
          <Banner
            tone="info"
            title="More pinned entries exist"
            description="This page shows your most recent pins; the rest are still pinned."
          />
        ) : null}

        {marks.notice === null ? null : (
          <Status tone={marks.notice.tone} label={marks.notice.message} />
        )}

        <List<TriageListDisplayRowV1>
          accessibilityLabel={TRIAGE_DISPLAY_NAME}
          density="compact"
          sections={sections}
          keyForItem={(row) => row.key}
          renderItem={(row) => renderTriageListRow(row, pinHandlers)}
          // The shared owner of activation, roving focus, the tab stop and the
          // option semantics. Without it every row rendered as inert text and a
          // reader had no way to open anything.
          selection={{ selectedKey, onSelectedKeyChange: activateRow }}
          empty={empty === null ? null : empty.kind === 'sourceFailure' ? (
            <ErrorState
              title={empty.title}
              description={empty.description}
              action={<Button title="Refresh" variant="secondary" onPress={refresh} />}
            />
          ) : (
            <EmptyState title={empty.title} description={empty.description} />
          )}
        />
      </Stack>
    </Screen>
  );
}

/**
 * Follow the host-settled location back into the reducer's selection.
 *
 * This is the other half of the route binding, and without it the shareable
 * location is write-only. Two things depend on it and both are ordinary product
 * behavior rather than edge cases:
 *
 * - **Back closes the detail.** The route owner declares a page-internal Back
 *   step whose location has no selection. The host settles it, and the only
 *   thing that reaches this surface is a new `subPath` — so a mount that read
 *   its location once, at construction, left the reader on a detail screen the
 *   system Back button appeared to do nothing to.
 * - **A copied link opens the entry.** The reducer cannot seed a selection from
 *   a location alone, because a selection carries the qualified connection and
 *   only the window knows it. So the adoption waits for the window instead: as
 *   soon as a row for that exact entry is qualified, the same `rowActivated`
 *   the reader's own press dispatches is dispatched here.
 *
 * It never writes a location of its own, and the two rules are deliberately not
 * symmetric.
 *
 * Adoption may run on any render: it fires only when the location names an
 * entry the reducer is not showing, which a location this surface itself just
 * asked for never does. Dismissal may run only when the incoming location
 * actually **changed**, because the prop is one settle behind the reducer for
 * as long as the write is in flight — a rule that read the stale value would
 * clear the selection the reader just made, and the surface would silently
 * refuse to open anything.
 */
function useTriageSettledLocation(input: Readonly<{
  subPath: string | undefined;
  surface: TriageSurfaceStateV1;
  rowsByKey: ReadonlyMap<string, Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>>;
  dispatch: React.Dispatch<TriageSurfaceActionV1>;
  readerChangedLens: React.RefObject<boolean>;
}>): void {
  const { dispatch, readerChangedLens, rowsByKey, subPath, surface } = input;
  const selection = surface.selection;
  /** The last location the host actually handed this mount. */
  const observedSubPath = React.useRef(subPath);

  React.useEffect(() => {
    const located = parseTriageRouteSubPathV1(subPath).selection;
    const changed = observedSubPath.current !== subPath;
    observedSubPath.current = subPath;

    if (located === null) {
      if (selection === null || !changed) return;
      // The settled location no longer names an entry — the host walked its own
      // Back step — so the selection it named is gone with it.
      dispatch({
        kind: 'detailDismissed',
        visibleOrder: [...rowsByKey.values()].map((hit) => ({
          sectionId: hit.sectionId,
          entryRef: hit.row.entryRef,
        })),
      });
      return;
    }

    if (selection !== null && sameTriageEntryRefV1(selection.entryRef, located)) return;
    for (const hit of rowsByKey.values()) {
      if (!sameTriageEntryRefV1(hit.row.entryRef, located)) continue;
      // A row the window could not qualify carries no connection, and opening
      // one anyway would read somebody else's. The location stays unadopted
      // until a pass qualifies it.
      if (hit.row.sourceInstanceId === null) return;
      readerChangedLens.current = true;
      dispatch({
        kind: 'rowActivated',
        sectionId: hit.sectionId,
        entryRef: hit.row.entryRef,
        sourceInstanceId: hit.row.sourceInstanceId,
      });
      return;
    }
  }, [dispatch, readerChangedLens, rowsByKey, selection, subPath]);
}

/**
 * Write the reducer's lens back to the host, once per settled reader change.
 *
 * The host owns history and settlement, so nothing here mirrors the location
 * locally or pushes its own entry. A host that publishes no same-page
 * replacement is a refusal the route owner already reports, and the page keeps
 * working without a shareable URL rather than failing to mount.
 *
 * Nothing is written until the reader actually changes the lens. The location a
 * page was opened at is the host's, and a mount that wrote its own lens
 * immediately would erase the entry a Composer **View details** just navigated
 * to — the reducer cannot seed a selection from a location alone, because a
 * selection needs the qualified instance only the window can supply.
 */
function useTriageRouteBinding(
  hostApi: PluginUiHostApi,
  surface: TriageSurfaceStateV1,
  readerChangedLens: React.RefObject<boolean>,
): void {
  const lens = readTriageRouteLensV1(surface);
  const grouping = lens.grouping;
  const order = lens.order;
  const query = lens.query;
  const selection = lens.selection;

  React.useEffect(() => {
    if (!readerChangedLens.current) return undefined;
    const controller = new AbortController();
    void writeTriageRouteLensV1(
      hostApi,
      { grouping, order, query, selection },
      { signal: controller.signal },
    );
    return () => { controller.abort(); };
  }, [grouping, hostApi, order, query, readerChangedLens, selection]);
}
