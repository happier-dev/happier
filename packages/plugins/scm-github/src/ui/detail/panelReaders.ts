import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import {
  GithubChangedFilesResultV1Schema,
  GithubChecksResultV1Schema,
  GithubCommentsResultV1Schema,
  GithubTimelineResultV1Schema,
} from '../../triage/detail/contracts.js';
import type {
  GithubProjectedChangedFileRowV1,
  GithubProjectedCheckRowV1,
  GithubProjectedCommentRowV1,
  GithubProjectedTimelineRowV1,
} from '../../triage/detail/projection.js';
import {
  GITHUB_CHANGED_FILES_PAGE_SIZE_V1,
  GITHUB_COMMENTS_PAGE_SIZE_V1,
  GITHUB_TIMELINE_PAGE_SIZE_V1,
} from '../../triage/detail/routes.js';

import {
  githubPagedInitialState,
  githubPagedReducer,
  type GithubPagedPageV1,
  type GithubPagedStateV1,
  type GithubReadStateV1,
} from './panelState.js';

/**
 * The panel-owned readers behind the GitHub detail body.
 *
 * Each reader's lifetime is the lifetime of the panel that owns its data, and
 * that is a structural fact here rather than a convention: every read below is
 * scoped to its panel's active interval, so leaving aborts the request, rejects
 * a late result, and discards every row the panel held. A tab that declares
 * `retain` keeps its list geometry and nothing else — the reducer is reset the
 * moment the panel becomes inactive.
 *
 * That lifetime is also the rate budget. GitHub involvement scanning already
 * issues real provider work, and four planes each with paging could multiply it
 * several times over on every detail open. Nothing here fetches on mount of the
 * detail surface: a plane's first request is issued when its tab becomes active
 * and never before.
 *
 * No reader holds a credential, builds a URL, or sees a raw provider body. Each
 * names its exact configured instance, entry and observed route and invokes one
 * source-owned Action; what comes back has already passed the boundary
 * projector.
 */

/** A result the surface could not read is a contract break, not an empty read. */
const UNREADABLE_RESULT: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github-detail-result-unreadable',
});

/**
 * The observation carried no route for this entry, so no plane can be read.
 *
 * It is a stated failure rather than an empty panel: a path is never guessed
 * from identity, display text or a git remote.
 */
const ROUTE_UNAVAILABLE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_locator_unusable',
});

function dispatchFailure(status: string, code: string): TriageSourceFailureV1 {
  return Object.freeze({
    class: status === 'error' ? 'transient' : 'unknown',
    code: status === 'idle' || status === 'pending' ? 'github-detail-read-not-dispatched' : code,
  });
}

type ExecuteResult = Readonly<{ status: string; result?: unknown; code?: string }>;

function useLocalRef(input: TriageDetailSurfaceInputV1) {
  const { entryRef } = input.observation;
  return useMemo(() => ({
    kindId: entryRef.kindId,
    collisionScope: entryRef.collisionScope,
    entryId: entryRef.entryId,
  }), [entryRef.collisionScope, entryRef.entryId, entryRef.kindId]);
}

/** The source-private route the target observed for this entry, if it has one. */
export function useGithubRoutingToken(input: TriageDetailSurfaceInputV1): string | null {
  return input.observation.locator.routingToken ?? null;
}

/* ------------------------------------------------------------- paged planes */

export type GithubPagedControllerV1<TRow> = Readonly<{
  state: GithubPagedStateV1<TRow>;
  loadMore: () => void;
  /**
   * Restarts the walk at the first page.
   *
   * Refresh in a detail panel is explicit and reader-initiated; there is no
   * automatic poll inside a tab, because a tab that re-reads on its own spends
   * GitHub's rate budget for a reader who is not looking.
   */
  refresh: () => void;
}>;

type PageReader<TRow> = (
  continuation: string | null,
  signal: AbortSignal,
) => Promise<Readonly<{ kind: 'page'; page: GithubPagedPageV1<TRow> }>
| Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>>;

/**
 * Drives one paged walk for one mounted panel.
 *
 * The walk refuses to request a position it has already requested in this
 * interval. A provider that kept advertising the same page would otherwise make
 * the panel read it forever, and the read module's own non-advancing guard only
 * sees one response at a time.
 */
function useGithubPagedWalk<TRow>(
  readPage: PageReader<TRow>,
  enabled: boolean,
  disabledFailure: TriageSourceFailureV1,
): GithubPagedControllerV1<TRow> {
  const [state, dispatch] = useReducer(
    githubPagedReducer<TRow>,
    undefined,
    githubPagedInitialState<TRow>,
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
    if (enabled) {
      void runPage(nextToken.current, null, pageSignal);
      return;
    }
    // A plane with nothing to address settles as unavailable NAMING itself,
    // never as an idle or empty panel: the reader is owed the difference
    // between "no rows" and "we had no route to ask".
    const token = nextToken.current;
    dispatch({ kind: 'requestStarted', token });
    dispatch({ kind: 'pageFailed', token, failure: disabledFailure });
  }, [disabledFailure, enabled, runPage]);

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
  incomplete?: 'ceiling' | 'pagination';
  continuation?: string;
}>;

function toPage<TRow>(result: PagedResultShape<TRow>): GithubPagedPageV1<TRow> {
  return {
    rows: result.rows,
    omittedRowCount: result.omittedRowCount,
    projectionTruncated: result.projectionTruncated,
    continuation: result.continuation ?? null,
    incomplete: result.incomplete ?? null,
  };
}

/* ------------------------------------------------------------------ timeline */

export function useGithubTimeline(
  input: TriageDetailSurfaceInputV1,
): GithubPagedControllerV1<GithubProjectedTimelineRowV1> {
  const action = useMemo(
    () => ({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGithubRoutingToken(input);
  const { instance } = input;

  const readPage: PageReader<GithubProjectedTimelineRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      limit: GITHUB_TIMELINE_PAGE_SIZE_V1,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'github-detail-read-failed'),
      };
    }
    const parsed = GithubTimelineResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, localRef, routingToken]);

  return useGithubPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
}

/* ------------------------------------------------------------ changed files */

export function useGithubChangedFiles(
  input: TriageDetailSurfaceInputV1,
): GithubPagedControllerV1<GithubProjectedChangedFileRowV1> {
  const action = useMemo(
    () => ({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGithubRoutingToken(input);
  const { instance } = input;

  const readPage: PageReader<GithubProjectedChangedFileRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      limit: GITHUB_CHANGED_FILES_PAGE_SIZE_V1,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'github-detail-read-failed'),
      };
    }
    const parsed = GithubChangedFilesResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, localRef, routingToken]);

  return useGithubPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
}

/* ------------------------------------------------------------------ comments */

export function useGithubComments(
  input: TriageDetailSurfaceInputV1,
): GithubPagedControllerV1<GithubProjectedCommentRowV1> {
  const action = useMemo(
    () => ({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listComments,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGithubRoutingToken(input);
  const { instance } = input;

  const readPage: PageReader<GithubProjectedCommentRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      limit: GITHUB_COMMENTS_PAGE_SIZE_V1,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'github-detail-read-failed'),
      };
    }
    const parsed = GithubCommentsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, localRef, routingToken]);

  return useGithubPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
}

/* -------------------------------------------------------------------- checks */

export type GithubChecksViewV1 = Readonly<{
  headRevision: string;
  state: 'none' | 'unknown' | 'knownIncomplete' | 'resolved';
  rows: readonly GithubProjectedCheckRowV1[];
  failingCount?: number;
  runningCount?: number;
  passingCount?: number;
  checkRunsFailure?: TriageSourceFailureV1;
  commitStatusFailure?: TriageSourceFailureV1;
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

/**
 * Reads the whole check surface for exactly as long as its panel is active.
 *
 * The two provider collections settle together because their rollup is one
 * answer, so this plane is a single read rather than a walk. Leaving aborts it
 * and returns the panel to `loading`; a late result cannot publish into a panel
 * nobody is looking at.
 */
export type GithubChecksControllerV1 = Readonly<{
  state: GithubReadStateV1<GithubChecksViewV1>;
  refresh: () => void;
}>;

export function useGithubChecks(
  input: TriageDetailSurfaceInputV1,
): GithubChecksControllerV1 {
  const action = useMemo(
    () => ({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { active, activeSignal } = useTabPanelActivity();
  const localRef = useLocalRef(input);
  const routingToken = useGithubRoutingToken(input);
  const { instance } = input;
  const [state, setState] = useState<GithubReadStateV1<GithubChecksViewV1>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    // `attempt` is the reader's explicit refresh. It re-enters this effect, which
    // is the same code path the first read takes — there is no second read owner
    // and no automatic poll.
    void attempt;
    setState({ kind: 'loading' });
    if (routingToken === null) {
      setState({ kind: 'unavailable', failure: ROUTE_UNAVAILABLE });
      return undefined;
    }
    let left = false;
    void (async () => {
      const execution = await execute({
        v: 1,
        instance,
        localRef,
        routingToken,
      }, { signal: activeSignal }) as ExecuteResult;
      if (left || activeSignal.aborted) return;
      if (execution.status !== 'success') {
        setState({
          kind: 'unavailable',
          failure: dispatchFailure(execution.status, execution.code ?? 'github-detail-read-failed'),
        });
        return;
      }
      const parsed = GithubChecksResultV1Schema.safeParse(execution.result);
      if (!parsed.success) {
        setState({ kind: 'unavailable', failure: UNREADABLE_RESULT });
        return;
      }
      if (parsed.data.kind === 'unavailable') {
        setState({ kind: 'unavailable', failure: parsed.data.failure });
        return;
      }
      const { kind: _kind, ...view } = parsed.data;
      setState({ kind: 'ready', value: view as GithubChecksViewV1 });
    })();
    return () => {
      left = true;
      setState({ kind: 'loading' });
    };
  }, [active, activeSignal, attempt, execute, instance, localRef, routingToken]);

  const refresh = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return useMemo(() => ({ state, refresh }), [refresh, state]);
}
