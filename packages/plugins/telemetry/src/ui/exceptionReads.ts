/**
 * The detail's collector reads: one paged occurrence walk and one stack read per opened occurrence.
 *
 * Both go through the telemetry occurrence Action, whose R16 admission decides once per request
 * that this viewer may read the Environment's telemetry. Nothing here is read until a panel that
 * shows it is open (P7 §13: bodies and stacks only on open), and the walk keeps the rows it already
 * has when a later page fails.
 */

import * as React from 'react';
import {
  useExecutePluginAction,
  type PluginActionExecution,
} from '@happier-dev/plugin-ui';
import { TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';

import { exceptionOccurrencesReadResultSchema } from '../exceptions/contracts.js';

export const TELEMETRY_PLUGIN_ID = 'happier.telemetry';

const OCCURRENCES_ACTION = Object.freeze({
  pluginId: TELEMETRY_PLUGIN_ID,
  localId: databaseActionLocalIdV1(
    TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1,
  ),
});

/** One page of the walk, newest first; the collector caps each read at its own row limit. */
const PAGE_LIMIT = 25;

/**
 * The Overview trend's window: the last seven days in two-hour steps, ending at the next whole
 * step so the buckets stay put between reads. Within the host's one-read bucket bound (84 of 100).
 */
export const EXCEPTION_TREND_SPAN_MS = 7 * 24 * 3_600_000;
export const EXCEPTION_TREND_BUCKET_MS = 2 * 3_600_000;
export type ExceptionTrendBucketV1 = Readonly<{ since: number; until: number; count: number }>;

function trendWindow(nowMs: number) {
  const until = Math.ceil(nowMs / EXCEPTION_TREND_BUCKET_MS) * EXCEPTION_TREND_BUCKET_MS;
  return { since: until - EXCEPTION_TREND_SPAN_MS, until, bucketMs: EXCEPTION_TREND_BUCKET_MS };
}

type OccurrencesResult = ReturnType<
  typeof exceptionOccurrencesReadResultSchema.parse
>;
export type ExceptionOccurrenceV1 = Extract<
  OccurrencesResult,
  { status: 'ok' }
>['items'][number];
type Cursor = NonNullable<
  Extract<OccurrencesResult, { status: 'ok' }>['nextCursor']
>;

/** Where this issue's occurrences live: the Environment on the viewer's Home, grouped by fingerprint. */
export type ExceptionOccurrenceAddressV1 = Readonly<{
  serverId: string;
  environmentId: string;
  fingerprint: string;
}>;

export type ExceptionReadFailureV1 = Readonly<{
  code: string;
  message: string;
}>;

export type ExceptionOccurrencesStateV1 =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'loading' }>
  /** Exceptions are off for this Environment: nothing is read from the collector. */
  | Readonly<{ kind: 'disabled' }>
  | Readonly<{ kind: 'unavailable'; failure: ExceptionReadFailureV1 }>
  | Readonly<{
      kind: 'ready';
      items: readonly ExceptionOccurrenceV1[];
      readAtMs: number;
      /** The group's counts per bucket and the distinct requests it reached, from the first page's window. */
      trend: readonly ExceptionTrendBucketV1[] | null;
      requestsAffected: number | null;
      hasMore: boolean;
      loadingMore: boolean;
      /** A later page or a re-read failed; the rows above stay at full strength. */
      failure: ExceptionReadFailureV1 | null;
    }>;

export type ExceptionStackStateV1 =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; stacktrace: string | null }>
  | Readonly<{ kind: 'unavailable'; failure: ExceptionReadFailureV1 }>;

export type ExceptionOccurrencesControllerV1 = Readonly<{
  state: ExceptionOccurrencesStateV1;
  /** The opened occurrence: the person's choice, otherwise the newest one read. */
  selected: ExceptionOccurrenceV1 | null;
  stack: ExceptionStackStateV1 | null;
  demand: () => void;
  retry: () => void;
  loadMore: () => void;
  select: (occurrenceId: string) => void;
  demandStack: () => void;
}>;

function failureOf(
  execution: PluginActionExecution<unknown>,
): ExceptionReadFailureV1 {
  if (execution.status === 'error' || execution.status === 'outcomeUnknown')
    return { code: execution.code, message: execution.message };
  return {
    code: 'telemetry_occurrences_unreadable',
    message: 'The collector answered in a shape this build cannot read.',
  };
}

type Read =
  | Readonly<{
      kind: 'ok';
      items: readonly ExceptionOccurrenceV1[];
      nextCursor?: Cursor;
      stacktrace?: string | null;
      trend?: readonly ExceptionTrendBucketV1[];
      requestsAffected?: number;
    }>
  | Readonly<{ kind: 'disabled' }>
  | Readonly<{ kind: 'failed'; failure: ExceptionReadFailureV1 }>;

function readOf(execution: PluginActionExecution<unknown>): Read | null {
  if (execution.status === 'pending' || execution.status === 'idle')
    return null;
  if (execution.status !== 'success')
    return { kind: 'failed', failure: failureOf(execution) };
  const parsed = exceptionOccurrencesReadResultSchema.safeParse(
    execution.result,
  );
  if (!parsed.success) return { kind: 'failed', failure: failureOf(execution) };
  if (parsed.data.status === 'disabled') return { kind: 'disabled' };
  return {
    kind: 'ok',
    items: parsed.data.items,
    ...(parsed.data.nextCursor ? { nextCursor: parsed.data.nextCursor } : {}),
    ...(parsed.data.stacktrace === undefined
      ? {}
      : { stacktrace: parsed.data.stacktrace }),
    ...(parsed.data.trend === undefined ? {} : { trend: parsed.data.trend }),
    ...(parsed.data.requestsAffected === undefined
      ? {}
      : { requestsAffected: parsed.data.requestsAffected }),
  };
}

const IDLE: ExceptionOccurrencesStateV1 = Object.freeze({ kind: 'idle' });

export function useExceptionOccurrences(
  address: ExceptionOccurrenceAddressV1 | null,
  signal: AbortSignal,
): ExceptionOccurrencesControllerV1 {
  const { execute: executeList } = useExecutePluginAction(OCCURRENCES_ACTION);
  const { execute: executeStack } = useExecutePluginAction(OCCURRENCES_ACTION);
  const [state, setState] = React.useState<ExceptionOccurrencesStateV1>(IDLE);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [stacks, setStacks] = React.useState<
    Readonly<Record<string, ExceptionStackStateV1>>
  >({});
  const stacksRef = React.useRef(stacks);
  const cursor = React.useRef<Cursor | undefined>(undefined);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const readPage = React.useCallback(
    async (mode: 'first' | 'more') => {
      if (address === null || signal.aborted) return;
      const before = mode === 'more' ? cursor.current : undefined;
      const execution = await executeList(
        {
          ...address,
          page: { limit: PAGE_LIMIT, ...(before ? { before } : {}) },
          // The first page also carries the Overview's trend and Requests affected: one read serves both.
          ...(mode === 'first' ? { window: trendWindow(Date.now()) } : {}),
        },
        { signal },
      );
      if (signal.aborted) return;
      const read = readOf(execution);
      if (read === null) return;
      setState((current) => {
        const retained = current.kind === 'ready' ? current : null;
        if (read.kind === 'disabled') return { kind: 'disabled' };
        if (read.kind === 'failed') {
          return retained === null
            ? { kind: 'unavailable', failure: read.failure }
            : { ...retained, loadingMore: false, failure: read.failure };
        }
        cursor.current = read.nextCursor;
        const items =
          mode === 'more' && retained !== null
            ? [...retained.items, ...read.items]
            : read.items;
        return {
          kind: 'ready',
          items,
          readAtMs: Date.now(),
          trend:
            mode === 'first' ? (read.trend ?? null) : (retained?.trend ?? null),
          requestsAffected:
            mode === 'first'
              ? (read.requestsAffected ?? null)
              : (retained?.requestsAffected ?? null),
          hasMore: read.nextCursor !== undefined,
          loadingMore: false,
          failure: null,
        };
      });
    },
    [address, executeList, signal],
  );

  const demand = React.useCallback(() => {
    if (stateRef.current.kind !== 'idle') return;
    setState({ kind: 'loading' });
    void readPage('first');
  }, [readPage]);

  const retry = React.useCallback(() => {
    // A failed first read shows the reading state again; retained rows stay while the walk restarts.
    if (stateRef.current.kind !== 'ready') setState({ kind: 'loading' });
    void readPage('first');
  }, [readPage]);

  const loadMore = React.useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== 'ready' || !current.hasMore || current.loadingMore)
      return;
    setState({ ...current, loadingMore: true, failure: null });
    void readPage('more');
  }, [readPage]);

  const items = state.kind === 'ready' ? state.items : null;
  const selected =
    items === null
      ? null
      : (items.find((item) => item.id === selectedId) ?? items[0] ?? null);
  const selectedKey = selected?.id ?? null;

  const demandStack = React.useCallback(() => {
    if (address === null || selectedKey === null || signal.aborted) return;
    const occurrenceId = selectedKey;
    const known = stacksRef.current[occurrenceId];
    if (known !== undefined && known.kind !== 'unavailable') return;
    stacksRef.current = { ...stacksRef.current, [occurrenceId]: { kind: 'loading' } };
    setStacks(stacksRef.current);
    void (async () => {
      const execution = await executeStack(
        { ...address, page: { limit: 1 }, occurrenceId },
        { signal },
      );
      if (signal.aborted) return;
      const read = readOf(execution);
      if (read === null) return;
      const next: ExceptionStackStateV1 =
        read.kind === 'ok'
          ? { kind: 'ready', stacktrace: read.stacktrace ?? null }
          : {
              kind: 'unavailable',
              failure:
                read.kind === 'failed'
                  ? read.failure
                  : {
                      code: 'telemetry_exceptions_disabled',
                      message: 'Exceptions are off for this Environment.',
                    },
            };
      stacksRef.current = { ...stacksRef.current, [occurrenceId]: next };
      setStacks(stacksRef.current);
    })();
  }, [address, executeStack, selectedKey, signal]);

  return {
    state,
    selected,
    stack: selectedKey === null ? null : (stacks[selectedKey] ?? null),
    demand,
    retry,
    loadMore,
    select: setSelectedId,
    demandStack,
  };
}
