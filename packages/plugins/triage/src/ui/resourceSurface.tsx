import * as React from 'react';
import { Button, DetailPage, ErrorState, Row, usePluginHostApi, usePluginTranslation, usePluginUiEphemeralSharedScope, usePluginSurfaceActivity, useSurfaceContext } from '@happier-dev/plugin-ui';
import type { PluginUiResourceIntentV1 } from '@happier-dev/plugin-sdk/protocol';
import type { CurrentUiCommandDeclarationV1, PluginUiContextEnrichmentV1 } from '@happier-dev/plugin-sdk/ui';
import { TRIAGE_APP_PAGE_DESTINATION_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, type TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';
import { TriageStoryLoadingLines, triageSourcePanelActionIdV1 } from '@happier-dev/triage-sources/ui';
import { buildTriageEntryDetailLaunchInput, type TriageEntryDetailLaunchInputV1 } from '../composer/entryDetailLaunchInput.js';
import type { TriageListLaneV1 } from '../projection/listWindow.js';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, TriageResolveResourceActionResultV1Schema } from '../actions/resolveResourceProtocol.js';
import { useTriagePostMutationRow } from './detail/useTriagePostMutationRow.js';
import { renderTriageDetailHeaderV1, TriageDetailRegion } from './detail/region.js';
import { projectTriageDetailHeaderV1 } from './detail/header.js';
import { readTriageSourceDescriptorV1 } from './detail/sourceSurface.js';
import { useTriagePaneMinimumWidthsV1 } from './shell/usePaneMinimumWidths.js';
import { TRIAGE_DISPLAY_NAME } from '../displayName.js';
import { useTriageActions } from './actions/useTriageActions.js';
import { useTriagePinnedEntries } from './marks/useTriagePinnedEntries.js';
import { indexTriagePinsByEntry, projectTriageWindowRow } from './marks/pinnedRows.js';
import { resolveTriageActionTargetV1 } from './state/actionTarget.js';
import { useTriageSourcePanelActionsV1 } from './useSourcePanelActions.js';
import { bindTriageMountedUiActions, executeTriageMountedUiAction } from './mountedActions.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, type TriageMountedUiOperationV1, type TriageMountedUiResultV1 } from '../actions/mountedUiProtocol.js';
import { useTriageCurrentUiContextPublication } from './currentContextPublication.js';
import { projectTriageEntryDisplay } from './window/entryDisplay.js';
import { TRIAGE_DETAIL_PAGE_KIND_V1 } from './detail/body.js';
import { openTriageActionEditorV1 } from './actions/openActionEditor.js';

const EMPTY_LANES: readonly TriageListLaneV1[] = Object.freeze([]);

/** URL opens read one exact entry; they never demand an aggregate scan. */
export function TriageResourceSurface({ resource }: Readonly<{ resource: PluginUiResourceIntentV1 }>): React.ReactElement {
  return <TriageResourceDetail key={JSON.stringify(resource)} resource={resource} />;
}

function TriageResourceDetail({ resource }: Readonly<{ resource: PluginUiResourceIntentV1 }>): React.ReactElement {
  const host = usePluginHostApi();
  const context = useSurfaceContext();
  const scope = usePluginUiEphemeralSharedScope();
  const activity = usePluginSurfaceActivity();
  const mountId = React.useId();
  const text = usePluginTranslation();
  const [resolveGeneration, setResolveGeneration] = React.useState(0);
  const [result, setResult] = React.useState<Readonly<{ resource: PluginUiResourceIntentV1; launch: TriageEntryDetailLaunchInputV1 | null }> | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    void host.executeAction(TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, { v: 1, resource }, { signal: controller.signal }).then(raw => {
      const value = TriageResolveResourceActionResultV1Schema.parse(raw);
      if (!controller.signal.aborted) setResult({ resource, launch: value.kind === 'resolved'
        ? buildTriageEntryDetailLaunchInput({ sourceInstance: value.sourceInstance, entryRef: value.entryRef }) : null });
    }).catch(
      () => { if (!controller.signal.aborted) setResult({ resource, launch: null }); });
    return () => { controller.abort(); };
  }, [host, resource, resolveGeneration]);
  const launch = result?.resource === resource ? result.launch : null;
  const selection = React.useMemo(() => launch === null ? null : ({ sectionId: null, entryRef: launch.entryRef,
    sourceInstanceId: launch.sourceInstance.sourceInstanceId }), [launch]);
  const { row, completePostMutation, readFailed, exactRead } = useTriagePostMutationRow(null, EMPTY_LANES, selection);
  const actions = useTriageActions();
  const pins = useTriagePinnedEntries();
  const identity = launch === null ? null : JSON.stringify(launch.entryRef);
  const sourcePanel = useTriageSourcePanelActionsV1(scope, mountId, identity, activity.active, host);
  const [tab, setTab] = React.useState('overview');
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessions, setSessions] = React.useState<readonly TriageLinkedSessionProjectionV1[]>([]);
  const [loadMore, setLoadMore] = React.useState<(() => void) | null>(null);
  const reportSessions = React.useCallback((next: readonly TriageLinkedSessionProjectionV1[], more: (() => void) | null) => {
    setSessions(previous => previous.length === next.length && previous.every((session, index) =>
      session.sessionId === next[index]?.sessionId && session.displayTitle === next[index]?.displayTitle) ? previous : next);
    setLoadMore(() => more);
  }, []);
  const [fixRetry, setFixRetry] = React.useState<(() => void) | null>(null);
  const reportFixRetry = React.useCallback((retry: (() => void) | null) => { setFixRetry(() => retry); }, []);
  const [refreshGeneration, setRefreshGeneration] = React.useState(0);
  // Where the list page stops splitting, the entry opened on its own page is the pushed detail, as from the list.
  const paneMinimumWidths = useTriagePaneMinimumWidthsV1();
  const navigation = context.page?.navigation;
  const tabs = navigation?.pageKind.pluginId === TRIAGE_DETAIL_PAGE_KIND_V1.pluginId
    && navigation.pageKind.localId === TRIAGE_DETAIL_PAGE_KIND_V1.localId ? navigation.items : undefined;
  const unavailable = (result?.resource === resource && result.launch === null) || readFailed;
  const runOperation = React.useCallback(async (operation: TriageMountedUiOperationV1, signal: AbortSignal): Promise<TriageMountedUiResultV1> => {
    if (signal.aborted) return { status: 'unavailable' };
    if (operation.kind === 'refresh') {
      if (unavailable) {
        setResult(null);
        setResolveGeneration(value => value + 1);
      } else if (row !== null) {
        setRefreshGeneration(value => value + 1);
        await completePostMutation();
      } else return { status: 'unavailable' };
      return { status: 'applied' };
    }
    if (row === null || unavailable) return { status: 'unavailable' };
    switch (operation.kind) {
      case 'selectDetailTab':
        if (!tabs?.some(item => item.value === operation.tab && !item.disabled)) return { status: 'unavailable' };
        setTab(operation.tab);
        break;
      case 'selectLinkedSession':
        if (!sessions.some(session => session.sessionId === operation.sessionId)) return { status: 'unavailable' };
        setSessionId(operation.sessionId);
        setTab('session');
        break;
      case 'loadMore':
        if (operation.section !== 'linkedSessions' || loadMore === null) return { status: 'unavailable' };
        loadMore();
        break;
      case 'retryFixPullRequests':
        if (fixRetry === null) return { status: 'unavailable' };
        fixRetry();
        break;
      default: return { status: 'unavailable' };
    }
    return { status: 'applied' };
  }, [completePostMutation, fixRetry, loadMore, row, sessions, tabs, unavailable]);
  const operationRef = React.useRef(runOperation);
  React.useLayoutEffect(() => { operationRef.current = runOperation; }, [runOperation]);
  React.useLayoutEffect(() => scope === null || !activity.active ? undefined : bindTriageMountedUiActions(
    scope, mountId, (operation, signal) => operationRef.current(operation, signal),
  ), [activity.active, mountId, scope]);
  const execute = React.useCallback((operation: TriageMountedUiOperationV1) => {
    executeTriageMountedUiAction(host, mountId, operation, text);
  }, [host, mountId, text]);
  const editAction = React.useCallback((actionId: string) => { openTriageActionEditorV1(host, { actionId }); }, [host]);
  const currentContext = React.useMemo<PluginUiContextEnrichmentV1>(() => {
    const command = (title: string, operation: TriageMountedUiOperationV1): CurrentUiCommandDeclarationV1 => ({
      title, command: { kind: 'executeAction', action: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, input: { mountId, operation } },
    });
    const visibleRow = unavailable ? null : row;
    const display = visibleRow === null ? null : projectTriageEntryDisplay(visibleRow);
    return {
      ...(visibleRow === null || display === null ? {} : { entity: { kind: visibleRow.entryRef.kindId, label: display.title, reference: visibleRow.entryRef } }),
      detail: { view: 'selected-detail', mountedAction: {
        action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 }, mountId,
      }, linkedSessionIds: visibleRow === null ? [] : sessions.map(session => session.sessionId),
        selectedLinkedSessionId: visibleRow === null ? null : sessions.find(session => session.sessionId === sessionId)?.sessionId ?? sessions[0]?.sessionId ?? null },
      commands: [
        command(unavailable ? text('plugins.triage.surface.actions.retry', 'Retry') : text('plugins.triage.surface.actions.refresh', 'Refresh'), { kind: 'refresh' }),
        ...(visibleRow === null ? [] : [
          ...(tabs ?? []).filter(item => !item.disabled).map(item => command(item.title, { kind: 'selectDetailTab', tab: item.value })),
          ...sessions.map(session => command(session.displayTitle ?? text('session.untitled', 'Untitled session'), { kind: 'selectLinkedSession', sessionId: session.sessionId })),
          ...(loadMore === null ? [] : [command(text('plugins.triage.surface.loadMore', 'Load more'), { kind: 'loadMore', section: 'linkedSessions' })]),
          ...(fixRetry === null ? [] : [command(text('plugins.triage.surface.detail.fixPr.retry', 'Retry: Fix pull request'), { kind: 'retryFixPullRequests' })]),
          ...sourcePanel.commands.map(({ title, operation }): CurrentUiCommandDeclarationV1 => ({
            title, command: { kind: 'executeAction', action: triageSourcePanelActionIdV1(operation), input: { mountId, operation } },
          })),
        ]),
      ],
    };
  }, [fixRetry, loadMore, mountId, row, sessionId, sessions, sourcePanel.commands, tabs, text, unavailable]);
  useTriageCurrentUiContextPublication(host, currentContext);
  if (unavailable) return <ErrorState title="These details are unavailable" titleKey="plugins.triage.resource.unavailable" action={
    <Row gap="small"><Button title="Retry" titleKey="plugins.triage.surface.actions.retry" variant="secondary" onPress={() => execute({ kind: 'refresh' })} />
      <Button title="Open on GitHub" titleKey="plugins.triage.resource.openOnGithub" variant="plain" onPress={() => host.openExternalLink(resource.url)} /></Row>
  } />;
  if (row === null || selection === null) return <TriageStoryLoadingLines label={text('plugins.triage.surface.detail.reading', 'Reading this entry')} />;
  const pin = { row: projectTriageWindowRow(row, indexTriagePinsByEntry(pins.pins), { text }),
    handlers: { busyKey: pins.busyKey, unavailableReason: pins.unavailableReason, onSetPinned: pins.setPinned } };
  // The entry's title band, read by the same owners as the list page's pushed detail, so both pages read alike.
  const band = renderTriageDetailHeaderV1({ text, locale: context.locale, nowMs: Date.now(), pin,
    header: projectTriageDetailHeaderV1({ row, lanes: EMPTY_LANES, connectionLabel: null, linkedSessions: [], linkedSessionsHasMore: false,
      sourceDescriptor: readTriageSourceDescriptorV1(context, row.entryRef.source), text }) });
  // Opened by its address, the entry is its own page: on a phone the pushed detail, its way back to PRs & Issues.
  return <DetailPage title={band.title} leading={band.leading} actions={band.actions}
    {...(band.subtitle === undefined ? {} : { subtitle: band.subtitle, subtitleLeading: band.subtitleLeading })}
    pushedBelowWidthPx={paneMinimumWidths.minListWidth + paneMinimumWidths.minDetailWidth}
    backLabel={TRIAGE_DISPLAY_NAME}
    onBack={() => { void host.openSurface(TRIAGE_APP_PAGE_DESTINATION_V1); }}>
    {({ pushed, headerHosted }) => <TriageDetailRegion exactRead={exactRead} sourcePanelActions={sourcePanel.actions} row={row} completePostMutation={completePostMutation}
      pushed={pushed} headerHosted={headerHosted}
      refreshGeneration={refreshGeneration} onFixPullRequestsRetryChange={reportFixRetry} onRetryFixPullRequests={() => execute({ kind: 'retryFixPullRequests' })}
      tabSelection={{ value: tab, onChange: value => execute({ kind: 'selectDetailTab', tab: value }) }}
      sessionSelection={{ value: sessionId, onChange: id => execute({ kind: 'selectLinkedSession', sessionId: id }),
        onAvailableSessionsChange: reportSessions, onLoadMore: () => execute({ kind: 'loadMore', section: 'linkedSessions' }) }}
      lanes={EMPTY_LANES} rows={[row]} connectionLabel={null} target={resolveTriageActionTargetV1({ selection })}
      actions={actions} onEditAction={editAction} originComposer={null} pin={pin} />}
  </DetailPage>;
}
