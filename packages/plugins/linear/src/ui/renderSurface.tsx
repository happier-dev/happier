import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Banner, Button, EmptyState, ErrorState, Item, ItemGroup, LoadingState, ScrollArea,
  Text, defineUiSurface, useExecutePluginAction, usePluginTranslation, useTabPanelActivity,
} from '@happier-dev/plugin-ui';
import { TriageActivityAgentTail, TriageDetailInstance, TriageDetailPanel, useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import {
  TriageDetailSurfaceInputV1Schema, triagePagedPanelInitialState, triagePagedPanelReducer,
  describeTriageSourceFailureV1, type TriageDetailSurfaceInputV1, type TriageSourceFailureV1,
  type TriagePagedPanelEventV1, type TriagePagedPanelStateV1,
} from '@happier-dev/triage-protocol/v1';
import {
  LINEAR_ACTIONS, LINEAR_PLUGIN_ID, LINEAR_DETAIL_SECTIONS, LinearDetailResultSchema,
  type LinearDetailInput, type LinearDetailEntrySchema,
} from '../contracts.js';

const action = { pluginId: LINEAR_PLUGIN_ID, localId: LINEAR_ACTIONS.detail };
type Entry = ReturnType<typeof LinearDetailEntrySchema.parse>;
type Section = LinearDetailInput['section'];

const reduceDetailPanel = (
  state: TriagePagedPanelStateV1<Entry, TriageSourceFailureV1>,
  event: TriagePagedPanelEventV1<Entry, TriageSourceFailureV1>,
) => triagePagedPanelReducer(state, event);

function DetailSection({ input, section }: { input: TriageDetailSurfaceInputV1; section: Section }): React.ReactElement {
  const text = usePluginTranslation();
  const request = useTriageDetailRequest(input);
  const readAuthority = React.useRef(request);
  const { active, activeSignal } = useTabPanelActivity();
  const { execute } = useExecutePluginAction(action);
  const [state, dispatch] = React.useReducer(reduceDetailPanel, undefined,
    () => triagePagedPanelInitialState<Entry, TriageSourceFailureV1>());
  const token = React.useRef(0);
  const load = React.useCallback((after?: string) => {
    const current = ++token.current;
    dispatch({ kind: 'requestStarted', token: current });
    void execute({ v: 1, ...request, section, ...(after === undefined ? {} : { after }) }, { signal: activeSignal }).then((execution) => {
      if (activeSignal.aborted || current !== token.current) return;
      const parsed = execution.status === 'success' ? LinearDetailResultSchema.safeParse(execution.result) : undefined;
      if (!parsed?.success || parsed.data.kind === 'failed') {
        dispatch({ kind: 'pageFailed', token: current, failure: parsed?.success && parsed.data.kind === 'failed'
          ? parsed.data.failure : { class: 'transient', code: 'linear/detailUnavailable' } });
        return;
      }
      const result = parsed.data;
      dispatch({ kind: 'pageSettled', token: current, page: {
        rows: result.description === undefined ? result.entries : [{ id: 'description', title: result.description ?? '' }, ...result.entries],
        omittedRowCount: 0, projectionTruncated: result.truncated === true,
        continuation: result.continuation ?? null, incomplete: null,
      } });
    }).catch(() => {
      if (!activeSignal.aborted && current === token.current) dispatch({ kind: 'pageFailed', token: current, failure: { class: 'transient', code: 'linear/detailUnavailable' } });
    });
  }, [activeSignal, execute, request, section]);
  React.useEffect(() => {
    readAuthority.current = request;
    dispatch({ kind: 'panelLeft' });
    if (active) load();
    return () => { token.current += 1; };
  }, [active, load]);
  if (readAuthority.current !== request || state.kind === 'idle' || state.kind === 'loading') return <LoadingState title={text('plugins.linear.detail.loading')} />;
  return <>
    {state.failure && <ErrorState title={describeTriageSourceFailureV1(state.failure, text('plugins.linear.detail.unavailable'), text)}
      action={<Button variant="secondary" title={text('plugins.linear.detail.retry')} onPress={() => load(state.continuation ?? undefined)} />} />}
    {state.kind === 'ready' && <>
      {state.rows.length === 0 ? <EmptyState title={text('plugins.linear.detail.empty')} />
        : <ItemGroup>{state.rows.map((entry) => entry.id === 'description' ? <Text key={entry.id}>{entry.title}</Text>
          : <Item key={entry.id} title={entry.title} subtitle={entry.body} />)}</ItemGroup>}
      {state.projectionTruncated && <Banner tone="attention" title={text('plugins.linear.detail.truncated')} />}
      {state.canLoadMore && <Button variant="secondary" title={text('plugins.linear.detail.more')} disabled={state.pending}
        onPress={() => load(state.continuation ?? undefined)} />}
    </>}
    {section === 'comments' ? <TriageActivityAgentTail /> : null}
  </>;
}

function LinearDetail(context: RenderContext): React.ReactElement {
  const text = usePluginTranslation();
  const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
  if (!parsed.success) return <ErrorState title={text('plugins.linear.detail.unavailable')} />;
  return <TriageDetailInstance><TriageDetailPanel panel={parsed.data.panel ?? 'overview'} ariaLabel="Linear"
    panels={Object.fromEntries(LINEAR_DETAIL_SECTIONS.map((section) => [section === 'comments' ? 'activity' : section,
      <ScrollArea key={section}><DetailSection input={parsed.data} section={section} /></ScrollArea>,
    ]))} /></TriageDetailInstance>;
}
export const renderSurface = defineUiSurface(LinearDetail);
