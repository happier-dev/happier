import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
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
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/source/detailActions.js';
import {
  BitbucketActivityResultV1Schema,
  BitbucketBuildsResultV1Schema,
  BitbucketCommentsResultV1Schema,
  BitbucketDiffResultV1Schema,
  BitbucketOverviewResultV1Schema,
} from '../../triage/source/detailContracts.js';

import {
  bitbucketPagedInitialState,
  bitbucketPagedReducer,
  type BitbucketPagedPageV1,
  type BitbucketPagedStateV1,
} from './panelState.js';

/**
 * The panel-owned readers behind the Bitbucket Cloud detail body.
 *
 * Each reader's lifetime is the lifetime of the panel that owns its data, and
 * that is a structural fact here rather than a convention: every read below is
 * scoped to its panel's active interval, so leaving aborts the request, rejects
 * a late result, and discards every row the panel held.
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

function dispatchFailure(status: string, code: string): TriageSourceFailureV1 {
  return Object.freeze({
    class: status === 'error' ? 'transient' : 'unknown',
    code: status === 'idle' || status === 'pending'
      ? 'bitbucket-detail-read-not-dispatched'
      : code,
  });
}

type ExecuteResult = Readonly<{ status: string; result?: unknown; code?: string }>;

/**
 * The entry the mounted surface is about, as the three fields every source Action addresses it by.
 *
 * Exported because the writes address the same entry the reads do. A second derivation beside this
 * one is how a mutation could end up addressing a different pull request than the panel showing it.
 */
export function useBitbucketEntryLocalRef(input: TriageDetailSurfaceInputV1) {
  const { entryRef } = input.observation;
  return useMemo(() => ({
    kindId: entryRef.kindId,
    collisionScope: entryRef.collisionScope,
    entryId: entryRef.entryId,
  }), [entryRef.collisionScope, entryRef.entryId, entryRef.kindId]);
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
): BitbucketPagedControllerV1<TRow> {
  const [state, dispatch] = useReducer(
    bitbucketPagedReducer<TRow>,
    undefined,
    bitbucketPagedInitialState<TRow>,
  );
  const { active, activeSignal } = useTabPanelActivity();
  const interval = useRef<AbortSignal | null>(null);
  const requested = useRef<Set<string>>(new Set());
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

  const startWalk = useCallback((pageSignal: AbortSignal): void => {
    requested.current = new Set();
    dispatch({ kind: 'panelLeft' });
    nextToken.current += 1;
    void runPage(nextToken.current, null, pageSignal);
  }, [runPage]);

  useEffect(() => {
    // A plane's first request is issued here — when its tab becomes active — and
    // never on mount of the detail surface.
    if (!active) return undefined;
    interval.current = activeSignal;
    startWalk(activeSignal);
    return () => {
      interval.current = null;
      requested.current = new Set();
      dispatch({ kind: 'panelLeft' });
    };
  }, [active, activeSignal, startWalk]);

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
    startWalk(pageSignal);
  }, [startWalk, state.pending]);

  return useMemo(() => ({ state, loadMore, refresh }), [loadMore, refresh, state]);
}

type PagedResultShape<TRow> = Readonly<{
  rows: readonly TRow[];
  omittedRowCount: number;
  projectionTruncated: boolean;
  continuation?: string;
}>;

function toPage<TRow>(result: PagedResultShape<TRow>): BitbucketPagedPageV1<TRow> {
  return {
    rows: result.rows,
    omittedRowCount: result.omittedRowCount,
    projectionTruncated: result.projectionTruncated,
    continuation: result.continuation ?? null,
    // Bitbucket reports completeness by the absence of `next`, and has no
    // short-walk reason of its own. Claiming one would be a truncation this
    // product invented.
    incomplete: null,
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
  const localRef = useBitbucketEntryLocalRef(input);
  const { instance } = input;
  const routingToken = input.observation.locator.routingToken;

  const readPage: PageReader<BitbucketProjectedActivityRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'bitbucket-detail-read-failed'),
      };
    }
    const parsed = BitbucketActivityResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, localRef, routingToken]);

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
  const localRef = useBitbucketEntryLocalRef(input);
  const { instance } = input;
  const routingToken = input.observation.locator.routingToken;
  const [rollup, setRollup] = useState<BitbucketBuildRollupViewV1>({});

  const readPage: PageReader<BitbucketProjectedStatusRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'bitbucket-detail-read-failed'),
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
  }, [execute, instance, localRef, routingToken]);

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
  const localRef = useBitbucketEntryLocalRef(input);
  const { instance } = input;
  const routingToken = input.observation.locator.routingToken;

  const readPage: PageReader<BitbucketProjectedCommentRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'bitbucket-detail-read-failed'),
      };
    }
    const parsed = BitbucketCommentsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, localRef, routingToken]);

  return useBitbucketPagedWalk(readPage);
}

/* ------------------------------------------------------------------ overview */

export type BitbucketOverviewControllerV1 = Readonly<{
  result: ReturnType<typeof BitbucketOverviewResultV1Schema.parse> | null;
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
  const localRef = useBitbucketEntryLocalRef(input);
  const { instance } = input;
  const routingToken = input.observation.locator.routingToken;
  const { active, activeSignal } = useTabPanelActivity();
  const [result, setResult] = useState<ReturnType<typeof BitbucketOverviewResultV1Schema.parse> | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setPending(true);
    void execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
    }, { signal: activeSignal }).then((execution: ExecuteResult) => {
      if (!current || activeSignal.aborted) return;
      const parsed = execution.status === 'success'
        ? BitbucketOverviewResultV1Schema.safeParse(execution.result)
        : null;
      setResult(parsed?.success === true ? parsed.data : {
        kind: 'unavailable',
        failure: dispatchFailure(execution.status, execution.code ?? 'bitbucket-overview-read-failed'),
      });
      setPending(false);
    });
    return () => { current = false; };
  }, [active, activeSignal, execute, instance, localRef, refreshKey, routingToken]);

  return useMemo(() => ({
    result,
    pending,
    refresh: () => { if (!pending) setRefreshKey((value) => value + 1); },
  }), [pending, result]);
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
  const localRef = useBitbucketEntryLocalRef(input);
  const { instance } = input;
  const routingToken = input.observation.locator.routingToken;
  const [raw, setRaw] = useState<BitbucketDiffControllerV1['raw']>(null);
  const readPage: PageReader<BitbucketProjectedDiffstatRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return { kind: 'failed' as const, failure: dispatchFailure(
        execution.status,
        execution.code ?? 'bitbucket-diff-read-failed',
      ) };
    }
    const parsed = BitbucketDiffResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    if (continuation === null) setRaw(parsed.data.raw ?? null);
    return { kind: 'page' as const, page: toPage({
      rows: parsed.data.files,
      omittedRowCount: parsed.data.omittedRowCount,
      projectionTruncated: parsed.data.projectionTruncated,
      ...(parsed.data.continuation === undefined ? {} : { continuation: parsed.data.continuation }),
    }) };
  }, [execute, instance, localRef, routingToken]);
  const controller = useBitbucketPagedWalk(readPage);
  return useMemo(() => ({ ...controller, raw }), [controller, raw]);
}
