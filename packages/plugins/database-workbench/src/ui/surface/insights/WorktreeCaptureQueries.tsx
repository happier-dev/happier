import * as React from 'react';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import {
  DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
  DATABASE_CAPTURE_RESOURCE_REF_V1,
  DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
  DatabaseCaptureQueriesListResultV1Schema,
  DatabaseCaptureQueryGetResultV1Schema,
  DatabaseCaptureTraceGetResultV1Schema,
  type DatabaseActionIdV1,
  type DatabaseCaptureCursorV1,
  type DatabaseCaptureQueriesListResultV1,
  type DatabaseCaptureQueryGetResultV1,
  type DatabaseCaptureSummaryV1,
  type DatabaseCaptureTraceGetResultV1,
  type DatabaseFailureV1,
  type DatabaseWorktreeTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { Button, ErrorState, Item, ItemGroup, Stack, Text, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { CaptureQueries } from '@happier-dev/plugin-ui/components';
import { usePluginHostApi } from '@happier-dev/plugin-ui/hostApi';

const limit = PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows;

function selectedWorktree(databaseTarget: DatabaseWorktreeTargetV1) {
  const { workspace, projectKey } = databaseTarget;
  const machineId = workspace.kind === 'managed' ? workspace.controller.machineId : workspace.machineId;
  return {
    source: { kind: 'worktree' as const, serverId: workspace.serverId, machineId, workspaceId: workspace.workspaceId, projectId: projectKey },
    databaseTarget,
  };
}

type Selection = ReturnType<typeof selectedWorktree>;

type ReadState<TResult> =
  | { kind: 'pending' }
  | { kind: 'ready'; value: TResult }
  | { kind: 'failed'; details?: string };

function failureDetails(failure: DatabaseFailureV1) {
  const reason = ('cause' in failure ? failure.cause?.message : undefined) ?? ('reason' in failure ? failure.reason : undefined);
  return reason ? `${failure.code} (${reason})` : failure.code;
}

/** Mount a finite read with its demand. Changing the selected item or closing the panel ends that read. */
function useCaptureRead<TResult extends { ok: true }>(
  id: DatabaseActionIdV1,
  input: object,
  parse: (raw: unknown) => TResult | DatabaseFailureV1,
) {
  const host = usePluginHostApi();
  const [state, setState] = React.useState<ReadState<TResult>>({ kind: 'pending' });
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  React.useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({ kind: 'pending' });
    async function read() {
      try {
        const result = parse(await host.executeAction({
          pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId, localId: databaseActionLocalIdV1(id),
        }, projectNativeJsonValueForTransport(input), { signal }));
        if (signal.aborted) return;
        setState(result.ok ? { kind: 'ready', value: result } : { kind: 'failed', details: failureDetails(result) });
      } catch (error) {
        if (signal.aborted) return;
        setState(isPluginError(error) ? { kind: 'failed', details: error.code } : { kind: 'failed' });
      }
    }
    void read();
    return () => controller.abort();
  }, [host, id, input, parse, attempt]);
  return { state, retry };
}

function CaptureReadStatus({ state, retry }: Readonly<{
  state: Exclude<ReadState<unknown>, { kind: 'ready' }>;
  retry: () => void;
}>) {
  const t = usePluginTranslation();
  if (state.kind === 'pending') return <Text tone="secondary">{t('plugins.database.capture.reading', 'Reading capture…')}</Text>;
  return <ErrorState layout="line"
    title={t('plugins.database.capture.readFailed', 'Capture could not be read')}
    details={state.details} onRetry={retry} retryLabel={t('plugins.database.retry', 'Try again')} />;
}

export function WorktreeCaptureQueries({ target }: Readonly<{ target: DatabaseWorktreeTargetV1 }>) {
  const selection = React.useMemo(() => selectedWorktree(target), [target]);
  // Another database starts its own list at the newest page.
  return <CaptureQueryList key={JSON.stringify(selection.source)} selection={selection} />;
}

/**
 * The statements the app ran, through the capture owner's Queries list: a row opens its statement beside the list
 * (pushed in its place where both do not fit), and "Show older" adds the next page below the rows already read.
 */
function CaptureQueryList({ selection }: Readonly<{ selection: Selection }>) {
  const { locale } = useSurfaceContext();
  const [before, setBefore] = React.useState<DatabaseCaptureCursorV1 | undefined>();
  const [earlier, setEarlier] = React.useState<readonly DatabaseCaptureSummaryV1[]>([]);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const input = React.useMemo(() => ({
    ...selection, page: { limit, ...(before ? { before } : {}) },
  }), [selection, before]);
  const { state, retry } = useCaptureRead<Extract<DatabaseCaptureQueriesListResultV1, { ok: true }>>(
    DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, input, DatabaseCaptureQueriesListResultV1Schema.parse);
  const page = state.kind === 'ready' ? state.value : null;
  const items = React.useMemo(() => page ? [...earlier, ...page.items] : earlier, [earlier, page]);
  const detail = React.useMemo(() => ({
    openId,
    onOpenChange: setOpenId,
    render: (query: DatabaseCaptureSummaryV1) => <CaptureQueryDetail key={query.id} selection={selection} query={query} />,
  }), [openId, selection]);
  const next = page?.nextCursor;
  const more = next
    ? { onPress: () => { setEarlier(items); setBefore(next); }, busy: false }
    : state.kind === 'pending' && earlier.length ? { onPress: () => undefined, busy: true } : null;
  if (state.kind === 'failed' && !earlier.length) return <CaptureReadStatus state={state} retry={retry} />;
  return <Stack gap="medium" grow>
    <CaptureQueries items={items} loading={state.kind === 'pending' && !earlier.length} locale={locale}
      detail={detail} more={more} />
    {state.kind === 'failed' ? <CaptureReadStatus state={state} retry={retry} /> : null}
  </Stack>;
}

function CaptureQueryDetail({ selection, query }: Readonly<{
  selection: Selection;
  query: DatabaseCaptureSummaryV1;
}>) {
  const t = usePluginTranslation();
  const input = React.useMemo(() => ({ ...selection, id: query.id }), [selection, query.id]);
  const { state, retry } = useCaptureRead<Extract<DatabaseCaptureQueryGetResultV1, { ok: true }>>(
    DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1, input, DatabaseCaptureQueryGetResultV1Schema.parse);
  const [inspect, setInspect] = React.useState(false);
  if (state.kind !== 'ready') return <CaptureReadStatus state={state} retry={retry} />;
  const sql = state.value.detail?.sql;
  return <Stack gap="small">
    {typeof sql === 'string' ? <Text variant="code" value={sql} /> : <Text tone="secondary">
      {t('plugins.database.capture.noStatementDetail', 'No captured statement detail')}
    </Text>}
    {query.traceId ? inspect
      ? <CaptureRequestDetail selection={selection} traceId={query.traceId} />
      : <Button size="small" variant="secondary"
        title={t('plugins.database.capture.inspectRequest', 'Inspect request')} onPress={() => setInspect(true)} />
      : null}
  </Stack>;
}

function CaptureRequestDetail({ selection, traceId }: Readonly<{ selection: Selection; traceId: string }>) {
  const t = usePluginTranslation();
  const input = React.useMemo(() => ({ ...selection, traceId, page: { limit } }), [selection, traceId]);
  const { state, retry } = useCaptureRead<Extract<DatabaseCaptureTraceGetResultV1, { ok: true }>>(
    DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input, DatabaseCaptureTraceGetResultV1Schema.parse);
  if (state.kind !== 'ready') return <CaptureReadStatus state={state} retry={retry} />;
  const findings = state.value.repeatedQueries.filter(query => query.kind === 'suspected_n_plus_one');
  if (!findings.length) return <Text tone="secondary">
    {t('plugins.database.capture.noLikelyNPlusOne', 'No likely N+1 queries in this request')}
  </Text>;
  return <ItemGroup title={t('plugins.database.capture.likelyNPlusOne', 'Likely N+1')}>
    {findings.map(query => <Item key={JSON.stringify([query.requestSpanId, query.shape])}
      title={`${query.shape} × ${query.repetitionCount}`} identifier subtitle={query.explanation} />)}
  </ItemGroup>;
}
