import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Banner, Button, EmptyState, ErrorState, Item, ItemGroup, LoadingState, ScrollArea,
  Text, defineUiSurface, useExecutePluginAction, usePluginTranslation, useSurfaceContext, useTabPanelActivity,
} from '@happier-dev/plugin-ui';
import {
  TriageActivityTimeline, TriageDetailInstance, TriageDetailPanel, TriageSourceCommentComposer, TriageSourcePartialReadBanner,
  useTriageDetailRequest, type TriageActivityEventV1,
} from '@happier-dev/triage-sources/ui';
import {
  TriageDetailSurfaceInputV1Schema, triagePagedPanelInitialState, triagePagedPanelReducer,
  describeTriageSourceFailureV1, type TriageDetailSurfaceInputV1, type TriageSourceFailureV1,
  type TriagePagedPanelEventV1, type TriagePagedPanelStateV1,
} from '@happier-dev/triage-protocol/v1';
import {
  LINEAR_ACTIONS, LINEAR_PLUGIN_ID, LINEAR_DETAIL_SECTIONS, LinearCommentInputSchema, LinearDetailResultSchema,
  type LinearDetailInput, type LinearDetailEntrySchema,
} from '../contracts.js';

const action = { pluginId: LINEAR_PLUGIN_ID, localId: LINEAR_ACTIONS.detail };
const commentAction = { pluginId: LINEAR_PLUGIN_ID, localId: LINEAR_ACTIONS.comment };
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
    // A read from the first page replaces the walk (a reread after a comment); a continuation extends it.
    dispatch({ kind: after === undefined ? 'refreshStarted' : 'requestStarted', token: current });
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
  const webUrl = input.observation.locator.webUrl;
  const composer = section !== 'comments' ? null : <TriageSourceCommentComposer action={commentAction}
    buildInput={(body) => { const parsed = LinearCommentInputSchema.safeParse({ v: 1, ...request, body }); return parsed.success ? parsed.data : null; }}
    sourceName="Linear" {...(webUrl === undefined ? {} : { sourceUrl: webUrl })} onPublished={() => load()}
    internal={{ anchor: input.observation.entryRef }} />;
  if (section === 'comments') return <LinearActivity state={state} load={load} composer={composer} />;
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
  </>;
}

/**
 * Linear's comments as the entry's Activity: the shared timeline every source draws, each remark marked by its author,
 * with Linear's paging, the comment box and the agent's card on the same rail.
 */
function LinearActivity({ state, load, composer }: Readonly<{
  state: TriagePagedPanelStateV1<Entry, TriageSourceFailureV1>;
  load: (after?: string) => void;
  composer: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const nowMs = Date.now();
  const commented = text('plugins.linear.activity.commented', 'Commented');
  const events = React.useMemo<readonly TriageActivityEventV1[]>(() => state.rows.map((entry) => ({
    id: entry.id, atMs: entry.atMs ?? null, kind: 'comment', actor: entry.author ?? null, summary: commented,
    ...(entry.body === undefined ? {} : { quote: entry.body }),
  })), [state.rows, commented]);
  const readFailed = text('plugins.linear.detail.unavailable', 'Linear issue details are unavailable on this surface.');
  if (state.kind === 'unavailable' && state.failure !== null) {
    return <ErrorState title={describeTriageSourceFailureV1(state.failure, readFailed, text)}
      action={<Button variant="secondary" title={text('plugins.linear.detail.retry', 'Try again')} onPress={() => load()} />} />;
  }
  return <TriageActivityTimeline
    events={events}
    locale={locale}
    nowMs={nowMs}
    accessibilityLabel="Comments on this Linear issue"
    accessibilityLabelKey="plugins.linear.activity.label"
    header={state.failure === null && !state.projectionTruncated ? undefined : <>
      <TriageSourcePartialReadBanner failure={state.failure} readFailed={readFailed} />
      {state.projectionTruncated ? <Banner tone="attention" title={text('plugins.linear.detail.truncated')} /> : null}
    </>}
    empty={<EmptyState title="No comments yet" titleKey="plugins.linear.activity.empty"
      description="Comments on this issue in Linear appear here." descriptionKey="plugins.linear.activity.empty.description" />}
    continuations={state.canLoadMore ? [{
      key: 'comments', title: 'Show more comments', titleKey: 'plugins.linear.activity.more', pending: state.pending,
      onLoadMore: () => load(state.continuation ?? undefined),
    }] : []}
    refresh={{ label: 'Re-read the comments from Linear', labelKey: 'plugins.linear.activity.refresh', pending: state.pending,
      onRefresh: () => load() }}
    footer={composer}
  />;
}

function LinearDetail(context: RenderContext): React.ReactElement {
  const text = usePluginTranslation();
  const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
  if (!parsed.success) return <ErrorState title={text('plugins.linear.detail.unavailable')} />;
  return <TriageDetailInstance scrollOwner={parsed.data.panelScrollOwner}><TriageDetailPanel scrollOwner={parsed.data.panelScrollOwner} panel={parsed.data.panel ?? 'overview'} ariaLabel="Linear"
    panels={Object.fromEntries(LINEAR_DETAIL_SECTIONS.map((section) => [section === 'comments' ? 'activity' : section,
      section === 'comments' ? <DetailSection key={section} input={parsed.data} section={section} />
        : <ScrollArea key={section}><DetailSection input={parsed.data} section={section} /></ScrollArea>,
    ]))} /></TriageDetailInstance>;
}
export const renderSurface = defineUiSurface(LinearDetail);
