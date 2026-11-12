import * as React from 'react';
import type { PluginUiContextEnrichmentV1, RenderContext } from '@happier-dev/plugin-sdk/ui';
import { readInputTypePickerLaunchInput } from '@happier-dev/plugin-sdk/actions';
import { Button, EmptyState, FreshnessLine, List, PageLoadingRows, PagePinnedBar, Stack, Status, defineUiSurface,
  usePluginHostApi, usePluginTranslation, useSurfaceContext, usePluginUiEphemeralSharedScope,
  usePluginSurfaceActivity } from '@happier-dev/plugin-ui';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { projectTriagePickerCorpusFacts } from '../composer/pickerFacts.js';
import { buildTriagePickerView, requestTriagePickerRefresh } from '../composer/pickerModel.js';
import { deriveTriageComposerEntryAttachmentKey } from '../composer/attachmentValue.js';
import type { TriageListRowV1 } from '../projection/listWindow.js';
import { useTriageListWindow } from './window/useTriageListWindow.js';
import { readTriageSelectedObservationV1 } from './window/selectedObservation.js';
import { useTriageRefreshEligibilityNowV1 } from './window/refreshEligibilityClock.js';
import { readTriageEntryDetailState } from './detail/useTriageEntryDetail.js';
import { readTriageSourceGetOperationV1, resolveTriageSourceWorkflowSubjectV1 } from './detail/sourceSurface.js';
import { readTriageComparisonSource } from './detail/readComparison.js';
import { TriagePickerHead, TriagePickerRow, resolvePickerStateLabel, resolvePacingReasonDescription } from '../composer/entryPicker.js';
import { bindTriageMountedUiActions } from './mountedActions.js';
import { useTriageCurrentUiContextPublication } from './currentContextPublication.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, type TriageMountedUiOperationV1, type TriageMountedUiResultV1 } from '../actions/mountedUiProtocol.js';

/** The source and completion are host-owned; selecting a row admits only its current observing connection. */
function useComparisonSelection() {
  const host = usePluginHostApi();
  const context = useSurfaceContext();
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const attempt = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { attempt.current?.abort(); }, []);
  const reset = () => {
    attempt.current?.abort();
    attempt.current = null;
    setBusy(false);
    setFailed(false);
  };
  const choose = async (row: TriageListRowV1, signal?: AbortSignal): Promise<TriageMountedUiResultV1> => {
    const selected = readTriageSelectedObservationV1(row);
    const operation = readTriageSourceGetOperationV1(context, row.entryRef.source);
    if (attempt.current || signal?.aborted || !operation || !selected) return { status: 'unavailable' };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    attempt.current = controller;
    setBusy(true);
    setFailed(false);
    try {
      const detail = await readTriageEntryDetailState(host, {
        selection: { entryRef: row.entryRef, sourceInstanceId: selected.sourceInstanceId },
        observation: selected.observation,
      }, { signal: controller.signal });
      if (controller.signal.aborted) return { status: 'unavailable' };
      if (detail.kind !== 'ready') { setFailed(true); return { status: 'unavailable' }; }
      const comparison = await readTriageComparisonSource({ host, entryRef: row.entryRef,
        read: { operation, instance: detail.input.instance }, lastKnownLocator: selected.observation.locator,
        signal: controller.signal });
      if (controller.signal.aborted) return { status: 'unavailable' };
      if (comparison?.kind !== 'pullRequest') { setFailed(true); return { status: 'rejected' }; }
      // The finite acknowledgement belongs to the caller; closing its picker only stops acquisition.
      await host.settleEphemeralInput({ kind: 'completed', input: comparison }, { signal });
      return { status: 'applied' };
    } catch {
      if (!controller.signal.aborted) setFailed(true);
      return { status: controller.signal.aborted ? 'unavailable' : 'rejected' };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (attempt.current === controller) { attempt.current = null; setBusy(false); }
    }
  };
  return { choose, reset, busy, failed };
}

/** A transient single-value consumer of the same corpus window as the existing Composer picker. */
function TriageComparisonPicker(context: RenderContext) {
  const surface = useSurfaceContext();
  const text = usePluginTranslation();
  const window = useTriageListWindow();
  const nowMs = useTriageRefreshEligibilityNowV1(window.snapshot.refreshBlocked);
  const [query, setQuery] = React.useState('');
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const selection = useComparisonSelection();
  const changeQuery = (value: string) => { selection.reset(); setQuery(value); };
  const sharedScope = usePluginUiEphemeralSharedScope();
  const activity = usePluginSurfaceActivity();
  const mountId = React.useId();
  const launch = readInputTypePickerLaunchInput(context.launchInput);
  const facts = projectTriagePickerCorpusFacts({ snapshot: window.snapshot, nowMs });
  const pullRequests = facts.rows.filter(row => resolveTriageSourceWorkflowSubjectV1(surface.targetedContributions, row.entryRef) === 'pullRequest');
  const view = buildTriagePickerView({ facts: { ...facts, rows: pullRequests }, query, attached: [] });
  const row = view.rows.some(candidate => candidate.id === selectedKey)
    ? window.snapshot.window?.rows.find(candidate => deriveTriageComposerEntryAttachmentKey(candidate.entryRef) === selectedKey) : undefined;
  const runMountedOperation = async (operation: TriageMountedUiOperationV1, signal: AbortSignal): Promise<TriageMountedUiResultV1> => {
    if (signal.aborted) return { status: 'unavailable' };
    if (operation.kind === 'setPickerQuery') { changeQuery(operation.query); return { status: 'applied' }; }
    if (operation.kind === 'refresh') {
      if (requestTriagePickerRefresh(view).status !== 'invoke') return { status: 'unavailable' };
      await window.refresh('manual');
      return { status: 'applied' };
    }
    if (operation.kind === 'loadMore' && operation.section === 'entries') {
      if (window.snapshot.loadMore?.kind !== 'available') return { status: 'unavailable' };
      await window.loadMore();
      return { status: 'applied' };
    }
    if (operation.kind !== 'attachEntry') return { status: 'unavailable' };
    const key = deriveTriageComposerEntryAttachmentKey(operation.entryRef);
    const candidate = view.rows.some(item => item.id === key)
      ? window.snapshot.window?.rows.find(item => deriveTriageComposerEntryAttachmentKey(item.entryRef) === key) : undefined;
    if (!candidate) return { status: 'unavailable' };
    setSelectedKey(key);
    return await selection.choose(candidate, signal);
  };
  const mountedOperationRef = React.useRef(runMountedOperation);
  React.useLayoutEffect(() => { mountedOperationRef.current = runMountedOperation; });
  React.useLayoutEffect(() => sharedScope === null || !activity.active ? undefined : bindTriageMountedUiActions(
    sharedScope, mountId, (operation, signal) => mountedOperationRef.current(operation, signal),
  ), [mountId, sharedScope, activity.active]);
  const refreshAvailable = requestTriagePickerRefresh(view).status === 'invoke';
  const moreAvailable = window.snapshot.loadMore?.kind === 'available';
  const currentUiContext = React.useMemo<PluginUiContextEnrichmentV1>(() => {
    const commands: NonNullable<PluginUiContextEnrichmentV1['commands']> = [
      { title: text('plugins.triage.comparison.search', 'Search pull requests'),
        description: `Supply JSON input ${JSON.stringify({ mountId, operation: { kind: 'setPickerQuery', query: '<search text>' } })}. Search filters the loaded pull requests.`,
        command: { kind: 'executeAction', action: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 } },
    ];
    if (refreshAvailable) commands.push({ title: text('plugins.triage.surface.refresh', 'Refresh'), command: {
      kind: 'executeAction', action: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1,
      input: { mountId, operation: { kind: 'refresh' } },
    } });
    if (moreAvailable) commands.push({ title: text('plugins.triage.surface.loadMore', 'Load more'), command: {
      kind: 'executeAction', action: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1,
      input: { mountId, operation: { kind: 'loadMore', section: 'entries' } },
    } });
    for (const item of view.rows) commands.push({ title: item.title, command: { kind: 'executeAction',
      action: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, input: { mountId, operation: { kind: 'attachEntry', entryRef: item.entryRef } } } });
    return { detail: { view: 'comparison-picker', mountedAction: {
      action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 }, mountId,
    } }, commands };
  }, [mountId, view.rows, refreshAvailable, moreAvailable, text]);
  useTriageCurrentUiContextPublication(context.hostApi, currentUiContext);
  const stateReason = view.refresh.kind === 'blockedUntil' ? resolvePacingReasonDescription(text, view.refresh.reason)
    : view.health.length > 0 ? `${text('plugins.triage.surface.failure.some', 'Some sources could not be read')}: ${view.health.map(item => item.displayName).join(', ')}`
      : view.state.kind === 'stale' || view.state.kind === 'refreshing' ? resolvePickerStateLabel(text, view.state.kind) : null;
  const choiceAvailable = row && readTriageSelectedObservationV1(row)
    && readTriageSourceGetOperationV1(surface, row.entryRef.source);
  const choice = row ? <Stack gap="small">
    <Button titleKey="plugins.triage.comparison.choose" title="Choose comparison" variant="primary" busy={selection.busy}
      disabled={!choiceAvailable || selection.busy} onPress={async () => { await selection.choose(row); }} />
    {selection.failed || !choiceAvailable ? <Status tone="warning"
      labelKey="plugins.triage.surface.comparisonUnavailable" label="This source cannot open a comparison for this pull request." /> : null}
  </Stack> : null;
  if (launch?.inputType.pluginId !== TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1
    || launch.inputType.localId !== 'pull-request-comparison' || launch.semantic !== 'scmPullRequestComparison') return null;
  return <Stack gap="small" grow>
    <TriagePickerHead view={view} query={query} onQueryChange={changeQuery}
      onRefresh={async () => { await window.refresh('manual'); }} searchLabel={text('plugins.triage.comparison.search', 'Search pull requests')}>
      {stateReason ? <FreshnessLine reason={stateReason} /> : null}
    </TriagePickerHead>
    <List accessibilityLabelKey="plugins.triage.comparison.title" accessibilityLabel="Pull request" density="compact"
      items={view.rows} keyForItem={item => item.id}
      renderItem={item => <TriagePickerRow row={item}
        onPress={() => { selection.reset(); setSelectedKey(item.id); }} selected={item.id === selectedKey} />}
      empty={view.state.kind === 'refreshing' ? <PageLoadingRows testID="triage-comparison-loading" /> : <EmptyState title={view.state.kind === 'empty'
        ? text('plugins.triage.comparison.empty', 'No pull requests to compare') : resolvePickerStateLabel(text, view.state.kind)}
        descriptionKey="plugins.triage.picker.refreshRemedy" description="Refresh to read your connected sources." />} />
    {window.snapshot.loadMore?.kind === 'available' ? <Button titleKey="plugins.triage.surface.loadMore" title="Load more"
      variant="plain" onPress={() => window.loadMore()} /> : null}
    {choice ? <PagePinnedBar fallback={choice}>{choice}</PagePinnedBar> : null}
  </Stack>;
}

export const renderSurface = defineUiSurface(TriageComparisonPicker);
