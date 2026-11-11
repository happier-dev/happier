import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Item,
  ItemGroup,
  LoadingState,
  PaneHeaderContent,
  Status,
  TaskStatusGlyph,
  defineUiSurface,
  usePluginHostApi,
  usePluginTranslation,
  usePluginUiEphemeralSharedScope,
  useSurfaceContext,
  usePluginSurfaceActivity,
  useWidgetPresentation,
  widgetFootprintBodyRows,
} from '@happier-dev/plugin-ui';

import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, type TriageMountedUiOperationV1, type TriageMountedUiResultV1 } from '../../actions/mountedUiProtocol.js';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, formatTriageCompactAgeV1, triageTaskStatusCategoryV1 } from '@happier-dev/triage-protocol/v1';
import { bindTriageMountedUiActions } from '../mountedActions.js';
import { useTriageCurrentUiContextPublication } from '../currentContextPublication.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1, TRIAGE_TASK_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';
import { TRIAGE_LIST_DEFAULT_LENS_V1, triageEntryRowKey } from '../../projection/listWindow.js';
import { readTriageSourceDescriptorV1 } from '../detail/sourceSurface.js';
import { readTriageRowBylinePlaceV1, readTriageRowDetailToneV1, readTriageRowMarkV1, readTriageSignalCellMarkV1, readTriageTaskDueV1 } from '../list/rows.js';
import { openTriageLinkedEntry } from '../navigation/openLinkedEntry.js';
import { projectTriageEntryDisplay } from '../window/entryDisplay.js';
import { projectTriageListWindow } from '../window/mountedWindow.js';
import { useTriageListWindow } from '../window/useTriageListWindow.js';
import { useTriageListWindowViewDemand } from '../window/useTriageListWindowViewDemand.js';
import { planTriageListItemsV1 } from '../list/sections.js';
import { planTriageTaskViewInventoryV1 } from '../list/viewInventory.js';
import { TRIAGE_ROUTE_DEFAULT_LENS_V1 } from '../navigation/location.js';
import { readTriageHostOutageV1, readTriageListFailureNotice, resolveTriageListShellState } from '../shell/windowState.js';
import { readTriageListEmptyScene, readTriageListEmptyState, readTriageListEmptyStateKeys } from '../shell/emptyState.js';
import { TRIAGE_DISPLAY_NAME } from '../../displayName.js';
import { stageTriageTaskDraft } from '../taskDraftHandoff.js';

/**
 * How many of the newest entries the Home widget shows. Home is a glance, not the list: the page
 * holds everything else, one press away through each row and the section's Open.
 */
export const TRIAGE_LATEST_WIDGET_ROWS_V1 = 5;

/** The widget has no lens of its own to narrow with. */
const NOT_NARROWED = Object.freeze({ facets: false, search: false, narrowed: false });

/**
 * **New for you**, the Home widget (`shell-extensibility` §2.1, §3.5).
 *
 * It reads the same mounted window the page and the Composer picker share: one store, one
 * single-flight, one pacing interval. The window is retained by the host while nothing shows it,
 * so coming back to Home draws the last rows at once and revalidates them — stale first, then
 * fresh — with no timer anywhere. Mounting is the only demand it makes; Home builds it only while
 * it is focused and on screen.
 */
export function TriageLatestWidget({ tasksOnly = false }: Readonly<{ tasksOnly?: boolean }>): React.ReactElement {
  const text = usePluginTranslation();
  const hostApi = usePluginHostApi();
  const surfaceContext = useSurfaceContext();
  const sharedScope = usePluginUiEphemeralSharedScope();
  const window = useTriageListWindow();
  const activity = usePluginSurfaceActivity();
  const mountId = React.useId();
  useTriageListWindowViewDemand(true, window.refresh, window.readiness, window.readOwner);
  const snapshot = window.snapshot;
  const refresh = React.useCallback(() => window.refresh('manual'), [window.refresh]);
  const runMountedOperation = React.useCallback(async (operation: TriageMountedUiOperationV1, signal: AbortSignal): Promise<TriageMountedUiResultV1> => {
    if (signal.aborted || operation.kind !== 'refresh') return { status: 'unavailable' };
    await refresh();
    return { status: 'applied' };
  }, [refresh]);
  React.useLayoutEffect(() => sharedScope === null || !activity.active ? undefined : bindTriageMountedUiActions(
    sharedScope, mountId, runMountedOperation,
  ), [activity.active, mountId, runMountedOperation, sharedScope]);
  const currentUiContext = React.useMemo(() => ({ detail: {
    view: tasksOnly ? 'tasks-widget' : 'latest-widget',
    mountedAction: { action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 }, mountId },
  } }), [mountId, tasksOnly]);
  useTriageCurrentUiContextPublication(hostApi, currentUiContext);

  // The page's one rule (`ui/shell/windowState.ts`): an old list that read cleanly stays quiet; only a failed or
  // unreachable read says the rows are the last known ones.
  const shellState = resolveTriageListShellState(snapshot, { tasks: tasksOnly });
  // While the host's band speaks for its Machine's outage, that is the widget's one notice (the page's rule).
  const hostOutage = readTriageHostOutageV1(surfaceContext);
  const degraded = shellState.kind === 'window' && !hostOutage.speaks
    && (shellState.showReadWarning || tasksOnly && snapshot.window?.coverage === 'partial');
  // A glance shows only the whole rows its frame has room for (two per grid row), never a row cut at the card foot;
  // its one degraded line takes a row's room, so the line naming the failed source is never the part cut off.
  const footprint = useWidgetPresentation()?.footprint;
  const roomRows = footprint ? Math.min(TRIAGE_LATEST_WIDGET_ROWS_V1, widgetFootprintBodyRows(footprint)) : TRIAGE_LATEST_WIDGET_ROWS_V1;
  const shownRows = Math.max(1, roomRows - (footprint && degraded ? 1 : 0));
  const view = React.useMemo(
    () => {
      if (snapshot.window === undefined) return undefined;
      const projected = projectTriageListWindow(TRIAGE_LIST_DEFAULT_LENS_V1, hostApi, sharedScope)?.rows;
      if (projected === undefined) return undefined;
      const items = planTriageListItemsV1({ rows: projected, pins: [], workflowSubjectOf: () => null,
        ...(tasksOnly ? { tasks: { audience: 'mine' as const, hasSessions: () => false,
          isTask: planTriageTaskViewInventoryV1(source => readTriageSourceDescriptorV1(surfaceContext, source)?.kinds)
            .includesKind } } : {}) });
      // The most pressing open work, in the page's band order (In progress, To do, Backlog); Done and Canceled stay
      // on the page behind their collapsed bands (lab `tasks-widget`).
      const byKey = new Map(projected.map((row) => [triageEntryRowKey(row.entryRef), row] as const));
      const shown = items.filter((item) => !tasksOnly || item.group !== 'completed' && item.group !== 'canceled').slice(0, shownRows);
      return { rows: shown.flatMap((item) => byKey.get(item.key) ?? []),
        // Each row's status fact (checks), as the page's Signal cell has it.
        signalOf: new Map(shown.map((item) => [item.key, item.signal] as const)),
        inProgress: items.filter((item) => item.group === 'started').length,
        needsYou: items.filter((item) => item.group === 'needsYou').length };
    },
    [hostApi, sharedScope, shownRows, snapshot.window, surfaceContext.targetedContributions, tasksOnly],
  );
  const rows = view?.rows;
  const openPage = React.useCallback(() => {
    void hostApi.openSurface(tasksOnly ? TRIAGE_TASK_DETAIL_DESTINATION_V1 : TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
      undefined, { subPath: tasksOnly ? 'tasks,mine' : '' }).catch(() => undefined);
  }, [hostApi, tasksOnly]);
  const createTask = React.useCallback(() => {
    const handoff = stageTriageTaskDraft(sharedScope, {});
    if (handoff === null) return;
    void hostApi.openSurface(TRIAGE_TASK_DETAIL_DESTINATION_V1, handoff.input, { subPath: 'tasks,mine' })
      .catch(() => { handoff.discard(); });
  }, [hostApi, sharedScope]);
  // My tasks lends its frame header what the lab draws there: how many are in progress, and the plus that
  // starts a new task (lab `tasks-widget`). The host puts it in the frame's header; elsewhere it draws nothing.
  const newTaskLabel = text('plugins.triage.tasks.new', 'New task');
  const headerActions = React.useMemo(() => (tasksOnly
    ? <IconButton icon={<Icon name="add" size="small" />} accessibilityLabel={newTaskLabel} onPress={createTask}
      testID="triage-tasks-widget.new" />
    : null), [createTask, newTaskLabel, tasksOnly]);
  // The frame names the plugin's page each glance comes from, "Tasks" or "PRs & Issues", not the whole plugin; its
  // one live fact is the count the page leads with: in progress on My tasks, needs you on PRs & Issues.
  const inProgress = view?.inProgress ?? 0;
  const needsYou = view?.needsYou ?? 0;
  const header = <PaneHeaderContent
    caption={tasksOnly ? text('plugins.triage.tasks.title', 'Tasks') : TRIAGE_DISPLAY_NAME}
    line={tasksOnly
      ? inProgress > 0 ? [text('plugins.triage.tasks.widget.inProgress', '{count} in progress', { count: inProgress })] : []
      : needsYou > 0 ? [{ text: text('plugins.triage.sessionLinks.needsYouCount', '{count} needs you', { count: needsYou }), attention: true }] : []}
    {...(headerActions === null ? {} : { actions: headerActions })}
    // The frame's one footer link, "Open Tasks": the way to every row this glance leaves out.
    onOpen={openPage} />;
  // A glance says a degraded read in one quiet line above its rows, where the host's own notice stands, never a card:
  // a widget has one notice place (owner 2026-11-11). The page beside it owns
  // the source notice and its repair (one cause, said once, at the owner that can fix it). The line names the source
  // that failed when there is one; its words stay quiet and only the dot carries the warning (owner tone ruling
  // 2026-10-31). Unfinished coverage is said only on My tasks, whose "most pressing first" it would falsify; the
  // newest entries read so far are still the newest.
  const degradedLine = shellState.kind !== 'window' || hostOutage.speaks ? null : shellState.showReadWarning
    ? <Status testID="triage-latest-widget.degraded" tone="warning" presentation="inline" label={shellState.failure === null
      ? text('plugins.triage.surface.lastKnown', 'Showing the last known list')
      : readTriageListFailureNotice(shellState.failure, text).title} />
    : tasksOnly && snapshot.window?.coverage === 'partial'
      ? <Status testID="triage-latest-widget.degraded" tone="muted" presentation="inline"
        label={text('plugins.triage.surface.empty.incomplete.title', 'This list is not complete yet')} /> : null;

  // Under the host's outage band with nothing to show, the card's one line: a failure state that claims the host's
  // sentence and Retry ("Offline · nothing cached yet"), so the host draws none and the card is that line.
  const offlineNothingCached = <ErrorState testID="triage-latest-widget.offline" layout="line"
    titleKey="plugins.triage.widget.error" title="The latest entries could not be read" />;

  if (rows === undefined) {
    if (snapshot.error !== undefined) {
      return (
        <>{header}<ErrorState
          testID="triage-latest-widget.error"
          titleKey="plugins.triage.widget.error"
          title="The latest entries could not be read"
          {...(snapshot.error.detail === undefined ? {} : { details: snapshot.error.detail })}
          {...(snapshot.error.retryable === false ? {} : {
            action: (
              <Button
                variant="secondary"
                titleKey="plugins.triage.widget.retry"
                title="Try again"
                onPress={() => { void refresh(); }}
              />
            ),
          })}
        /></>
      );
    }
    // Under the host's outage nothing will load until its Machine answers: loading rows would promise rows that
    // cannot come, so the card is the one offline line.
    if (hostOutage.settled) return <>{header}{offlineNothingCached}</>;
    return (
      <>{header}<LoadingState
        testID="triage-latest-widget.loading"
        titleKey="plugins.triage.widget.loading"
        title="Loading the latest entries"
        rows={3}
      /></>
    );
  }

  if (rows.length === 0) {
    // Nothing open: say so once (the frame already says "My tasks") and offer the one next step, a new task, through
    // the same draft handoff a message's Create task uses. Happier tasks need no source or Machine.
    // The frame sizes and centres every state here (a card's scene step, or one line in a compact footprint), so
    // these states pass no size. A degraded read keeps its scene off: the scene is for an answer that settled.
    if (tasksOnly) return <>{header}<EmptyState testID="triage-latest-widget.empty"
      {...(degradedLine === null ? { scene: readTriageListEmptyScene('taskStart') } : {})}
      title={text('plugins.triage.tasks.empty.title', 'No tasks here')}
      description={text('plugins.triage.tasks.widget.empty.description', 'Your open tasks show here, most pressing first.')}
      action={<Button title={text('plugins.triage.tasks.new', 'New task')} onPress={createTask} />} />{degradedLine}</>;
    // First run: what this card will hold, and the one way to fill it, which opens the page's own source tiles.
    if (shellState.kind === 'configureSources') return (<>{header}
      <EmptyState
        testID="triage-latest-widget.noSources"
        scene="reviewApproved"
        title={text('plugins.triage.widget.noSources', 'No sources connected yet')}
        description={text('plugins.triage.widget.noSources.description', 'New pull requests, issues and alerts show here.')}
        action={<Button title={text('plugins.triage.surface.firstRun.connect.title', 'Connect a source')} onPress={openPage} />}
      /></>
    );
    // What an empty list may claim is the page's one decision (`ui/shell/emptyState.ts`): "nothing new" only when
    // every source answered; a failed or unfinished read says so instead, in the same words the page uses.
    const empty = readTriageListEmptyState(shellState, 0, { narrowing: NOT_NARROWED, text });
    // The host's outage band already says why nothing could be read: the frame keeps its room under that one notice.
    if (empty !== null && empty.kind !== 'healthy' && hostOutage.speaks) return <>{header}{offlineNothingCached}</>;
    if (empty !== null && empty.kind !== 'healthy') {
      const keys = readTriageListEmptyStateKeys(empty.kind);
      return (<>{header}
        <EmptyState
          testID="triage-latest-widget.empty"
          title={keys.title === '' ? empty.title : text(keys.title, empty.title)}
          description={keys.description === '' ? empty.description : text(keys.description, empty.description)}
        /></>
      );
    }
    return (<>{header}
      <EmptyState
        testID="triage-latest-widget.empty"
        scene={readTriageListEmptyScene('healthy')}
        title={text('plugins.triage.widget.empty', 'Nothing new right now')}
        description={text('plugins.triage.widget.empty.description', 'Pull requests, issues and alerts show here as they arrive.')}
      /></>
    );
  }

  return (
    <>
    {header}
    {degradedLine}
    <ItemGroup testID="triage-latest-widget.rows">
      {rows.map((row) => {
        const display = projectTriageEntryDisplay(row, text);
        // The page's row mark and detail tone (one owner): the entry's kind glyph, loud only when it
        // needs the reader.
        const workflowSubject = readTriageSourceDescriptorV1(surfaceContext, row.entryRef.source)
          ?.kinds.find((kind) => kind.id === row.entryRef.kindId)?.workflowSubject ?? null;
        const mark = readTriageRowMarkV1(display, workflowSubject);
        const detailTone = readTriageRowDetailToneV1(display);
        // My tasks (lab `tasks-widget`): the status category leads, line two is where and the key, and the one
        // loud fact is Overdue, then Due today, then Blocked (the page's precedence); why-it's-here reasons stay on
        // PRs & Issues.
        const snapshot = row.content?.outcome.snapshot;
        const category = tasksOnly && snapshot !== undefined ? triageTaskStatusCategoryV1(snapshot.state) : null;
        if (tasksOnly) {
          const blocked = (snapshot?.relations?.blockedBy?.length ?? 0) > 0;
          const due = readTriageTaskDueV1(snapshot?.dueDate, category, surfaceContext.locale, Date.now(), text);
          const loud = due !== null && due.tone !== null ? { detail: due.label, detailTone: due.tone }
            : blocked ? { detail: text('plugins.triage.tasks.progress.blocked', 'Blocked') } : null;
          return (
            <Item
              key={display.key}
              testID={`triage-latest-widget.row.${display.key}`}
              title={display.title}
              titleNumberOfLines={1}
              subtitle={readTriageRowBylinePlaceV1(display)}
              subtitleNumberOfLines={1}
              icon={category === null ? <Icon name={mark.name} size="small" tone={mark.tone} /> : <TaskStatusGlyph category={category} />}
              {...(loud === null ? {} : { ...loud, detailNumberOfLines: 1 })}
              density="compact"
              onPress={() => { void openTriageLinkedEntry(hostApi, row.entryRef, undefined,
                { ...TRIAGE_ROUTE_DEFAULT_LENS_V1, filters: { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, tasks: 'mine' } }); }}
            />
          );
        }
        // The page row's facts in a glance's room (lab `merged-list`): where and its number, then its compact age, the
        // reason as the one loud word, and the checks' dot when they need the reader (the page's Signal cell).
        const signal = view?.signalOf.get(triageEntryRowKey(row.entryRef)) ?? null;
        const signalMark = signal === null ? null : readTriageSignalCellMarkV1(signal.tone);
        const age = display.activityAtMs === null ? null : formatTriageCompactAgeV1(surfaceContext.locale, display.activityAtMs, Date.now());
        return (
          <Item
            key={display.key}
            testID={`triage-latest-widget.row.${display.key}`}
            title={display.title}
            titleNumberOfLines={1}
            subtitle={age === null ? readTriageRowBylinePlaceV1(display) : `${readTriageRowBylinePlaceV1(display)} · ${age}`}
            subtitleNumberOfLines={1}
            icon={<Icon name={mark.name} size="small" tone={mark.tone} />}
            {...(signal === null || signalMark === null || !signalMark.marked ? {} : { accessory: <Status presentation="inline"
              tone={signalMark.tone} indicator label={signal.label} testID={`triage-latest-widget.signal.${display.key}`} /> })}
            {...(display.detail === null ? {} : { detail: display.detail, detailNumberOfLines: 1 })}
            {...(detailTone === undefined ? {} : { detailTone })}
            density="compact"
            onPress={() => { void openTriageLinkedEntry(hostApi, row.entryRef, undefined,
              tasksOnly ? { ...TRIAGE_ROUTE_DEFAULT_LENS_V1, filters: { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, tasks: 'mine' } } : undefined); }}
          />
        );
      })}
    </ItemGroup>
    </>
  );
}

export const renderSurface: RenderSurface = defineUiSurface(() => <TriageLatestWidget />);
