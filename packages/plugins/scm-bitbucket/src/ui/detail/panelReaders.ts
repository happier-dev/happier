import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import { projectTriageSourceReadFailureV1 } from '@happier-dev/triage-sources/runtime';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import type {
  BitbucketProjectedActivityRowV1,
  BitbucketProjectedCommentRowV1,
  BitbucketProjectedDiffstatRowV1,
  BitbucketProjectedStatusRowV1,
} from '../../triage/detail/projection.js';
import {
  BITBUCKET_TRIAGE_DETAIL_ACTION_IDS,
  BitbucketActivityResultV1Schema,
  BitbucketBuildsResultV1Schema,
  BitbucketCommentsResultV1Schema,
  BitbucketDiffResultV1Schema,
  BitbucketOverviewResultV1Schema,
} from '../../triage/source/detailContracts.js';

import {
  bitbucketPagedInitialState,
  bitbucketPagedReducer,
  type BitbucketDetailIncompleteReasonV1,
  type BitbucketPagedPageV1,
  type BitbucketPagedStateV1,
} from './panelState.js';
import { BITBUCKET_DETAIL_TABS_V1 } from './tabDeclarations.js';

/**
 * The panel-owned readers behind the Bitbucket Cloud detail body.
 *
 * Each reader's lifetime is the lifetime of the panel that owns its data, and
 * that is a structural fact here rather than a convention: every read below is
 * scoped to its panel's active interval, so leaving aborts the request, rejects
 * a late result, and preserves settled presentation only for a declared retained panel.
 *
 * That lifetime is also the rate budget. Nothing here fetches on mount of the
 * detail surface: a plane's first request is issued when its tab becomes active
 * and never before.
 *
 * No reader holds a credential, builds a URL, or sees a raw provider body. Each
 * names its exact configured workspace and entry and invokes one source-owned
 * Action; what comes back has already passed the boundary projector.
 */

/** A result the surface could not read is a contract break, not an empty read. */
const UNREADABLE_RESULT: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'bitbucket-detail-result-unreadable',
});

function dispatchFailure(execution: ExecuteResult, fallbackCode: string): TriageSourceFailureV1 {
  return projectTriageSourceReadFailureV1(execution, fallbackCode, 'bitbucket-detail-read-not-dispatched');
}

type ExecuteResult = PluginActionExecution;

/** Provider routing changes independently of the canonical request authority. */
function useBitbucketLocator(input: TriageDetailSurfaceInputV1) {
  const { webUrl, displayPath, routingToken } = input.observation.locator;
  return useMemo(() => ({
    v: 1 as const,
    ...(webUrl === undefined ? {} : { webUrl }),
    ...(displayPath === undefined ? {} : { displayPath }),
    ...(routingToken === undefined ? {} : { routingToken }),
  }), [webUrl, displayPath, routingToken]);
}

export type BitbucketPagedControllerV1<TRow> = Readonly<{
  state: BitbucketPagedStateV1<TRow>;
  loadMore: () => void;
  /**
   * Restarts the walk at the first page.
   *
   * Refresh in a detail panel is explicit and reader-initiated; there is no
   * automatic poll inside a tab, because a tab that re-reads on its own spends
   * Bitbucket's rate budget for a reader who is not looking.
   */
  refresh: () => void;
}>;

type PageReader<TRow> = (
  continuation: string | null,
  signal: AbortSignal,
) => Promise<Readonly<{ kind: 'page'; page: BitbucketPagedPageV1<TRow> }>
| Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>>;

/**
 * Drives one paged walk for one mounted panel.
 *
 * The walk refuses to request a position it has already requested in this
 * interval. A provider that kept advertising the same page would otherwise make
 * the panel read it forever.
 */
function useBitbucketPagedWalk<TRow>(
  readPage: PageReader<TRow>,
  retention: 'retain' | 'discard' = 'discard',
): BitbucketPagedControllerV1<TRow> {
  const [state, dispatch] = useReducer(
    bitbucketPagedReducer<TRow>,
    undefined,
    bitbucketPagedInitialState<TRow>,
  );
  const { active, activeSignal } = useTabPanelActivity();
  const interval = useRef<AbortSignal | null>(null);
  const requested = useRef<Set<string>>(new Set());
  const settledReader = useRef<PageReader<TRow> | null>(null);
  const pendingPosition = useRef<string | null>(null);
  /**
   * Monotonic across the panel's whole life, never derived from the reducer.
   *
   * A refresh resets the reducer, so a token read back from state would restart
   * at a value an in-flight request already holds — and that request's result
   * would then be accepted into the walk it was meant to replace.
   */
  const nextToken = useRef(0);

  const runPage = useCallback(async (
    token: number,
    continuation: string | null,
    pageSignal: AbortSignal,
    start: 'request' | 'refresh' = 'request',
  ): Promise<void> => {
    pendingPosition.current = continuation;
    dispatch(start === 'refresh'
      ? { kind: 'refreshStarted', token }
      : { kind: 'requestStarted', token });
    const outcome = await readPage(continuation, pageSignal);
    if (pageSignal.aborted) return;
    pendingPosition.current = null;
    if (outcome.kind === 'failed') {
      // Only a position this walk actually consumed may be refused a second time. A page that
      // failed was never read, and the reader is looking at an enabled control for it.
      if (continuation !== null) requested.current.delete(continuation);
      dispatch({ kind: 'pageFailed', token, failure: outcome.failure });
      return;
    }
    settledReader.current = readPage;
    dispatch({ kind: 'pageSettled', token, page: outcome.page });
  }, [readPage]);

  const startWalk = useCallback((
    pageSignal: AbortSignal,
    start: 'request' | 'refresh',
  ): void => {
    requested.current = new Set();
    // A refresh replaces the walk warm: the reducer keeps the last-known-good rows visible until
    // the new first page settles, so a refresh that fails leaves the reader what they had rather
    // than an empty panel.
    if (start === 'request') {
      settledReader.current = null;
      dispatch({ kind: 'panelLeft' });
    }
    nextToken.current += 1;
    void runPage(nextToken.current, null, pageSignal, start);
  }, [runPage]);

  useEffect(() => {
    // A plane's first request is issued here — when its tab becomes active — and
    // never on mount of the detail surface.
    if (!active) return undefined;
    interval.current = activeSignal;
    if (retention !== 'retain' || settledReader.current !== readPage) {
      startWalk(activeSignal, 'request');
    }
    return () => {
      interval.current = null;
      if (retention === 'retain' && settledReader.current === readPage) {
        if (pendingPosition.current !== null) requested.current.delete(pendingPosition.current);
        dispatch({ kind: 'walkAbandoned' });
      } else {
        requested.current = new Set();
        settledReader.current = null;
        dispatch({ kind: 'panelLeft' });
      }
      pendingPosition.current = null;
    };
  }, [active, activeSignal, readPage, retention, startWalk]);

  const loadMore = useCallback(() => {
    const pageSignal = interval.current;
    const next = state.continuation;
    if (!state.canLoadMore || state.pending || next === null || pageSignal === null) return;
    if (requested.current.has(next)) return;
    requested.current.add(next);
    nextToken.current += 1;
    void runPage(nextToken.current, next, pageSignal);
  }, [runPage, state.canLoadMore, state.continuation, state.pending]);

  const refresh = useCallback(() => {
    const pageSignal = interval.current;
    if (pageSignal === null || state.pending) return;
    startWalk(pageSignal, 'refresh');
  }, [startWalk, state.pending]);

  return useMemo(() => ({ state, loadMore, refresh }), [loadMore, refresh, state]);
}

type PagedResultShape<TRow> = Readonly<{
  rows: readonly TRow[];
  omittedRowCount: number;
  projectionTruncated: boolean;
  incomplete?: BitbucketDetailIncompleteReasonV1;
  continuation?: string;
}>;

function toPage<TRow>(result: PagedResultShape<TRow>): BitbucketPagedPageV1<TRow> {
  return {
    rows: result.rows,
    omittedRowCount: result.omittedRowCount,
    projectionTruncated: result.projectionTruncated,
    continuation: result.continuation ?? null,
    incomplete: result.incomplete ?? null,
  };
}

/* ------------------------------------------------------------------ activity */

export function useBitbucketActivity(
  input: TriageDetailSurfaceInputV1,
): BitbucketPagedControllerV1<BitbucketProjectedActivityRowV1> {
  const action = useMemo(
    () => ({
      pluginId: BITBUCKET_PLUGIN_ID,
      localId: BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listActivity,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const lastKnownLocator = useBitbucketLocator(input);

  const readPage: PageReader<BitbucketProjectedActivityRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      lastKnownLocator,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution, 'bitbucket-detail-read-failed'),
      };
    }
    const parsed = BitbucketActivityResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, lastKnownLocator, instance, localRef]);

  return useBitbucketPagedWalk(readPage);
}

/* -------------------------------------------------------------------- builds */

export type BitbucketBuildRollupViewV1 = Readonly<{
  failingCount?: number;
  runningCount?: number;
  passingCount?: number;
}>;

export type BitbucketBuildsControllerV1 =
  BitbucketPagedControllerV1<BitbucketProjectedStatusRowV1>
  & Readonly<{ rollup: BitbucketBuildRollupViewV1 }>;

/**
 * The build-status walk plus the rollup, which only exists when the first page
 * IS the whole collection.
 *
 * A later page appended by `Show more` never supplies one: by definition the
 * collection was already incomplete when that page was offered, so a rollup
 * arriving later would describe a set the reader has only part of.
 */
export function useBitbucketBuilds(
  input: TriageDetailSurfaceInputV1,
): BitbucketBuildsControllerV1 {
  const action = useMemo(
    () => ({
      pluginId: BITBUCKET_PLUGIN_ID,
      localId: BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const lastKnownLocator = useBitbucketLocator(input);
  const [rollup, setRollup] = useState<BitbucketBuildRollupViewV1>({});

  const readPage: PageReader<BitbucketProjectedStatusRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      lastKnownLocator,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution, 'bitbucket-detail-read-failed'),
      };
    }
    const parsed = BitbucketBuildsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    const page = parsed.data;
    if (continuation === null) {
      const { failingCount, runningCount, passingCount } = page;
      setRollup({
        ...(failingCount === undefined ? {} : { failingCount }),
        ...(runningCount === undefined ? {} : { runningCount }),
        ...(passingCount === undefined ? {} : { passingCount }),
      });
    }
    return { kind: 'page' as const, page: toPage(page) };
  }, [execute, lastKnownLocator, instance, localRef]);

  const controller = useBitbucketPagedWalk(readPage);
  return useMemo(() => ({ ...controller, rollup }), [controller, rollup]);
}

/* ------------------------------------------------------------------ comments */

export function useBitbucketComments(
  input: TriageDetailSurfaceInputV1,
): BitbucketPagedControllerV1<BitbucketProjectedCommentRowV1> {
  const action = useMemo(
    () => ({
      pluginId: BITBUCKET_PLUGIN_ID,
      localId: BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listComments,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const lastKnownLocator = useBitbucketLocator(input);

  const readPage: PageReader<BitbucketProjectedCommentRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      lastKnownLocator,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution, 'bitbucket-detail-read-failed'),
      };
    }
    const parsed = BitbucketCommentsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, lastKnownLocator, instance, localRef]);

  return useBitbucketPagedWalk(readPage);
}

/* ------------------------------------------------------------------ overview */

export type BitbucketOverviewControllerV1 = Readonly<{
  result: ReturnType<typeof BitbucketOverviewResultV1Schema.parse> | null;
  failure: TriageSourceFailureV1 | null;
  pending: boolean;
  refresh: () => void;
}>;

export function useBitbucketOverview(
  input: TriageDetailSurfaceInputV1,
): BitbucketOverviewControllerV1 {
  const action = useMemo(() => ({
    pluginId: BITBUCKET_PLUGIN_ID,
    localId: BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview,
  }), []);
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const lastKnownLocator = useBitbucketLocator(input);
  const { active, activeSignal } = useTabPanelActivity();
  const [result, setResult] = useState<ReturnType<typeof BitbucketOverviewResultV1Schema.parse> | null>(null);
  const [failure, setFailure] = useState<TriageSourceFailureV1 | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const request = useMemo(() => ({
    v: 1,
    instance,
    localRef,
    lastKnownLocator,
  }), [lastKnownLocator, instance, localRef]);
  const settledRequest = useRef<typeof request | null>(null);
  const lastRefresh = useRef(refreshKey);

  useEffect(() => {
    if (!active) return;
    const retained = settledRequest.current === request;
    if (retained && lastRefresh.current === refreshKey) return;
    if (!retained) setResult(null);
    lastRefresh.current = refreshKey;
    let current = true;
    setPending(true);
    setFailure(null);
    void execute(request, { signal: activeSignal }).then((execution: ExecuteResult) => {
      if (!current || activeSignal.aborted) return;
      const parsed = execution.status === 'success'
        ? BitbucketOverviewResultV1Schema.safeParse(execution.result)
        : null;
      if (parsed?.success === true && parsed.data.kind === 'overview') {
        settledRequest.current = request;
        setResult(parsed.data);
      } else {
        setFailure(parsed?.success === true && parsed.data.kind === 'unavailable'
          ? parsed.data.failure
          : dispatchFailure(execution, 'bitbucket-overview-read-failed'));
      }
      setPending(false);
    });
    return () => {
      current = false;
      setPending(false);
      setFailure(null);
    };
  }, [active, activeSignal, execute, request, refreshKey]);

  return useMemo(() => ({
    result,
    failure,
    pending,
    refresh: () => { if (active && !pending) setRefreshKey((value) => value + 1); },
  }), [active, failure, pending, result]);
}

/* ---------------------------------------------------------------------- diff */

export type BitbucketDiffControllerV1 = BitbucketPagedControllerV1<BitbucketProjectedDiffstatRowV1>
  & Readonly<{ raw: Extract<ReturnType<typeof BitbucketDiffResultV1Schema.parse>, { kind: 'diff' }>['raw'] | null }>;

export function useBitbucketDiff(
  input: TriageDetailSurfaceInputV1,
): BitbucketDiffControllerV1 {
  const action = useMemo(() => ({
    pluginId: BITBUCKET_PLUGIN_ID,
    localId: BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff,
  }), []);
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const lastKnownLocator = useBitbucketLocator(input);
  const [raw, setRaw] = useState<BitbucketDiffControllerV1['raw']>(null);
  const readPage: PageReader<BitbucketProjectedDiffstatRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      lastKnownLocator,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return { kind: 'failed' as const, failure: dispatchFailure(
        execution,
        'bitbucket-diff-read-failed',
      ) };
    }
    const parsed = BitbucketDiffResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    if (!signal.aborted && continuation === null) setRaw(parsed.data.raw ?? null);
    return { kind: 'page' as const, page: toPage({
      rows: parsed.data.files,
      omittedRowCount: parsed.data.omittedRowCount,
      projectionTruncated: parsed.data.projectionTruncated,
      ...(parsed.data.incomplete === undefined ? {} : { incomplete: parsed.data.incomplete }),
      ...(parsed.data.continuation === undefined ? {} : { continuation: parsed.data.continuation }),
    }) };
  }, [execute, lastKnownLocator, instance, localRef]);
  const controller = useBitbucketPagedWalk(
    readPage,
    BITBUCKET_DETAIL_TABS_V1.find((tab) => tab.id === 'diff')?.retention,
  );
  return useMemo(() => ({ ...controller, raw }), [controller, raw]);
}
