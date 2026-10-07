/**
 * The panel-owned readers behind the Sentry detail body.
 *
 * Each reader's lifetime is the lifetime of the thing that owns its data, and
 * that is a structural fact here rather than a convention:
 *
 * - the **issue summary** is read at the detail root and scoped to the surface's
 *   root active interval, because the Release association tab's very presence depends on
 *   it and a conditional tab cannot read its own condition;
 * - the **tag distribution**, its **value drill-down** and the **activity**
 *   history are read inside their panels and scoped to the panel's active
 *   interval, so leaving aborts the request, rejects a late result, and discards
 *   every Tier-B value the panel held (`SENTRY.md` §7.2b);
 * - the **retained-events** walk is likewise panel-scoped. Its tab declares
 *   `retain`, preserving settled allowlisted pages and their paging position
 *   within this exact detail. Leaving aborts only unsettled paging work.
 *
 * No reader here holds a credential, builds a URL, or sees a raw provider body.
 * Each names its exact configured instance and entry and invokes one
 * source-owned Action; what comes back has already passed the boundary
 * projector.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest as useSentryDetailRequest } from '@happier-dev/triage-sources/ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
  SENTRY_DETAIL_PAGE_SIZE,
  SentryIssueEventsResultV1Schema,
  SentryReadIssueResultV1Schema,
  SentryTagValuesResultV1Schema,
} from '../../detail/detailContracts.js';
import type {
  SentryProjectedActivityItemV1,
  SentryProjectedEventRowV1,
  SentryProjectedTagV1,
  SentryProjectedTagValueV1,
} from '../../detail/detailProjection.js';
import { SENTRY_ACTION_IDS, SENTRY_PLUGIN_ID } from '../../sentryContracts.js';

import {
  sentryPagedInitialState,
  sentryPagedReducer,
  type SentryPagedPageV1,
  type SentryPagedStateV1,
  type SentryReadStateV1,
} from './panelState.js';

/** A result the surface could not read is a contract break, not an empty read. */
const UNREADABLE_RESULT: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'sentry-detail-result-unreadable',
});

function dispatchFailure(status: string, code: string): TriageSourceFailureV1 {
  return Object.freeze({
    class: status === 'error' ? 'transient' : 'unknown',
    code: status === 'idle' || status === 'pending' ? 'sentry-detail-read-not-dispatched' : code,
  });
}

export { useSentryDetailRequest };

type ExecuteResult = Readonly<{ status: string; result?: unknown; code?: string }>;

function readIssueResult(result: unknown) {
  const parsed = SentryReadIssueResultV1Schema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------- issue summary */

export type SentryIssueSummaryV1 = Readonly<{
  nativeStateLabel?: string;
  statePresentation: 'active' | 'resolved' | 'suppressed' | 'closed' | 'unknown';
  eventCount?: string;
  userCount?: number;
  firstSeenAtMs?: number;
  lastSeenAtMs?: number;
  firstRelease?: Readonly<{
    version: string;
    dateCreatedAtMs?: number;
    dateReleasedAtMs?: number;
  }>;
  lastRelease?: Readonly<{
    version: string;
    dateCreatedAtMs?: number;
    dateReleasedAtMs?: number;
  }>;
  /** The last 24 hours of events, hourly, oldest first. */
  eventTrend?: readonly Readonly<{ atMs: number; count: number }>[];
}>;

/**
 * The detail root's one Tier-A summary read.
 *
 * It is aborted with the surface, so a late result cannot replace the body of a
 * detail the reader has already left. It carries no tag value, no activity
 * record and no event row: the detail root deliberately holds none of them.
 */
export function useSentryIssueSummary(
  input: TriageDetailSurfaceInputV1,
  signal: AbortSignal,
): SentryReadStateV1<SentryIssueSummaryV1> {
  const action = useMemo(
    () => ({ pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.readIssue }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { active, activeSignal } = useTabPanelActivity();
  const request = useSentryDetailRequest(input);
  const { instance, localRef } = request;
  const [state, setState] = useState<SentryReadStateV1<SentryIssueSummaryV1>>({
    kind: 'loading',
  });
  const previousRequest = useRef(request);
  const settledRequest = useRef<typeof request | null>(null);
  if (previousRequest.current !== request) {
    previousRequest.current = request;
    setState({ kind: 'loading' });
  }

  useEffect(() => {
    if (!active || activeSignal.aborted || signal.aborted || settledRequest.current === request) return undefined;
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', abort);
    activeSignal.addEventListener('abort', abort);
    void (async () => {
      const execution = await execute({
        v: 1,
        instance,
        localRef,
        projection: 'overview',
      }, { signal: controller.signal }) as ExecuteResult;
      if (controller.signal.aborted) return;
      settledRequest.current = request;
      if (execution.status !== 'success') {
        setState({
          kind: 'unavailable',
          failure: dispatchFailure(execution.status, execution.code ?? 'sentry-detail-read-failed'),
        });
        return;
      }
      const parsed = readIssueResult(execution.result);
      if (parsed === null) {
        setState({ kind: 'unavailable', failure: UNREADABLE_RESULT });
        return;
      }
      if (parsed.kind === 'unavailable') {
        setState({ kind: 'unavailable', failure: parsed.failure });
        return;
      }
      if (parsed.kind !== 'overview') {
        setState({ kind: 'unavailable', failure: UNREADABLE_RESULT });
        return;
      }
      const { kind: _kind, ...summary } = parsed;
      setState({ kind: 'ready', value: summary as SentryIssueSummaryV1 });
    })();
    return () => {
      signal.removeEventListener('abort', abort);
      activeSignal.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [active, activeSignal, execute, instance, localRef, request, signal]);

  return state;
}

/* --------------------------------------------------- panel-local single read */

/**
 * Reads one Tier-B projection for exactly as long as its panel is active.
 *
 * The active interval is the whole lifetime: leaving aborts the in-flight read
 * and returns the panel to `loading`, so a reader never sees a record set nobody
 * is reading any more.
 */
function useSentryPanelProjection<T>(
  input: TriageDetailSurfaceInputV1,
  projection: 'tags' | 'activity',
  select: (result: NonNullable<ReturnType<typeof readIssueResult>>) => T | null,
): SentryReadStateV1<T> {
  const action = useMemo(
    () => ({ pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.readIssue }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { active, activeSignal } = useTabPanelActivity();
  const { instance, localRef } = useSentryDetailRequest(input);
  const [state, setState] = useState<SentryReadStateV1<T>>({ kind: 'loading' });

  useEffect(() => {
    if (!active) return undefined;
    setState({ kind: 'loading' });
    let left = false;
    void (async () => {
      const execution = await execute({
        v: 1,
        instance,
        localRef,
        projection,
      }, { signal: activeSignal }) as ExecuteResult;
      if (left || activeSignal.aborted) return;
      if (execution.status !== 'success') {
        setState({
          kind: 'unavailable',
          failure: dispatchFailure(execution.status, execution.code ?? 'sentry-detail-read-failed'),
        });
        return;
      }
      const parsed = readIssueResult(execution.result);
      if (parsed === null) {
        setState({ kind: 'unavailable', failure: UNREADABLE_RESULT });
        return;
      }
      if (parsed.kind === 'unavailable') {
        setState({ kind: 'unavailable', failure: parsed.failure });
        return;
      }
      const selected = select(parsed);
      setState(selected === null
        ? { kind: 'unavailable', failure: UNREADABLE_RESULT }
        : { kind: 'ready', value: selected });
    })();
    return () => {
      left = true;
      setState({ kind: 'loading' });
    };
    // `select` is a render-stable selector supplied by the concrete hooks below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeSignal, execute, instance, localRef, projection]);

  return state;
}

export type SentryTagDistributionV1 = Readonly<{
  tags: readonly SentryProjectedTagV1[];
  omittedTagCount: number;
  projectionTruncated: boolean;
}>;

const selectTags = (
  result: NonNullable<ReturnType<typeof readIssueResult>>,
): SentryTagDistributionV1 | null => (result.kind === 'tags'
  ? {
    tags: result.tags,
    omittedTagCount: result.omittedTagCount,
    projectionTruncated: result.projectionTruncated,
  }
  : null);

export function useSentryTagDistribution(
  input: TriageDetailSurfaceInputV1,
): SentryReadStateV1<SentryTagDistributionV1> {
  return useSentryPanelProjection(input, 'tags', selectTags);
}

export type SentryActivityHistoryV1 =
  | Readonly<{
    status: 'available';
    items: readonly SentryProjectedActivityItemV1[];
    malformedItemCount: number;
    omittedItemCount: number;
    projectionTruncated: boolean;
  }>
  | Readonly<{ status: 'unavailable' }>;

const selectActivity = (
  result: NonNullable<ReturnType<typeof readIssueResult>>,
): SentryActivityHistoryV1 | null => (result.kind === 'activity'
  ? result.activity as SentryActivityHistoryV1
  : null);

export function useSentryActivityHistory(
  input: TriageDetailSurfaceInputV1,
): SentryReadStateV1<SentryActivityHistoryV1> {
  return useSentryPanelProjection(input, 'activity', selectActivity);
}

/* ---------------------------------------------------------- paged panels */

export type SentryPagedControllerV1<TRow> = Readonly<{
  state: SentryPagedStateV1<TRow>;
  loadMore: () => void;
}>;

type PageReader<TRow> = (
  continuation: string | null,
  signal: AbortSignal,
) => Promise<Readonly<{ kind: 'page'; page: SentryPagedPageV1<TRow> }>
| Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>>;

/**
 * Drives one paged walk for one mounted panel.
 *
 * The walk refuses to request a position it has already requested in this
 * interval. A provider that keeps advertising the same cursor would otherwise
 * make the panel read the same page forever, and the read module's own
 * non-advancing guard only sees one response at a time.
 */
function useSentryPagedWalk<TRow>(
  readPage: PageReader<TRow>,
  retainSettledPages = false,
): SentryPagedControllerV1<TRow> {
  const [state, dispatch] = useReducer(
    sentryPagedReducer<TRow>,
    undefined,
    sentryPagedInitialState<TRow>,
  );
  const { active, activeSignal } = useTabPanelActivity();
  const interval = useRef<AbortSignal | null>(null);
  const requested = useRef<Set<string>>(new Set());
  const currentState = useRef(state);
  currentState.current = state;
  const previousReader = useRef(readPage);

  const runPage = useCallback(async (
    token: number,
    continuation: string | null,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    dispatch({ kind: 'requestStarted', token });
    const outcome = await readPage(continuation, pageSignal);
    if (pageSignal.aborted) return;
    if (outcome.kind === 'failed') {
      // Only a cursor this walk actually consumed may be refused a second time.
      // A page that failed was never read, and the reader is looking at an
      // enabled Load more for it — so the guard must let that press through.
      if (continuation !== null) requested.current.delete(continuation);
      dispatch({ kind: 'pageFailed', token, failure: outcome.failure });
      return;
    }
    dispatch({ kind: 'pageSettled', token, page: outcome.page });
  }, [readPage]);

  useEffect(() => {
    const readerChanged = previousReader.current !== readPage;
    previousReader.current = readPage;
    if (readerChanged) {
      requested.current = new Set();
      dispatch({ kind: 'panelLeft' });
    }
    if (!active) return undefined;
    interval.current = activeSignal;
    if (readerChanged || !retainSettledPages || currentState.current.kind !== 'ready') {
      requested.current = new Set();
      dispatch({ kind: 'panelLeft' });
      void runPage(1, null, activeSignal);
    }
    return () => {
      interval.current = null;
      if (retainSettledPages && currentState.current.kind === 'ready') {
        if (currentState.current.pending && currentState.current.continuation !== null) {
          requested.current.delete(currentState.current.continuation);
        }
        dispatch({ kind: 'walkAbandoned' });
      } else {
        requested.current = new Set();
        dispatch({ kind: 'panelLeft' });
      }
    };
  }, [active, activeSignal, readPage, retainSettledPages, runPage]);

  const loadMore = useCallback(() => {
    const pageSignal = interval.current;
    const next = state.continuation;
    if (!state.canLoadMore || state.pending || next === null || pageSignal === null) return;
    if (requested.current.has(next)) return;
    requested.current.add(next);
    void runPage(state.token + 1, next, pageSignal);
  }, [runPage, state.canLoadMore, state.continuation, state.pending, state.token]);

  return useMemo(() => ({ state, loadMore }), [loadMore, state]);
}

/**
 * The retained-events walk, in the ordering the reader chose.
 *
 * `sample` is part of the walk rather than of one request: `[SCHEMA]`
 * `sample=true` reorders the same retained events, so changing it changes which
 * collection is being paged. Changing it therefore restarts the walk at its
 * first page — the reader's own choice replaces the list rather than appending a
 * differently ordered tail to it (`SENTRY.md` §7.4).
 */
export function useSentryOccurrences(
  input: TriageDetailSurfaceInputV1,
  sample = false,
): SentryPagedControllerV1<SentryProjectedEventRowV1> {
  const action = useMemo(
    () => ({ pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.listIssueEvents }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useSentryDetailRequest(input);

  const readPage: PageReader<SentryProjectedEventRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      limit: SENTRY_DETAIL_PAGE_SIZE,
      ...(sample ? { sample: true } : {}),
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'sentry-detail-read-failed'),
      };
    }
    const parsed = SentryIssueEventsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return {
      kind: 'page' as const,
      page: {
        rows: parsed.data.rows,
        omittedRowCount: parsed.data.omittedRowCount,
        projectionTruncated: parsed.data.projectionTruncated,
        continuation: parsed.data.continuation ?? null,
        // A walk that stopped short says so; absent means the walk ended at the
        // end of the collection, which is a different answer.
        incomplete: parsed.data.incomplete ?? null,
      },
    };
  }, [execute, instance, localRef, sample]);

  return useSentryPagedWalk(readPage, true);
}

export function useSentryTagValues(
  input: TriageDetailSurfaceInputV1,
  tagKey: string,
): SentryPagedControllerV1<SentryProjectedTagValueV1> {
  const action = useMemo(
    () => ({ pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.listTagValues }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useSentryDetailRequest(input);

  const readPage: PageReader<SentryProjectedTagValueV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      tagKey,
      limit: SENTRY_DETAIL_PAGE_SIZE,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'sentry-detail-read-failed'),
      };
    }
    const parsed = SentryTagValuesResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return {
      kind: 'page' as const,
      page: {
        rows: parsed.data.rows,
        omittedRowCount: parsed.data.omittedRowCount,
        projectionTruncated: parsed.data.projectionTruncated,
        continuation: parsed.data.continuation ?? null,
        // A walk that stopped short says so; absent means the walk ended at the
        // end of the collection, which is a different answer.
        incomplete: parsed.data.incomplete ?? null,
      },
    };
  }, [execute, instance, localRef, tagKey]);

  return useSentryPagedWalk(readPage);
}
