import * as React from 'react';
import { Button, ErrorState, LoadingState, Stack, usePluginHostApi, usePluginTranslation, usePluginUiEphemeralSharedScope, usePluginSurfaceActivity } from '@happier-dev/plugin-ui';
import type { PluginUiResourceIntentV1 } from '@happier-dev/plugin-sdk/protocol';
import { buildTriageEntryDetailLaunchInput, type TriageEntryDetailLaunchInputV1 } from '../composer/entryDetailLaunchInput.js';
import type { TriageListLaneV1 } from '../projection/listWindow.js';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, TriageResolveResourceActionResultV1Schema } from '../actions/resolveResourceProtocol.js';
import { useTriagePostMutationRow } from './detail/useTriagePostMutationRow.js';
import { TriageDetailRegion } from './detail/region.js';
import { useTriageActions } from './actions/useTriageActions.js';
import { useTriagePinnedEntries } from './marks/useTriagePinnedEntries.js';
import { indexTriagePinsByEntry, projectTriageWindowRow } from './marks/pinnedRows.js';
import { resolveTriageActionTargetV1 } from './state/actionTarget.js';
import { useTriageSourcePanelActionsV1 } from './useSourcePanelActions.js';

const EMPTY_LANES: readonly TriageListLaneV1[] = Object.freeze([]);

/** URL opens read one exact entry; they never demand an aggregate scan. */
export function TriageResourceSurface({ resource }: Readonly<{ resource: PluginUiResourceIntentV1 }>): React.ReactElement {
  const host = usePluginHostApi();
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
  }, [host, resource]);
  const fallback = <Button title="On GitHub" titleKey="plugins.triage.resource.onGithub" variant="secondary" onPress={() => host.openExternalLink(resource.url)} />;
  if (result?.resource === resource && result.launch === null) return <ErrorState
    title="These details are unavailable" titleKey="plugins.triage.resource.unavailable"
    description="Open this resource on GitHub, or try again when its connection is available." descriptionKey="plugins.triage.resource.unavailableDescription" action={fallback} />;
  if (result?.resource !== resource || result.launch === null) return <LoadingState title="Reading this entry" titleKey="plugins.triage.surface.detail.reading" />;
  return <TriageResourceEntryDetail key={JSON.stringify(result.launch.entryRef)} launch={result.launch} fallback={fallback} />;
}

function TriageResourceEntryDetail({ launch, fallback }: Readonly<{ launch: TriageEntryDetailLaunchInputV1; fallback: React.ReactNode }>): React.ReactElement {
  const selection = React.useMemo(() => ({ sectionId: null, entryRef: launch.entryRef, sourceInstanceId: launch.sourceInstance.sourceInstanceId }), [launch]);
  const { row, completePostMutation, readFailed } = useTriagePostMutationRow(null, EMPTY_LANES, selection);
  const actions = useTriageActions();
  const pins = useTriagePinnedEntries();
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const scope = usePluginUiEphemeralSharedScope();
  const active = usePluginSurfaceActivity();
  const mountId = React.useId();
  const sourcePanel = useTriageSourcePanelActionsV1(scope, mountId, JSON.stringify(launch.entryRef), active.active, host);
  const [tab, setTab] = React.useState('overview');
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const loadMore = React.useRef<(() => void) | null>(null);
  const reportSessions = React.useCallback((_sessions: unknown, next: (() => void) | null) => { loadMore.current = next; }, []);
  if (row === null) return readFailed ? <ErrorState title="These details are unavailable" titleKey="plugins.triage.resource.unavailable" action={fallback} />
    : <LoadingState title="Reading this entry" titleKey="plugins.triage.surface.detail.reading" />;
  return <Stack gap="small" style={{ flex: 1, minHeight: 0 }}>
    <TriageDetailRegion sourcePanelActions={sourcePanel.actions} row={row} completePostMutation={completePostMutation}
      tabSelection={{ value: tab, onChange: setTab }}
      sessionSelection={{ value: sessionId, onChange: setSessionId, onAvailableSessionsChange: reportSessions, onLoadMore: () => loadMore.current?.() }}
      lanes={EMPTY_LANES} rows={[row]} connectionLabel={null} target={resolveTriageActionTargetV1({ selection })}
      actions={actions} originComposer={null} pin={{ row: projectTriageWindowRow(row, indexTriagePinsByEntry(pins.pins), { text }),
        handlers: { busyKey: pins.busyKey, unavailableReason: pins.unavailableReason, onSetPinned: pins.setPinned } }} />
    {fallback}
  </Stack>;
}
