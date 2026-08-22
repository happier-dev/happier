/**
 * The panel-owned readers behind the Sentry detail body.
 *
 * Each reader's lifetime is the lifetime of the thing that owns its data, and
 * that is a structural fact here rather than a convention:
 *
 * - the **issue summary** is read at the detail root and scoped to the surface's
 *   own signal, because the Release association tab's very presence depends on
 *   it and a conditional tab cannot read its own condition;
 * - the **tag distribution**, its **value drill-down** and the **activity**
 *   history are read inside their panels and scoped to the panel's active
 *   interval, so leaving aborts the request, rejects a late result, and discards
 *   every Tier-B value the panel held (`SENTRY.md` §7.2b);
 * - the **retained-events** walk is likewise panel-scoped. Its tab declares
 *   `retain`, which buys its list geometry and nothing else: the reducer is
 *   reset the moment the panel becomes inactive, so a retained subtree never
 *   keeps event rows a reader is no longer looking at.
 *
 * No reader here holds a credential, builds a URL, or sees a raw provider body.
 * Each names its exact configured instance and entry and invokes one
 * source-owned Action; what comes back has already passed the boundary
 * projector.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
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

function useLocalRef(input: TriageDetailSurfaceInputV1) {
  const { entryRef } = input.observation;
  return useMemo(() => ({
    kindId: entryRef.kindId,
    collisionScope: entryRef.collisionScope,
    entryId: entryRef.entryId,
  }), [entryRef.collisionScope, entryRef.entryId, entryRef.kindId]);
}

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
  const localRef = useLocalRef(input);
  const [state, setState] = useState<SentryReadStateV1<SentryIssueSummaryV1>>({
    kind: 'loading',
  });

  useEffect(() => {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', abort);
    void (async () => {
      const execution = await execute({
        v: 1,
        instance: input.instance,
        localRef,
        projection: 'overview',
      }, { signal: controller.signal }) as ExecuteResult;
      if (controller.signal.aborted) return;
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
      controller.abort();
    };
  }, [execute, input.instance, localRef, signal]);

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
  const localRef = useLocalRef(input);
  const [state, setState] = useState<SentryReadStateV1<T>>({ kind: 'loading' });

  useEffect(() => {
    if (!active) return undefined;
    setState({ kind: 'loading' });
    let left = false;
    void (async () => {
      const execution = await execute({
        v: 1,
        instance: input.instance,
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
  }, [active, activeSignal, execute, input.instance, localRef, projection]);

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
function useSentryPagedWalk<TRow>(readPage: PageReader<TRow>): SentryPagedControllerV1<TRow> {
  const [state, dispatch] = useReducer(
    sentryPagedReducer<TRow>,
    undefined,
    sentryPagedInitialState<TRow>,
  );
  const { active, activeSignal } = useTabPanelActivity();
  const interval = useRef<AbortSignal | null>(null);
  const requested = useRef<Set<string>>(new Set());

  const runPage = useCallback(async (
    token: number,
    continuation: string | null,
    pageSignal: AbortSignal,
  ): Promise<void> => {
    dispatch({ kind: 'requestStarted', token });
    const outcome = await readPage(continuation, pageSignal);
    if (pageSignal.aborted) return;
    if (outcome.kind === 'failed') {
      dispatch({ kind: 'pageFailed', token, failure: outcome.failure });
      return;
    }
    dispatch({ kind: 'pageSettled', token, page: outcome.page });
  }, [readPage]);

  useEffect(() => {
    if (!active) return undefined;
    interval.current = activeSignal;
    requested.current = new Set();
    dispatch({ kind: 'panelLeft' });
    void runPage(1, null, activeSignal);
    return () => {
      interval.current = null;
      requested.current = new Set();
      dispatch({ kind: 'panelLeft' });
    };
  }, [active, activeSignal, runPage]);

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

export function useSentryOccurrences(
  input: TriageDetailSurfaceInputV1,
): SentryPagedControllerV1<SentryProjectedEventRowV1> {
  const action = useMemo(
    () => ({ pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.listIssueEvents }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const { instance } = input;

  const readPage: PageReader<SentryProjectedEventRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      limit: SENTRY_DETAIL_PAGE_SIZE,
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
  }, [execute, instance, localRef]);

  return useSentryPagedWalk(readPage);
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
  const localRef = useLocalRef(input);
  const { instance } = input;

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
