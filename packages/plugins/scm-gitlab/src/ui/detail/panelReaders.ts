import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_DETAIL_ACTION_IDS,
} from '../../triage/contribution.js';
import {
  GitlabActivityEventsResultV1Schema,
  GitlabApprovalsResultV1Schema,
  GitlabChangesResultV1Schema,
  GitlabDiscussionsResultV1Schema,
  GitlabNotesResultV1Schema,
  GitlabPipelinesResultV1Schema,
  GitlabRawDiffResultV1Schema,
} from '../../triage/detail/contracts.js';
import type {
  GitlabProjectedActivityEventRowV1,
  GitlabProjectedApprovalRuleV1,
  GitlabProjectedChangedFileRowV1,
  GitlabProjectedDiscussionRowV1,
  GitlabProjectedNoteRowV1,
  GitlabProjectedPipelineRowV1,
} from '../../triage/detail/projection.js';
import {
  GITLAB_CHANGES_PAGE_SIZE_V1,
  GITLAB_DISCUSSIONS_PAGE_SIZE_V1,
  GITLAB_ISSUE_EVENTS_PAGE_SIZE_V1,
  GITLAB_ISSUE_NOTES_PAGE_SIZE_V1,
  GITLAB_MERGE_REQUEST_EVENTS_PAGE_SIZE_V1,
  GITLAB_MERGE_REQUEST_NOTES_PAGE_SIZE_V1,
  GITLAB_PIPELINES_PAGE_SIZE_V1,
  type GitlabActivityEventSourceV1,
} from '../../triage/detail/routes.js';

import {
  gitlabPagedInitialState,
  gitlabPagedReducer,
  type GitlabPagedPageV1,
  type GitlabPagedStateV1,
  type GitlabReadStateV1,
} from './panelState.js';

/**
 * The panel-owned readers behind the GitLab detail body.
 *
 * Each reader's lifetime is the lifetime of the panel that owns its data, and
 * that is a structural fact here rather than a convention: every read below is
 * scoped to its panel's active interval, so leaving aborts the request, rejects
 * a late result, and discards every row the panel held. A tab that declares
 * `retain` keeps its list geometry and nothing else — the reducer is reset the
 * moment the panel becomes inactive.
 *
 * That lifetime is also the rate budget. GitLab involvement scanning already
 * issues real provider work, and the Activity panel alone owns four independent
 * walks. Nothing here fetches on mount of the detail surface: a plane's first
 * request is issued when its tab becomes active and never before.
 *
 * No reader holds a credential, builds a URL, or sees a raw provider body. Each
 * names its exact configured deployment, entry and observed route and invokes
 * one source-owned Action; what comes back has already passed the boundary
 * projector.
 */

/** A result the surface could not read is a contract break, not an empty read. */
const UNREADABLE_RESULT: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-detail-result-unreadable',
});

/**
 * The observation carried no route for this entry, so no plane can be read.
 *
 * It is a stated failure rather than an empty panel: a project is never guessed
 * from identity, display text or a git remote.
 */
const ROUTE_UNAVAILABLE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'gitlab-locator-unusable',
});

function dispatchFailure(status: string, code: string): TriageSourceFailureV1 {
  return Object.freeze({
    class: status === 'error' ? 'transient' : 'unknown',
    code: status === 'idle' || status === 'pending' ? 'gitlab-detail-read-not-dispatched' : code,
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
export function useGitlabRoutingToken(input: TriageDetailSurfaceInputV1): string | null {
  return input.observation.locator.routingToken ?? null;
}

/* ------------------------------------------------------------- paged planes */

export type GitlabPagedControllerV1<TRow> = Readonly<{
  state: GitlabPagedStateV1<TRow>;
  loadMore: () => void;
  /**
   * Restarts the walk at the first page.
   *
   * Refresh in a detail panel is explicit and reader-initiated; there is no
   * automatic poll inside a tab, because a tab that re-reads on its own spends
   * GitLab's rate budget for a reader who is not looking.
   */
  refresh: () => void;
}>;

type PageReader<TRow> = (
  continuation: string | null,
  signal: AbortSignal,
) => Promise<Readonly<{ kind: 'page'; page: GitlabPagedPageV1<TRow> }>
| Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>>;

/**
 * Drives one paged walk for one mounted panel.
 *
 * The walk refuses to request a position it has already requested in this
 * interval. A provider that kept advertising the same page would otherwise make
 * the panel read it forever, and the read module's own non-advancing guard only
 * sees one response at a time.
 */
function useGitlabPagedWalk<TRow>(
  readPage: PageReader<TRow>,
  enabled: boolean,
  disabledFailure: TriageSourceFailureV1,
): GitlabPagedControllerV1<TRow> {
  const [state, dispatch] = useReducer(
    gitlabPagedReducer<TRow>,
    undefined,
    gitlabPagedInitialState<TRow>,
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
    // never as an idle or empty panel: the reader is owed the difference between
    // "no rows" and "we had no route to ask".
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
  incomplete?: 'pagination';
  continuation?: string;
}>;

function toPage<TRow>(result: PagedResultShape<TRow>): GitlabPagedPageV1<TRow> {
  return {
    rows: result.rows,
    omittedRowCount: result.omittedRowCount,
    projectionTruncated: result.projectionTruncated,
    continuation: result.continuation ?? null,
    incomplete: result.incomplete ?? null,
  };
}

/* --------------------------------------------------------------------- notes */

/**
 * The notes walk of whichever kind is mounted.
 *
 * The window differs by kind because the two tabs declare different windows: a
 * merge request's Activity mounts 36 notes beside its event sources, and an
 * issue's Comments tab mounts 32. That is a declared reader window, not a
 * provider difference, so it is chosen here rather than inside the Action.
 */
export function useGitlabNotes(
  input: TriageDetailSurfaceInputV1,
): GitlabPagedControllerV1<GitlabProjectedNoteRowV1> {
  const action = useMemo(
    () => ({ pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGitlabRoutingToken(input);
  const { instance } = input;
  const limit = localRef.kindId === 'issue'
    ? GITLAB_ISSUE_NOTES_PAGE_SIZE_V1
    : GITLAB_MERGE_REQUEST_NOTES_PAGE_SIZE_V1;

  const readPage: PageReader<GitlabProjectedNoteRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      limit,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'gitlab-detail-read-failed'),
      };
    }
    const parsed = GitlabNotesResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, limit, localRef, routingToken]);

  return useGitlabPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
}

/* ------------------------------------------------------------ activity events */

/**
 * One activity event source's own walk.
 *
 * The Activity panel mounts three of these plus the notes walk, and each holds
 * its own cursor. Sharing one would advance label events because the reader
 * asked for more state events, and the union would then be missing rows nobody
 * skipped on purpose.
 */
export function useGitlabActivityEvents(
  input: TriageDetailSurfaceInputV1,
  source: GitlabActivityEventSourceV1,
): GitlabPagedControllerV1<GitlabProjectedActivityEventRowV1> {
  const action = useMemo(
    () => ({
      pluginId: GITLAB_PLUGIN_ID,
      localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGitlabRoutingToken(input);
  const { instance } = input;
  const limit = localRef.kindId === 'issue'
    ? GITLAB_ISSUE_EVENTS_PAGE_SIZE_V1
    : GITLAB_MERGE_REQUEST_EVENTS_PAGE_SIZE_V1;

  const readPage: PageReader<GitlabProjectedActivityEventRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      eventSource: source,
      limit,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'gitlab-detail-read-failed'),
      };
    }
    const parsed = GitlabActivityEventsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, limit, localRef, routingToken, source]);

  return useGitlabPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
}

/* --------------------------------------------------------------- discussions */

export function useGitlabDiscussions(
  input: TriageDetailSurfaceInputV1,
): GitlabPagedControllerV1<GitlabProjectedDiscussionRowV1> {
  const action = useMemo(
    () => ({
      pluginId: GITLAB_PLUGIN_ID,
      localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGitlabRoutingToken(input);
  const { instance } = input;

  const readPage: PageReader<GitlabProjectedDiscussionRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      limit: GITLAB_DISCUSSIONS_PAGE_SIZE_V1,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'gitlab-detail-read-failed'),
      };
    }
    const parsed = GitlabDiscussionsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    return { kind: 'page' as const, page: toPage(parsed.data) };
  }, [execute, instance, localRef, routingToken]);

  return useGitlabPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
}

/* ------------------------------------------------------------------- changes */

export type GitlabChangesViewV1 = Readonly<{
  /** `unknown` means GitLab supplied no per-file truncation evidence at all. */
  diffLimitStatus: 'reported' | 'unknown';
}>;

export type GitlabChangesControllerV1 = GitlabPagedControllerV1<GitlabProjectedChangedFileRowV1>
  & Readonly<{ diffLimitStatus: 'reported' | 'unknown' }>;

/**
 * The `/diffs` walk, plus the one plane-level fact its rows cannot carry.
 *
 * `diffLimitStatus` is sticky across pages in the honest direction only: once
 * any page fails to report per-file truncation evidence, the tab may not claim a
 * complete diff for the rest of the walk.
 */
export function useGitlabChanges(
  input: TriageDetailSurfaceInputV1,
): GitlabChangesControllerV1 {
  const action = useMemo(
    () => ({ pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGitlabRoutingToken(input);
  const { instance } = input;
  const [diffLimitStatus, setDiffLimitStatus] = useState<'reported' | 'unknown'>('unknown');

  const readPage: PageReader<GitlabProjectedChangedFileRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      limit: GITLAB_CHANGES_PAGE_SIZE_V1,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'gitlab-detail-read-failed'),
      };
    }
    const parsed = GitlabChangesResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    const page = parsed.data;
    setDiffLimitStatus((current) => (
      // A first page starts the walk at whatever it reported; any later page
      // that reports `unknown` degrades the whole tab and never recovers.
      continuation === null
        ? page.diffLimitStatus
        : current === 'unknown' ? 'unknown' : page.diffLimitStatus
    ));
    return { kind: 'page' as const, page: toPage(page) };
  }, [execute, instance, localRef, routingToken]);

  const controller = useGitlabPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
  return useMemo(() => ({ ...controller, diffLimitStatus }), [controller, diffLimitStatus]);
}

/* --------------------------------------------------------------- raw diff */

export type GitlabRawDiffStateV1 =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; text: string; truncated: boolean }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

/**
 * The explicit raw-evidence reader. Unlike the structured `/diffs` walk it does
 * nothing when the panel activates; `load` is the named user request §4.6a
 * requires. The active panel signal supplies cancellation on tab leave.
 */
export function useGitlabRawDiff(
  input: TriageDetailSurfaceInputV1,
): Readonly<{ state: GitlabRawDiffStateV1; load: () => void }> {
  const action = useMemo(
    () => ({ pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGitlabRoutingToken(input);
  const { instance } = input;
  const { active, activeSignal } = useTabPanelActivity();
  const [state, setState] = useState<GitlabRawDiffStateV1>({ kind: 'idle' });

  useEffect(() => {
    if (active) return undefined;
    setState({ kind: 'idle' });
    return undefined;
  }, [active]);

  const load = useCallback(() => {
    if (!active || state.kind === 'loading') return;
    if (routingToken === null) {
      setState({ kind: 'unavailable', failure: ROUTE_UNAVAILABLE });
      return;
    }
    setState({ kind: 'loading' });
    void (async () => {
      const execution = await execute({
        v: 1,
        instance,
        localRef,
        routingToken,
      }, { signal: activeSignal }) as ExecuteResult;
      if (activeSignal.aborted) return;
      if (execution.status !== 'success') {
        setState({
          kind: 'unavailable',
          failure: dispatchFailure(execution.status, execution.code ?? 'gitlab-raw-diff-read-failed'),
        });
        return;
      }
      const parsed = GitlabRawDiffResultV1Schema.safeParse(execution.result);
      if (!parsed.success) {
        setState({ kind: 'unavailable', failure: UNREADABLE_RESULT });
        return;
      }
      if (parsed.data.kind === 'unavailable') {
        setState({ kind: 'unavailable', failure: parsed.data.failure });
        return;
      }
      setState({
        kind: 'ready',
        text: parsed.data.text,
        truncated: parsed.data.truncated,
      });
    })();
  }, [active, activeSignal, execute, instance, localRef, routingToken, state.kind]);

  return useMemo(() => ({ state, load }), [load, state]);
}

/* ----------------------------------------------------------------- pipelines */

export type GitlabPipelinesRollupV1 = Readonly<{
  failingCount?: number;
  runningCount?: number;
  passingCount?: number;
  rollupPipelineId?: string;
}>;

export type GitlabPipelinesControllerV1 = GitlabPagedControllerV1<GitlabProjectedPipelineRowV1>
  & Readonly<{ rollup: GitlabPipelinesRollupV1 }>;

/**
 * The pipeline walk plus the rollup of its newest pipeline.
 *
 * The rollup belongs to the FIRST page: it describes the newest pipeline, and a
 * later page holds older ones. A page appended by `Show more` therefore never
 * overwrites it — doing so would relabel the tab's headline with the rollup of a
 * pipeline from last week.
 */
export function useGitlabPipelines(
  input: TriageDetailSurfaceInputV1,
): GitlabPipelinesControllerV1 {
  const action = useMemo(
    () => ({ pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const localRef = useLocalRef(input);
  const routingToken = useGitlabRoutingToken(input);
  const { instance } = input;
  const [rollup, setRollup] = useState<GitlabPipelinesRollupV1>({});

  const readPage: PageReader<GitlabProjectedPipelineRowV1> = useCallback(async (
    continuation,
    signal,
  ) => {
    const execution = await execute({
      v: 1,
      instance,
      localRef,
      routingToken: routingToken ?? '',
      limit: GITLAB_PIPELINES_PAGE_SIZE_V1,
      ...(continuation === null ? {} : { continuation }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'gitlab-detail-read-failed'),
      };
    }
    const parsed = GitlabPipelinesResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    const page = parsed.data;
    if (continuation === null) {
      const { failingCount, runningCount, passingCount, rollupPipelineId } = page;
      setRollup({
        ...(failingCount === undefined ? {} : { failingCount }),
        ...(runningCount === undefined ? {} : { runningCount }),
        ...(passingCount === undefined ? {} : { passingCount }),
        ...(rollupPipelineId === undefined ? {} : { rollupPipelineId }),
      });
    }
    return { kind: 'page' as const, page: toPage(page) };
  }, [execute, instance, localRef, routingToken]);

  const controller = useGitlabPagedWalk(readPage, routingToken !== null, ROUTE_UNAVAILABLE);
  return useMemo(() => ({ ...controller, rollup }), [controller, rollup]);
}

/* ----------------------------------------------------------------- approvals */

export type GitlabApprovalRulesViewV1 =
  | Readonly<{
    kind: 'available';
    rules: readonly GitlabProjectedApprovalRuleV1[];
    omittedRuleCount: number;
  }>
  | Readonly<{ kind: 'editionUnsupported' }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

export type GitlabApprovalsViewV1 = Readonly<{
  approvalsRequired?: number;
  approvalsLeft?: number;
  approvedBy: readonly string[];
  userHasApproved?: boolean;
  userCanApprove?: boolean;
  rules: GitlabApprovalRulesViewV1;
  projectionTruncated: boolean;
}>;

export type GitlabApprovalsControllerV1 = Readonly<{
  state: GitlabReadStateV1<GitlabApprovalsViewV1>;
  refresh: () => void;
}>;

/**
 * Reads the approval surface for exactly as long as its panel is active.
 *
 * The two provider collections settle together because their rendered answer is
 * one state, so this plane is a single read rather than a walk. Leaving aborts
 * it and returns the panel to `loading`; a late result cannot publish into a
 * panel nobody is looking at.
 */
export function useGitlabApprovals(
  input: TriageDetailSurfaceInputV1,
): GitlabApprovalsControllerV1 {
  const action = useMemo(
    () => ({ pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { active, activeSignal } = useTabPanelActivity();
  const localRef = useLocalRef(input);
  const routingToken = useGitlabRoutingToken(input);
  const { instance } = input;
  const [state, setState] = useState<GitlabReadStateV1<GitlabApprovalsViewV1>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    // `attempt` is the reader's explicit refresh. It re-enters this effect,
    // which is the same code path the first read takes — there is no second read
    // owner and no automatic poll.
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
          failure: dispatchFailure(execution.status, execution.code ?? 'gitlab-detail-read-failed'),
        });
        return;
      }
      const parsed = GitlabApprovalsResultV1Schema.safeParse(execution.result);
      if (!parsed.success) {
        setState({ kind: 'unavailable', failure: UNREADABLE_RESULT });
        return;
      }
      if (parsed.data.kind === 'unavailable') {
        setState({ kind: 'unavailable', failure: parsed.data.failure });
        return;
      }
      const { kind: _kind, ...view } = parsed.data;
      setState({ kind: 'ready', value: view as GitlabApprovalsViewV1 });
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
