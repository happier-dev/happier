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
  GithubChangedFilesResultV1Schema,
  GithubChecksResultV1Schema,
  GithubFeedbackResultV1Schema,
  GithubOverviewResultV1Schema,
  GithubTimelineResultV1Schema,
  type GithubOverviewResultV1,
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

/**
 * The panel-owned readers behind the GitHub detail body.
 *
 * Each reader's lifetime is the lifetime declared by the TAB that owns its
 * data, and `tabDeclarations.ts` is the only place that decides which. A tab
 * that declares `discard` behaves exactly as before: leaving aborts the request,
 * rejects a late result, and resets the reducer, so returning re-reads from the
 * first page. A tab that declares `retain` keeps the pages the reader already
 * walked and their place among them, and asks GitHub for none of them again.
 *
 * That difference is not a nicety on the one panel that declares it. A pull
 * request may change up to three thousand files, so a reader who walked nine
 * pages and glanced at Checks has spent nine pages of GitHub's rate budget;
 * restarting them at page one charges the whole walk twice for one glance away
 * and loses their position in it.
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

/** One mount-owned repository capability read shared by every write control. */
export function useGithubCapabilities(
  input: TriageDetailSurfaceInputV1,
): GithubReadStateV1<GithubRepositoryCapabilitiesV1> {
  const action = useMemo(() => ({
    pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities,
  }), []);
  const { execute } = useExecutePluginAction(action);
  const request = useTriageDetailRequest(input);
  const { instance, localRef } = request;
  const routingToken = useGithubRoutingToken(input);
  const { active, activeSignal } = useTabPanelActivity();
  const [state, setState] = useState<GithubReadStateV1<GithubRepositoryCapabilitiesV1>>(
    { kind: 'loading' },
  );
  const authority = useMemo(() => ({ request, routingToken }), [request, routingToken]);
  const previousAuthority = useRef(authority);
  const settledAuthority = useRef<typeof authority | null>(null);
  if (previousAuthority.current !== authority) {
    previousAuthority.current = authority;
    setState({ kind: 'loading' });
  }
  useEffect(() => {
    if (!active || activeSignal.aborted || settledAuthority.current === authority) return undefined;
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
            execution.status,
            execution.code ?? 'github-capabilities-read-failed',
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
  }, [active, activeSignal, authority, execute, instance, localRef, routingToken]);
  return state;
}

/* -------------------------------------------------------------------- overview */

export type GithubOverviewValueV1 = Extract<GithubOverviewResultV1, { kind: 'overview' }>;

export type GithubOverviewControllerV1 = Readonly<{
  /** `null` means the reader is still showing only its launch observation. */
  value: GithubOverviewValueV1 | null;
  refreshing: boolean;
  /** A warm failure sits beside `value`; it never erases a prior exact read. */
  failure: TriageSourceFailureV1 | null;
  refresh: () => Promise<void>;
}>;

/**
 * The Overview's one exact entity read.
 *
 * By default no effect invokes it: the launch observation is useful immediately
 * and only pressing Refresh spends a provider call. The story rail (`readWhenActive`)
 * has no Refresh control, so it reads once when it becomes active and again only
 * when GitHub reports the entry changed (`sourceUpdatedAtMs`), the way the other
 * sources' overviews read on activation. A retained Overview keeps the exact body
 * model, while its active-interval signal owns cancellation and its transient
 * busy/error state is cleared when the tab becomes inactive.
 */
export function useGithubOverview(
  input: TriageDetailSurfaceInputV1,
  options: Readonly<{ readWhenActive?: boolean }> = {},
): GithubOverviewControllerV1 {
  const action = useMemo(() => ({
    pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview,
  }), []);
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGithubRoutingToken(input);
  const { instance } = input;
  const { active, activeSignal } = useTabPanelActivity();
  const [state, setState] = useState<Readonly<{
    value: GithubOverviewValueV1 | null;
    refreshing: boolean;
    failure: TriageSourceFailureV1 | null;
  }>>({ value: null, refreshing: false, failure: null });

  useEffect(() => {
    if (active) return undefined;
    setState((current) => current.refreshing || current.failure !== null
      ? Object.freeze({ ...current, refreshing: false, failure: null })
      : current);
    return undefined;
  }, [active]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!active || state.refreshing) return;
    if (routingToken === null) {
      setState((current) => Object.freeze({
        ...current,
        refreshing: false,
        failure: ROUTE_UNAVAILABLE,
      }));
      return;
    }
    setState((current) => Object.freeze({ ...current, refreshing: true, failure: null }));
    const execution: ExecuteResult = await execute(
      { v: 1, instance, localRef, routingToken },
      { signal: activeSignal },
    );
    if (activeSignal.aborted) return;
    if (execution.status !== 'success') {
      setState((current) => Object.freeze({
        ...current,
        refreshing: false,
        failure: dispatchFailure(
          execution.status,
          execution.code ?? 'github-overview-read-failed',
        ),
      }));
      return;
    }
    const parsed = GithubOverviewResultV1Schema.safeParse(execution.result);
    if (!parsed.success) {
      setState((current) => Object.freeze({
        ...current,
        refreshing: false,
        failure: UNREADABLE_RESULT,
      }));
    } else if (parsed.data.kind === 'unavailable') {
      const failure = parsed.data.failure;
      setState((current) => Object.freeze({
        ...current,
        refreshing: false,
        failure,
      }));
    } else {
      setState(Object.freeze({ value: parsed.data, refreshing: false, failure: null }));
    }
  }, [active, activeSignal, execute, instance, localRef, routingToken, state.refreshing]);

  const readWhenActive = options.readWhenActive === true;
  const readFor = useRef<string | null>(null);
  const revision = `${routingToken ?? ''}|${localRef.entryId}|${input.observation.sourceUpdatedAtMs ?? ''}`;
  useEffect(() => {
    if (!readWhenActive || !active || readFor.current === revision) return;
    readFor.current = revision;
    void refresh();
  }, [active, readWhenActive, refresh, revision]);

  return useMemo(() => ({ ...state, refresh }), [refresh, state]);
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
  firstContinuation: string | null = null,
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
    if (!active) return undefined;
    interval.current = activeSignal;
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
    if (current.current.rows.length === 0) {
      startWalk(activeSignal);
    } else if (current.current.pending) {
      nextToken.current += 1;
      void runPage(
        nextToken.current,
        // A cancelled warm replacement has not accepted a new first page. Its
        // retained continuation belongs to the last-known-good walk, so
        // resuming that continuation would silently turn Refresh into append.
        current.current.refreshing ? firstContinuation : current.current.continuation,
        activeSignal,
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
    };
  }, [active, activeSignal, runPage, startWalk]);

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

/* ------------------------------------------------------------------ feedback */

type GithubFeedbackRootConnectionV1 = 'comments' | 'threads' | 'reviews' | 'requests';

function normalizeFeedbackComment(
  row: Readonly<{
    id: string; body: string; author?: string; createdAtMs?: number; url?: string; truncated?: true;
  }>,
): GithubFeedbackCommentV1 {
  return Object.freeze({
    id: row.id,
    body: row.body,
    author: row.author ?? null,
    createdAtMs: row.createdAtMs ?? null,
    url: row.url ?? null,
    ...(row.truncated === true ? { truncated: true as const } : {}),
  });
}

function useGithubFeedbackConnection<TRow>(
  input: TriageDetailSurfaceInputV1,
  connection: GithubFeedbackRootConnectionV1,
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
  const localRef = useLocalRef(input);
  const routingToken = useGithubRoutingToken(input);
  const { instance } = input;

  const readPage: PageReader<TRow> = useCallback(async (continuation, signal) => {
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
        failure: dispatchFailure(execution.status, execution.code ?? 'github-feedback-read-failed'),
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

  const controller = useGithubPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
  return useMemo(
    () => ({ ...controller, reviewDecision }),
    [controller, reviewDecision],
  );
}

export function useGithubFeedbackComments(
  input: TriageDetailSurfaceInputV1,
): GithubPagedControllerV1<GithubFeedbackCommentV1> {
  return useGithubFeedbackConnection(input, 'comments');
}

export function useGithubFeedbackThreads(
  input: TriageDetailSurfaceInputV1,
): GithubPagedControllerV1<GithubFeedbackThreadV1> {
  return useGithubFeedbackConnection(input, 'threads');
}

export function useGithubFeedbackReviews(
  input: TriageDetailSurfaceInputV1,
): GithubPagedControllerV1<GithubFeedbackReviewV1> & Readonly<{
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null;
}> {
  return useGithubFeedbackConnection(input, 'reviews');
}

export function useGithubFeedbackRequests(
  input: TriageDetailSurfaceInputV1,
): GithubPagedControllerV1<GithubFeedbackRequestV1> {
  return useGithubFeedbackConnection(input, 'requests');
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
  const localRef = useLocalRef(input);
  const routingToken = useGithubRoutingToken(input);
  const { instance } = input;
  const readPage: PageReader<GithubFeedbackCommentV1> = useCallback(async (continuation, signal) => {
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
        failure: dispatchFailure(execution.status, execution.code ?? 'github-feedback-read-failed'),
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
  refresh: () => void;
}>;

type GithubSettledReader<T> = (
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
function useGithubSettledRead<T>(
  read: GithubSettledReader<T>,
  active: boolean,
  activeSignal: AbortSignal,
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
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (active) return;
    inFlight.current = false;
    lastKnownGood.current = null;
    setState({ kind: 'loading' });
    setFailure(null);
    setPending(false);
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    // `attempt` is an explicit re-read through the same owner as the first
    // read. There is no timer and no second reader behind refresh.
    void attempt;
    inFlight.current = true;
    setPending(true);
    if (lastKnownGood.current === null) setState({ kind: 'loading' });
    setFailure(null);
    let left = false;
    void (async () => {
      const outcome = await read(activeSignal);
      if (left || activeSignal.aborted) return;
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
      left = true;
    };
  }, [active, activeSignal, attempt, read]);

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
  const read: GithubSettledReader<GithubChecksViewV1> = useCallback(async (signal) => {
    if (routingToken === null) {
      return { kind: 'failed', failure: ROUTE_UNAVAILABLE };
    }
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken,
    }, { signal });
    if (execution.status !== 'success') {
      const code = execution.status === 'error' || execution.status === 'outcomeUnknown'
        ? execution.code
        : 'github-detail-read-failed';
      return {
        kind: 'failed',
        failure: dispatchFailure(execution.status, code),
      };
    }
    const parsed = GithubChecksResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed', failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed', failure: parsed.data.failure };
    }
    const { kind: _kind, ...view } = parsed.data;
    return { kind: 'ready', value: view };
  }, [execute, instance, localRef, routingToken]);

  return useGithubSettledRead(read, active, activeSignal);
}
