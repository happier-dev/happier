import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import {
  GithubCapabilitiesResultV1Schema,
  type GithubCapabilitiesResultV1,
  GithubChangedFilesResultV1Schema,
  GithubFeedbackResultV1Schema,
  type GithubFeedbackInputV1,
  GithubTimelineResultV1Schema,
  type GithubPatchEvidenceV1,
} from '../../triage/detail/contracts.js';
import type { GithubRepositoryCapabilitiesV1 } from '../../triage/capabilities.js';
import type {
  GithubFeedbackCommentV1,
  GithubFeedbackRequestV1,
  GithubFeedbackReviewV1,
  GithubFeedbackThreadV1,
} from '../../triage/feedback.js';
import type {
  GithubProjectedChangedFileRowV1,
  GithubProjectedCheckRowV1,
  GithubProjectedTimelineRowV1,
} from '../../triage/detail/projection.js';
import type { GithubChecksRowStateV1 } from '../../triage/mapping/facts.js';
import {
  GITHUB_CHANGED_FILES_PAGE_SIZE_V1,
  GITHUB_TIMELINE_PAGE_SIZE_V1,
} from '../../triage/detail/routes.js';

import {
  githubPagedInitialState,
  githubPagedReducer,
  type GithubPagedPageV1,
  type GithubPagedStateV1,
  type GithubReadStateV1,
} from './panelState.js';
import { dispatchFailure, ROUTE_UNAVAILABLE, UNREADABLE_RESULT, useGithubRoutingToken, type ExecuteResult } from './readBoundary.js';
import type { GithubOverviewControllerV1 } from './overviewReader.js';

export { useGithubRoutingToken } from './readBoundary.js';
export { useGithubOverview, type GithubOverviewControllerV1, type GithubOverviewValueV1 } from './overviewReader.js';

/**
 * The panel-owned readers behind the GitHub detail body.
 *
 * The checks, changed-files, timeline and feedback readers live for the open
 * detail, not for a tab: `resourceOwners.tsx` mounts each once and every panel
 * renders from it, so a tab's `discard`/`retain` declaration decides only whether
 * its subtree stays mounted, never whether GitHub is asked again. A reader that
 * walked nine changed-file pages keeps them and its place among them across any
 * number of tab switches.
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

/** Share Overview's complete repository facts; read only the remainder once per mount. */
export function useGithubCapabilities(
  input: TriageDetailSurfaceInputV1,
  activity?: ReturnType<typeof useTabPanelActivity>,
  overview?: GithubOverviewControllerV1,
  initialCapabilities?: GithubCapabilitiesResultV1,
): GithubReadStateV1<GithubRepositoryCapabilitiesV1> {
  const action = useMemo(() => ({
    pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities,
  }), []);
  const { execute } = useExecutePluginAction(action);
  const request = useTriageDetailRequest(input);
  const { instance, localRef } = request;
  const routingToken = useGithubRoutingToken(input);
  const tabActivity = useTabPanelActivity();
  const { active, activeSignal } = activity ?? tabActivity;
  const [state, setState] = useState<GithubReadStateV1<GithubRepositoryCapabilitiesV1>>(
    { kind: 'loading' },
  );
  const shared = overview?.value?.kindId === 'pull-request' ? overview.value.capabilities : undefined;
  const summaryPending = overview !== undefined && overview.value === null && overview.failure === null;
  const authority = useMemo(() => ({ request, routingToken }), [request, routingToken]);
  const previousAuthority = useRef(authority);
  const settledAuthority = useRef<typeof authority | null>(null);
  if (previousAuthority.current !== authority) {
    previousAuthority.current = authority;
    setState({ kind: 'loading' });
  }
  useEffect(() => {
    if (!active || activeSignal.aborted || shared !== undefined || initialCapabilities !== undefined || summaryPending
      || settledAuthority.current === authority) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    activeSignal.addEventListener('abort', abort);
    if (routingToken === null) {
      setState({ kind: 'unavailable', failure: ROUTE_UNAVAILABLE });
      settledAuthority.current = authority;
      return () => { activeSignal.removeEventListener('abort', abort); controller.abort(); };
    }
    void execute({ v: 1, instance, localRef, routingToken }, { signal: controller.signal })
      .then((execution: ExecuteResult) => {
        if (controller.signal.aborted) return;
        settledAuthority.current = authority;
        if (execution.status !== 'success') {
          setState({ kind: 'unavailable', failure: dispatchFailure(
            execution,
            'github-capabilities-read-failed',
          ) });
          return;
        }
        const parsed = GithubCapabilitiesResultV1Schema.safeParse(execution.result);
        if (!parsed.success) {
          setState({ kind: 'unavailable', failure: UNREADABLE_RESULT });
        } else if (parsed.data.kind === 'unavailable') {
          setState({ kind: 'unavailable', failure: parsed.data.failure });
        } else {
          setState({ kind: 'ready', value: parsed.data });
        }
      });
    return () => { activeSignal.removeEventListener('abort', abort); controller.abort(); };
  }, [active, activeSignal, authority, execute, initialCapabilities, instance, localRef, routingToken, shared, summaryPending]);
  return useMemo(() => {
    if (shared !== undefined) return { kind: 'ready' as const, value: shared };
    if (initialCapabilities?.kind === 'capabilities') return { kind: 'ready' as const, value: initialCapabilities };
    if (initialCapabilities?.kind === 'unavailable') return { kind: 'unavailable' as const, failure: initialCapabilities.failure };
    return state;
  }, [initialCapabilities, shared, state]);
}

/* -------------------------------------------------------------------- overview */

/* ------------------------------------------------------------- paged planes */

/** The interval a detail-lifetime reader may read in: the detail's, while a consumer demands it. */
export type GithubReaderActivityV1 = ReturnType<typeof useTabPanelActivity>;

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

export type GithubPageReaderV1<TRow> = (
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
export function useGithubPagedWalk<TRow>(
  readPage: GithubPageReaderV1<TRow>,
  enabled: boolean,
  disabledFailure: TriageSourceFailureV1,
  firstContinuation: string | null = null,
  options: Readonly<{ activity?: ReturnType<typeof useTabPanelActivity>; authority?: unknown }> = {},
): GithubPagedControllerV1<TRow> {
  const [state, dispatch] = useReducer(
    githubPagedReducer<TRow>,
    undefined,
    githubPagedInitialState<TRow>,
  );
  const tabActivity = useTabPanelActivity();
  const { active, activeSignal } = options.activity ?? tabActivity;
  const previousAuthority = useRef(options.authority);
  if (previousAuthority.current !== options.authority) {
    previousAuthority.current = options.authority;
    dispatch({ kind: 'panelLeft' });
  }
  const interval = useRef<AbortSignal | null>(null);
  const requested = useRef<Set<string>>(new Set());
  /**
   * The walk as it stands right now, for the two places that must read it
   * WITHOUT depending on it: the activity effect and its cleanup.
   *
   * Depending on the state there would re-enter the effect on every settled
   * page, which is a fresh interval — and a fresh interval restarts the walk it
   * was meant to continue.
   */
  const current = useRef(state);
  current.current = state;
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
    mode: 'append' | 'refresh' = 'append',
  ): Promise<void> => {
    dispatch({ kind: mode === 'refresh' ? 'refreshStarted' : 'requestStarted', token });
    const outcome = await readPage(continuation, pageSignal);
    if (pageSignal.aborted) return;
    if (outcome.kind === 'failed') {
      // Only a position this walk actually consumed may be refused a second
      // time. A page that failed was never read, and the reader is looking at
      // an enabled Load more for it — so the guard must let that press through.
      if (continuation !== null) requested.current.delete(continuation);
      dispatch({ kind: 'pageFailed', token, failure: outcome.failure });
      return;
    }
    dispatch({ kind: 'pageSettled', token, page: outcome.page });
  }, [readPage]);

  const startWalk = useCallback((
    pageSignal: AbortSignal,
    mode: 'cold' | 'refresh' = 'cold',
  ): void => {
    requested.current = new Set();
    if (mode === 'cold') dispatch({ kind: 'panelLeft' });
    nextToken.current += 1;
    if (enabled) {
      void runPage(
        nextToken.current,
        firstContinuation,
        pageSignal,
        mode === 'refresh' ? 'refresh' : 'append',
      );
      return;
    }
    // A plane with nothing to address settles as unavailable NAMING itself,
    // never as an idle or empty panel: the reader is owed the difference
    // between "no rows" and "we had no route to ask".
    const token = nextToken.current;
    dispatch({ kind: mode === 'refresh' ? 'refreshStarted' : 'requestStarted', token });
    dispatch({ kind: 'pageFailed', token, failure: disabledFailure });
  }, [disabledFailure, enabled, firstContinuation, runPage]);

  useEffect(() => {
    // A plane's first request is issued here — when its tab becomes active — and
    // never on mount of the detail surface.
    if (!active || activeSignal.aborted) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    activeSignal.addEventListener('abort', abort, { once: true });
    interval.current = controller.signal;
    // The non-advancing guard is scoped to ONE interval: a retained walk that
    // resumes may legitimately re-ask for the position its previous interval was
    // cut off at, and only a provider that kept advertising the same page inside
    // a single interval is looping.
    requested.current = new Set();
    // Retention is decided ONCE, by the tab declaration the shared `Tabs`
    // primitive already reads: a `discard` panel is unmounted while it is not
    // selected, so this reducer dies with it and the next visit starts cold. A
    // `retain` panel stays mounted, and this reader's job is simply not to throw
    // away what that panel is being kept for. Re-deciding retention here would
    // be a second owner of one declaration.
    // A provider-stated empty walk is an answer like any other: it is kept, not
    // re-asked. Only a walk with no answer yet (or a failed first page) starts.
    const answeredEmpty = current.current.kind === 'ready' && !current.current.pending;
    if (current.current.rows.length === 0 && !answeredEmpty) {
      startWalk(controller.signal);
    } else if (current.current.pending) {
      nextToken.current += 1;
      void runPage(
        nextToken.current,
        // A cancelled warm replacement has not accepted a new first page. Its
        // retained continuation belongs to the last-known-good walk, so
        // resuming that continuation would silently turn Refresh into append.
        current.current.refreshing ? firstContinuation : current.current.continuation,
        controller.signal,
        current.current.refreshing ? 'refresh' : 'append',
      );
    }
    return () => {
      // The interval's requests are aborted with its signal; nothing is thrown
      // away here. A walk whose panel is unmounted is collected with the panel,
      // and a walk whose panel is kept is exactly what the reader is returning
      // to.
      interval.current = null;
      requested.current = new Set();
      activeSignal.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [active, activeSignal, options.authority, runPage, startWalk]);

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

/** The detail-lifetime timeline walk; consumers read it through `resourceOwners.tsx`. */
export function useGithubTimelineReader(
  input: TriageDetailSurfaceInputV1,
  activity: GithubReaderActivityV1,
): GithubPagedControllerV1<GithubProjectedTimelineRowV1> {
  const action = useMemo(
    () => ({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const routingToken = useGithubRoutingToken(input);
  // A walk answers for one exact entry and route: another one clears its rows in the reader itself.
  const authority = useMemo(() => ({ instance, localRef, routingToken }), [instance, localRef, routingToken]);

  const readPage: GithubPageReaderV1<GithubProjectedTimelineRowV1> = useCallback(async (
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
        failure: dispatchFailure(execution, 'github-detail-read-failed'),
      };
    }
    const parsed = GithubTimelineResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, localRef, routingToken]);

  return useGithubPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE, null, { activity, authority });
}

/* ------------------------------------------------------------ changed files */

/** The source-minted page remains opaque; only its originating row carries it. */
export type GithubChangedFileViewV1 = GithubProjectedChangedFileRowV1 & Readonly<{
  diffContinuation: string | null;
}>;

/** The detail-lifetime changed-files walk; consumers read it through `resourceOwners.tsx`. */
export function useGithubChangedFilesReader(
  input: TriageDetailSurfaceInputV1,
  activity: GithubReaderActivityV1,
): GithubPagedControllerV1<GithubChangedFileViewV1> {
  const action = useMemo(
    () => ({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const routingToken = useGithubRoutingToken(input);
  // A walk answers for one exact entry and route: another one clears its rows in the reader itself.
  const authority = useMemo(() => ({ instance, localRef, routingToken }), [instance, localRef, routingToken]);

  const readPage: GithubPageReaderV1<GithubChangedFileViewV1> = useCallback(async (
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
        failure: dispatchFailure(execution, 'github-detail-read-failed'),
      };
    }
    const parsed = GithubChangedFilesResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage({ ...parsed.data,
      rows: parsed.data.rows.map(row => Object.freeze({ ...row, diffContinuation: continuation })),
    }) };
  }, [execute, instance, localRef, routingToken]);

  return useGithubPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE, null, { activity, authority });
}

export type GithubChangedFileDiffV1 = Readonly<{
  evidence: GithubPatchEvidenceV1;
  /** Standard unified headers plus exact provider hunks; null means no patch. */
  unifiedDiff: string | null;
}>;

/**
 * One changed file's diff through the same changed-files Action, read when the shared review asks for
 * it (`ChangedFilesReview`'s prefetch window) and cancelled through its signal.
 */
export type GithubChangedFileDiffLoaderV1 = (
  row: GithubChangedFileViewV1,
  signal: AbortSignal,
) => ReturnType<GithubSettledReader<GithubChangedFileDiffV1>>;

export function useGithubChangedFileDiffLoader(
  input: TriageDetailSurfaceInputV1,
): GithubChangedFileDiffLoaderV1 {
  const action = useMemo(() => ({
    pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles,
  }), []);
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const routingToken = useGithubRoutingToken(input);
  // The Action controller runs one read at a time: each file's read waits for the one before it to
  // settle, and a read the review cancelled while it waited is never dispatched.
  const previousRead = useRef<Promise<unknown>>(Promise.resolve());
  return useCallback(async (row, signal) => {
    const { path, diffContinuation } = row;
    if (routingToken === null) return { kind: 'failed', failure: ROUTE_UNAVAILABLE };
    const prior = previousRead.current;
    let settle!: () => void;
    previousRead.current = new Promise<void>((resolve) => { settle = resolve; });
    try {
      await prior;
      if (signal.aborted) return { kind: 'failed', failure: dispatchFailure({ status: 'idle' }, 'github-file-diff-read-failed') };
      return await readOne(path, diffContinuation, signal);
    } finally {
      settle();
    }
  }, [execute, instance, localRef, routingToken]);

  async function readOne(path: string, diffContinuation: string | null, signal: AbortSignal): ReturnType<GithubChangedFileDiffLoaderV1> {
    if (routingToken === null) return { kind: 'failed', failure: ROUTE_UNAVAILABLE };
    const execution = await execute({
      v: 1, instance, localRef, routingToken, limit: GITHUB_CHANGED_FILES_PAGE_SIZE_V1,
      filePath: path, ...(diffContinuation === null ? {} : { continuation: diffContinuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') return { kind: 'failed', failure: dispatchFailure(
      execution, 'github-file-diff-read-failed',
    ) };
    const parsed = GithubChangedFilesResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed', failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') return { kind: 'failed', failure: parsed.data.failure };
    const selected = parsed.data.rows.length === 1 ? parsed.data.rows[0] : undefined;
    if (selected?.path !== path || selected.evidence === undefined) return { kind: 'failed', failure: UNREADABLE_RESULT };
    const evidence = selected.evidence;
    const before = selected.status === 'added' ? '/dev/null' : JSON.stringify(`a/${selected.previousPath ?? path}`);
    const after = selected.status === 'removed' ? '/dev/null' : JSON.stringify(`b/${path}`);
    return { kind: 'ready', value: Object.freeze({ evidence,
      unifiedDiff: evidence.state === 'unavailable' ? null : `--- ${before}\n+++ ${after}\n${evidence.patch}`,
    }) };
  }
}

/* ------------------------------------------------------------------ feedback */


function normalizeFeedbackComment(
  row: Readonly<{
    id: string; body: string; author?: string; createdAtMs?: number; url?: string; truncated?: true;
    editable?: true;
    suggestions?: GithubFeedbackCommentV1['suggestions'];
  }>,
): GithubFeedbackCommentV1 {
  return Object.freeze({
    id: row.id,
    body: row.body,
    author: row.author ?? null,
    createdAtMs: row.createdAtMs ?? null,
    url: row.url ?? null,
    ...(row.truncated === true ? { truncated: true as const } : {}),
    ...(row.editable === true ? { editable: true as const } : {}),
    ...(row.suggestions ? { suggestions: row.suggestions } : {}),
  });
}

export type GithubFeedbackRootConnectionV1 = Exclude<GithubFeedbackInputV1['connection'], 'threadReplies'>;

/** One detail-lifetime feedback connection walk; consumers read it through `resourceOwners.tsx`. */
export function useGithubFeedbackConnectionReader<TRow>(
  input: TriageDetailSurfaceInputV1,
  connection: GithubFeedbackRootConnectionV1,
  activity: GithubReaderActivityV1,
): GithubPagedControllerV1<TRow> & Readonly<{
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null;
}> {
  const action = useMemo(
    () => ({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const [reviewDecision, setReviewDecision] = useState<
    'approved' | 'changes-requested' | 'review-required' | null
  >(null);
  const { instance, localRef } = useTriageDetailRequest(input);
  const routingToken = useGithubRoutingToken(input);
  // A walk answers for one exact entry and route: another one clears its rows in the reader itself.
  const authority = useMemo(() => ({ instance, localRef, routingToken }), [instance, localRef, routingToken]);

  const readPage: GithubPageReaderV1<TRow> = useCallback(async (continuation, signal) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      connection,
      ...(continuation === null ? {} : { cursor: continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution, 'github-feedback-read-failed'),
      };
    }
    const parsed = GithubFeedbackResultV1Schema.safeParse(execution.result);
    if (!parsed.success) {
      return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    }
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    if (parsed.data.kind !== connection) {
      return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    }
    if (parsed.data.kind === 'reviews') {
      setReviewDecision(parsed.data.reviewDecision ?? null);
    }
    const cursor = parsed.data.kind === 'requests'
      ? parsed.data.nextCursor
      : parsed.data.previousCursor;
    const rows = parsed.data.kind === 'comments'
      ? parsed.data.rows.map(normalizeFeedbackComment)
      : parsed.data.kind === 'threads'
        ? parsed.data.rows.map((row) => Object.freeze({
          id: row.id,
          isResolved: row.isResolved,
          path: row.path ?? null,
          line: row.line ?? null,
          firstReply: row.firstReply === undefined ? null : normalizeFeedbackComment(row.firstReply),
          replyCount: row.replyCount,
          replies: row.replies.map(normalizeFeedbackComment),
          previousRepliesCursor: row.previousRepliesCursor ?? null,
          ...(row.truncated === true ? { truncated: true as const } : {}),
        }))
        : parsed.data.kind === 'reviews'
          ? parsed.data.rows.map((row) => Object.freeze({
            id: row.id,
            body: row.body,
            state: row.state,
            author: row.author ?? null,
            submittedAtMs: row.submittedAtMs ?? null,
            url: row.url ?? null,
            ...(row.truncated === true ? { truncated: true as const } : {}),
            ...(row.editable === true ? { editable: true as const } : {}),
          }))
          : parsed.data.rows;
    return {
      kind: 'page' as const,
      page: {
        rows: rows as readonly TRow[],
        omittedRowCount: parsed.data.omittedRowCount,
        projectionTruncated: parsed.data.projectionTruncated,
        continuation: cursor ?? null,
        incomplete: parsed.data.incomplete === 'continuationUnavailable'
          ? 'pagination' as const
          : null,
      },
    };
  }, [connection, execute, instance, localRef, routingToken]);

  const controller = useGithubPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE, null, { activity, authority });
  return useMemo(
    () => ({ ...controller, reviewDecision }),
    [controller, reviewDecision],
  );
}

export function useGithubFeedbackThreadReplies(
  input: TriageDetailSurfaceInputV1,
  threadId: string,
  firstCursor: string,
): GithubPagedControllerV1<GithubFeedbackCommentV1> {
  const action = useMemo(() => ({
    pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback,
  }), []);
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const routingToken = useGithubRoutingToken(input);
  // A walk answers for one exact entry and route: another one clears its rows in the reader itself.
  const authority = useMemo(() => ({ instance, localRef, routingToken }), [instance, localRef, routingToken]);
  const readPage: GithubPageReaderV1<GithubFeedbackCommentV1> = useCallback(async (continuation, signal) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      connection: 'threadReplies',
      threadId,
      ...(continuation === null ? {} : { cursor: continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution, 'github-feedback-read-failed'),
      };
    }
    const parsed = GithubFeedbackResultV1Schema.safeParse(execution.result);
    if (!parsed.success || parsed.data.kind !== 'threadReplies' || parsed.data.threadId !== threadId) {
      return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    }
    return {
      kind: 'page' as const,
      page: {
        rows: parsed.data.rows.map(normalizeFeedbackComment),
        omittedRowCount: parsed.data.omittedRowCount,
        projectionTruncated: parsed.data.projectionTruncated,
        continuation: parsed.data.previousCursor ?? null,
        incomplete: parsed.data.incomplete === 'continuationUnavailable'
          ? 'pagination' as const
          : null,
      },
    };
  }, [execute, instance, localRef, routingToken, threadId]);
  return useGithubPagedWalk(
    readPage,
    routingToken !== null,
    ROUTE_UNAVAILABLE,
    firstCursor,
    { authority },
  );
}

/* -------------------------------------------------------------------- checks */

export type GithubChecksViewV1 = Readonly<{
  headRevision: string;
  state: 'none' | 'unknown' | 'knownIncomplete' | 'resolved';
  rowState?: GithubChecksRowStateV1;
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
  /** A warm failure sits beside the retained last-known-good checks. */
  failure: TriageSourceFailureV1 | null;
  /** The one whole-surface checks read is still in flight. */
  pending: boolean;
  /** The unavailable checks are the Overview read's own failure, already disclosed beside it. */
  overviewFailure?: boolean;
  refresh: () => void;
}>;

export type GithubSettledReader<T> = (
  signal: AbortSignal,
) => Promise<Readonly<{ kind: 'ready'; value: T }>
| Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>>;

/**
 * Drives one whole-surface read for a tab's active interval.
 *
 * Checks are one all-or-nothing answer inside the source reader, not a paged UI
 * walk. This lifecycle keeps explicit refresh, cancellation and late-result
 * rejection together without giving the panel another source of truth.
 */
export function useGithubSettledRead<T>(
  read: GithubSettledReader<T>,
  active: boolean,
  activeSignal: AbortSignal,
  options: Readonly<{ retain?: boolean }> = {},
): Readonly<{
  state: GithubReadStateV1<T>;
  failure: TriageSourceFailureV1 | null;
  pending: boolean;
  refresh: () => void;
}> {
  const [state, setState] = useState<GithubReadStateV1<T>>({ kind: 'loading' });
  const [failure, setFailure] = useState<TriageSourceFailureV1 | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const lastKnownGood = useRef<T | null>(null);
  const previousReader = useRef(read);
  const previousRead = useRef<Promise<void> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const settled = useRef<Readonly<{ read: GithubSettledReader<T>; attempt: number }> | null>(null);

  if (previousReader.current !== read) {
    previousReader.current = read;
    lastKnownGood.current = null;
    inFlight.current = false;
    setState({ kind: 'loading' });
    setFailure(null);
    setPending(false);
  }

  useEffect(() => {
    if (active || options.retain) return;
    inFlight.current = false;
    lastKnownGood.current = null;
    setState({ kind: 'loading' });
    setFailure(null);
    setPending(false);
  }, [active, options.retain]);

  useEffect(() => {
    if (!active || activeSignal.aborted) return undefined;
    if (options.retain && settled.current?.read === read && settled.current.attempt === attempt) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    activeSignal.addEventListener('abort', abort, { once: true });
    // `attempt` is an explicit re-read through the same owner as the first
    // read. There is no timer and no second reader behind refresh.
    void attempt;
    inFlight.current = true;
    setPending(true);
    if (lastKnownGood.current === null) setState({ kind: 'loading' });
    setFailure(null);
    const prior = previousRead.current;
    previousRead.current = (async () => {
      // A changed file cancels the prior read. Let that same Action controller
      // settle cancellation before reusing its single-in-flight guard.
      await prior;
      if (controller.signal.aborted) return;
      const outcome = await read(controller.signal);
      if (controller.signal.aborted) return;
      settled.current = { read, attempt };
      if (outcome.kind === 'ready') {
        lastKnownGood.current = outcome.value;
        setState({ kind: 'ready', value: outcome.value });
        setFailure(null);
      } else if (lastKnownGood.current === null) {
        setState({ kind: 'unavailable', failure: outcome.failure });
      } else {
        setFailure(outcome.failure);
      }
      inFlight.current = false;
      setPending(false);
    })();
    return () => {
      activeSignal.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [active, activeSignal, attempt, options.retain, read]);

  const refresh = useCallback(() => {
    if (!active || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setAttempt((current) => current + 1);
  }, [active]);

  return useMemo(
    () => ({ state, failure, pending, refresh }),
    [failure, pending, refresh, state],
  );
}

