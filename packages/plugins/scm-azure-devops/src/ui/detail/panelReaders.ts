import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { AZURE_DEVOPS_PLUGIN_ID } from '../../azureDevopsContracts.js';
import {
  AzureCommitsResultV1Schema,
  AzureIterationChangesResultV1Schema,
  AzureIterationsResultV1Schema,
  AzurePoliciesResultV1Schema,
  AzureThreadsResultV1Schema,
} from '../../triage/detail/contracts.js';
import type {
  AzureProjectedChangedFileRowV1,
  AzureProjectedCommitRowV1,
  AzureProjectedIterationRowV1,
  AzureProjectedPolicyEvaluationRowV1,
  AzureProjectedStatusRowV1,
  AzureProjectedThreadRowV1,
} from '../../triage/detail/projection.js';
import { AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/detailActions.js';

import {
  azurePagedInitialState,
  azurePagedReducer,
  decodeAzureChangesPosition,
  encodeAzureChangesPosition,
  type AzurePagedPageV1,
  type AzurePagedStateV1,
  type AzureReadStateV1,
} from './panelState.js';

/**
 * The panel-owned readers behind the Azure DevOps detail body.
 *
 * Each reader's lifetime is the lifetime of the panel that owns its data: every
 * read is scoped to its panel's active interval, so leaving aborts the request
 * and rejects a late result. Discard panels clear their rows; Files retains its
 * parsed walk and provider position exactly as its tab declaration requires.
 * Nothing here fetches on mount of the detail surface.
 *
 * The one exception is `useAzureIterations`, which belongs to the detail ROOT
 * rather than to a tab. `Activity` and `Files` both need to know which iteration
 * is current, and two readers would answer from two snapshots — so there is one
 * read, and its projection is passed down.
 */

/** A result the surface could not read is a contract break, not an empty read. */
const UNREADABLE_RESULT: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'azure-devops/detail-result-unreadable',
});

function dispatchFailure(status: string, code: string): TriageSourceFailureV1 {
  return Object.freeze({
    class: status === 'error' ? 'transient' : 'unknown',
    code: status === 'idle' || status === 'pending'
      ? 'azure-devops/detail-read-not-dispatched'
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
export function useAzureEntryLocalRef(input: TriageDetailSurfaceInputV1) {
  const { entryRef } = input.observation;
  return useMemo(() => ({
    kindId: entryRef.kindId,
    collisionScope: entryRef.collisionScope,
    entryId: entryRef.entryId,
  }), [entryRef.collisionScope, entryRef.entryId, entryRef.kindId]);
}

function useEntryInput(input: TriageDetailSurfaceInputV1) {
  const { locator } = input.observation;
  const { instance } = input;
  const localRef = useAzureEntryLocalRef(input);
  return useMemo(() => ({
    v: 1 as const,
    instance,
    localRef,
    routingToken: locator.routingToken ?? '',
  }), [instance, localRef, locator.routingToken]);
}

/* ------------------------------------------------------------- settled reads */

/**
 * Drives one read that settles once for the lifetime of its owner.
 *
 * `Iterations`, `Policies` and `Threads` are all of this shape, because Azure
 * makes them so: the documented thread endpoint returns every thread and
 * publishes no cursor, and neither the status nor the evaluation section is a
 * reader-driven walk.
 */
function useAzureSettledRead<T>(
  read: (signal: AbortSignal) => Promise<Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>>,
  active: boolean,
  activeSignal: AbortSignal,
): Readonly<{ state: AzureReadStateV1<T>; refresh: () => void }> {
  const [state, setState] = useState<AzureReadStateV1<T>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    // `attempt` is the reader's explicit refresh. It re-enters this effect,
    // which is the same code path the first read takes — there is no second read
    // owner and no automatic poll.
    void attempt;
    setState((current) => (current.kind === 'ready'
      ? { ...current, pending: true, failure: null }
      : { kind: 'loading' }));
    let left = false;
    const superseded = new AbortController();
    const mergedSignal = mergeAbortSignals([activeSignal, superseded.signal]);
    const readSignal = mergedSignal.signal;
    void (async () => {
      try {
        const outcome = await read(readSignal);
        if (left || readSignal.aborted) return;
        setState((current) => {
          if (outcome.kind === 'ready') {
            return { kind: 'ready', value: outcome.value, pending: false, failure: null };
          }
          return current.kind === 'ready'
            ? { ...current, pending: false, failure: outcome.failure }
            : { kind: 'unavailable', failure: outcome.failure };
        });
      } finally {
        mergedSignal.dispose();
      }
    })();
    return () => {
      left = true;
      superseded.abort();
      mergedSignal.dispose();
    };
  }, [active, activeSignal, attempt, read]);

  // A discarded tab clears only when it actually leaves. Refresh supersession
  // uses the cleanup above but deliberately keeps the last-known-good value.
  useEffect(() => {
    if (!active) setState({ kind: 'loading' });
  }, [active]);

  const refresh = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return useMemo(() => ({ state, refresh }), [refresh, state]);
}

/* ---------------------------------------------------------------- iterations */

export type AzureIterationsViewV1 = Readonly<{
  rows: readonly AzureProjectedIterationRowV1[];
  /** Absent when Azure returned none. It is never `0`. */
  currentIterationId?: number;
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

export type AzureIterationsControllerV1 = Readonly<{
  state: AzureReadStateV1<AzureIterationsViewV1>;
  refresh: () => void;
}>;

/**
 * The ONE iteration read of a mounted detail body.
 *
 * It is called from the detail root, not from a tab, and it is deliberately not
 * scoped to a tab's active interval: `Activity` and `Files` both consume its
 * projection, and a read that died when one tab was left would leave the other
 * comparing against nothing.
 */
export function useAzureIterations(
  input: TriageDetailSurfaceInputV1,
  signal: AbortSignal,
): AzureIterationsControllerV1 {
  const action = useMemo(
    () => ({
      pluginId: AZURE_DEVOPS_PLUGIN_ID,
      localId: AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readIterations,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const entry = useEntryInput(input);

  const read = useCallback(async (readSignal: AbortSignal) => {
    const execution = await execute(entry, { signal: readSignal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'azure-devops/detail-read-failed'),
      };
    }
    const parsed = AzureIterationsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    const { currentIterationId, omittedRowCount, projectionTruncated, rows } = parsed.data;
    return {
      kind: 'ready' as const,
      value: {
        rows,
        omittedRowCount,
        projectionTruncated,
        ...(currentIterationId === undefined ? {} : { currentIterationId }),
      },
    };
  }, [entry, execute]);

  return useAzureSettledRead(read, true, signal);
}

/* -------------------------------------------------------------- paged planes */

export type AzurePagedControllerV1<TRow> = Readonly<{
  state: AzurePagedStateV1<TRow>;
  loadMore: () => void;
  refresh: () => void;
}>;

type PageReader<TRow> = (
  cursor: string | null,
  signal: AbortSignal,
) => Promise<Readonly<{ kind: 'page'; page: AzurePagedPageV1<TRow> }>
| Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>>;

type AzurePagedWalkOptionsV1 = Readonly<{
  /** Retain the parsed walk while the tab is inactive. Its in-flight read is still aborted. */
  retainOnDeactivate?: boolean;
  /** A provider identity change invalidates a retained walk. */
  resetKey?: string | number;
}>;

function useAzurePagedWalk<TRow>(
  readPage: PageReader<TRow>,
  enabled: boolean,
  disabledFailure: TriageSourceFailureV1,
  options: AzurePagedWalkOptionsV1 = {},
): AzurePagedControllerV1<TRow> {
  const [state, dispatch] = useReducer(
    azurePagedReducer<TRow>,
    undefined,
    azurePagedInitialState<TRow>,
  );
  const { active, activeSignal } = useTabPanelActivity();
  const interval = useRef<AbortSignal | null>(null);
  const requested = useRef<Set<string>>(new Set());
  const inFlight = useRef<AbortController | null>(null);
  /** Monotonic across the panel's whole life, never derived from the reducer. */
  const nextToken = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const resetKey = options.resetKey;
  const retainOnDeactivate = options.retainOnDeactivate === true;
  const previousResetKey = useRef<string | number | undefined>(undefined);

  const runPage = useCallback(async (
    token: number,
    cursor: string | null,
    pageSignal: AbortSignal,
    replaceRows: boolean,
  ): Promise<void> => {
    const superseded = new AbortController();
    inFlight.current = superseded;
    const mergedSignal = mergeAbortSignals([pageSignal, superseded.signal]);
    const requestSignal = mergedSignal.signal;
    dispatch({ kind: 'requestStarted', token });
    try {
      const outcome = await readPage(cursor, requestSignal);
      if (requestSignal.aborted) return;
      if (inFlight.current === superseded) inFlight.current = null;
      if (outcome.kind === 'failed') {
        dispatch({ kind: 'pageFailed', token, failure: outcome.failure });
        return;
      }
      const repeatedContinuation = outcome.page.continuation !== null
        && requested.current.has(outcome.page.continuation);
      if (replaceRows) {
        dispatch({ kind: 'panelLeft' });
        dispatch({ kind: 'requestStarted', token });
      }
      dispatch({
        kind: 'pageSettled',
        token,
        page: repeatedContinuation
          ? { ...outcome.page, continuation: null }
          : outcome.page,
      });
      if (repeatedContinuation) {
        dispatch({
          kind: 'pageFailed',
          token,
          failure: {
            class: 'unsupportedContract',
            code: 'azure-devops/detail-continuation-non-progress',
          },
        });
      }
    } finally {
      mergedSignal.dispose();
    }
  }, [readPage]);

  const startWalk = useCallback((pageSignal: AbortSignal, replaceRows: boolean): void => {
    inFlight.current?.abort();
    inFlight.current = null;
    requested.current = new Set();
    if (!replaceRows) dispatch({ kind: 'panelLeft' });
    nextToken.current += 1;
    if (enabled) {
      void runPage(nextToken.current, null, pageSignal, replaceRows);
      return;
    }
    // A plane with nothing to address settles as unavailable NAMING itself,
    // never as an idle or empty panel.
    const token = nextToken.current;
    dispatch({ kind: 'requestStarted', token });
    dispatch({ kind: 'pageFailed', token, failure: disabledFailure });
  }, [disabledFailure, enabled, runPage]);

  useEffect(() => {
    if (!active) return undefined;
    interval.current = activeSignal;
    const keyChanged = previousResetKey.current !== resetKey;
    previousResetKey.current = resetKey;
    if (
      !retainOnDeactivate
      || keyChanged
      || stateRef.current.kind !== 'ready'
      || stateRef.current.pending
    ) {
      startWalk(activeSignal, false);
    }
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
      interval.current = null;
      requested.current = new Set();
      if (!retainOnDeactivate) dispatch({ kind: 'panelLeft' });
    };
  }, [active, activeSignal, resetKey, retainOnDeactivate, startWalk]);

  const loadMore = useCallback(() => {
    const pageSignal = interval.current;
    const next = state.continuation;
    if (!state.canLoadMore || state.pending || next === null || pageSignal === null) return;
    if (requested.current.has(next)) return;
    requested.current.add(next);
    nextToken.current += 1;
    void runPage(nextToken.current, next, pageSignal, false);
  }, [runPage, state.canLoadMore, state.continuation, state.pending]);

  const refresh = useCallback(() => {
    const pageSignal = interval.current;
    if (pageSignal === null || state.pending) return;
    startWalk(pageSignal, true);
  }, [startWalk, state.pending]);

  return useMemo(() => ({ state, loadMore, refresh }), [loadMore, refresh, state]);
}

/* ------------------------------------------------------------------- commits */

export function useAzureCommits(
  input: TriageDetailSurfaceInputV1,
): AzurePagedControllerV1<AzureProjectedCommitRowV1> {
  const action = useMemo(
    () => ({
      pluginId: AZURE_DEVOPS_PLUGIN_ID,
      localId: AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.listCommits,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const entry = useEntryInput(input);

  const readPage: PageReader<AzureProjectedCommitRowV1> = useCallback(async (cursor, signal) => {
    const execution = await execute({
      ...entry,
      ...(cursor === null ? {} : { continuationToken: cursor }),
    }, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'azure-devops/detail-read-failed'),
      };
    }
    const parsed = AzureCommitsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    const page = parsed.data;
    return {
      kind: 'page' as const,
      page: {
        rows: page.rows,
        omittedRowCount: page.omittedRowCount,
        projectionTruncated: page.projectionTruncated,
        continuation: page.continuationToken ?? null,
        incomplete: page.incomplete ?? null,
      },
    };
  }, [entry, execute]);

  return useAzurePagedWalk(readPage, true, UNREADABLE_RESULT);
}

/* --------------------------------------------------------------------- files */

/** The `Files` tab has nothing to compare against until the root names one. */
const ITERATION_UNAVAILABLE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'azure-devops/iteration-unavailable',
});

/**
 * The changed files of the iteration the ROOT selected.
 *
 * `iterationId` is an argument rather than a read: one iteration owner per
 * mounted body. When the root has no current iteration, this plane says so
 * instead of guessing `1`.
 */
export function useAzureIterationChanges(
  input: TriageDetailSurfaceInputV1,
  iterationId: number | undefined,
): AzurePagedControllerV1<AzureProjectedChangedFileRowV1> {
  const action = useMemo(
    () => ({
      pluginId: AZURE_DEVOPS_PLUGIN_ID,
      localId: AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.listIterationChanges,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const entry = useEntryInput(input);

  const readPage: PageReader<AzureProjectedChangedFileRowV1> = useCallback(
    async (cursor, signal) => {
      if (iterationId === undefined) {
        return { kind: 'failed' as const, failure: ITERATION_UNAVAILABLE };
      }
      // Both numbers came from Azure's own previous response. This decodes the
      // pair; it never adds to either one.
      const position = cursor === null ? null : decodeAzureChangesPosition(cursor);
      const execution = await execute({
        ...entry,
        iterationId,
        ...(position === null ? {} : { skip: position.skip, top: position.top }),
      }, { signal }) as ExecuteResult;
      if (execution.status !== 'success') {
        return {
          kind: 'failed' as const,
          failure: dispatchFailure(execution.status, execution.code ?? 'azure-devops/detail-read-failed'),
        };
      }
      const parsed = AzureIterationChangesResultV1Schema.safeParse(execution.result);
      if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
      if (parsed.data.kind === 'unavailable') {
        return { kind: 'failed' as const, failure: parsed.data.failure };
      }
      const page = parsed.data;
      return {
        kind: 'page' as const,
        page: {
          rows: page.rows,
          omittedRowCount: page.omittedRowCount,
          projectionTruncated: page.projectionTruncated,
          // Present together or absent together: half a position would have to
          // be completed by guessing, which is the defect this rule prevents.
          continuation: 'nextSkip' in page
            ? encodeAzureChangesPosition({ nextSkip: page.nextSkip, nextTop: page.nextTop })
            : null,
          incomplete: null,
        },
      };
    },
    [entry, execute, iterationId],
  );

  return useAzurePagedWalk(readPage, iterationId !== undefined, ITERATION_UNAVAILABLE, {
    retainOnDeactivate: true,
    ...(iterationId === undefined ? {} : { resetKey: iterationId }),
  });
}

/* ------------------------------------------------------------------ policies */

export type AzurePoliciesViewV1 = Readonly<{
  statuses: readonly AzureProjectedStatusRowV1[];
  evaluations: readonly AzureProjectedPolicyEvaluationRowV1[];
  evaluationsPartial: boolean;
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

export function useAzurePolicies(
  input: TriageDetailSurfaceInputV1,
): Readonly<{ state: AzureReadStateV1<AzurePoliciesViewV1>; refresh: () => void }> {
  const action = useMemo(
    () => ({
      pluginId: AZURE_DEVOPS_PLUGIN_ID,
      localId: AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readPolicies,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const entry = useEntryInput(input);
  const { active, activeSignal } = useTabPanelActivity();

  const read = useCallback(async (signal: AbortSignal) => {
    const execution = await execute(entry, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'azure-devops/detail-read-failed'),
      };
    }
    const parsed = AzurePoliciesResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    const {
      evaluations,
      evaluationsPartial,
      omittedRowCount,
      projectionTruncated,
      statuses,
    } = parsed.data;
    return {
      kind: 'ready' as const,
      value: { statuses, evaluations, evaluationsPartial, omittedRowCount, projectionTruncated },
    };
  }, [entry, execute]);

  return useAzureSettledRead(read, active, activeSignal);
}

/* ------------------------------------------------------------------- threads */

export type AzureThreadsViewV1 = Readonly<{
  rows: readonly AzureProjectedThreadRowV1[];
  omittedRowCount: number;
  projectionTruncated: boolean;
}>;

/**
 * Every review thread, in one read.
 *
 * There is no walk here because Azure publishes no cursor for this collection.
 * The reader's thread and reply windows are local slices of `rows`, so expanding
 * either one issues no request.
 */
export function useAzureThreads(
  input: TriageDetailSurfaceInputV1,
): Readonly<{ state: AzureReadStateV1<AzureThreadsViewV1>; refresh: () => void }> {
  const action = useMemo(
    () => ({
      pluginId: AZURE_DEVOPS_PLUGIN_ID,
      localId: AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readThreads,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const entry = useEntryInput(input);
  const { active, activeSignal } = useTabPanelActivity();

  const read = useCallback(async (signal: AbortSignal) => {
    const execution = await execute(entry, { signal }) as ExecuteResult;
    if (execution.status !== 'success') {
      return {
        kind: 'failed' as const,
        failure: dispatchFailure(execution.status, execution.code ?? 'azure-devops/detail-read-failed'),
      };
    }
    const parsed = AzureThreadsResultV1Schema.safeParse(execution.result);
    if (!parsed.success) return { kind: 'failed' as const, failure: UNREADABLE_RESULT };
    if (parsed.data.kind === 'unavailable') {
      return { kind: 'failed' as const, failure: parsed.data.failure };
    }
    const { omittedRowCount, projectionTruncated, rows } = parsed.data;
    return { kind: 'ready' as const, value: { rows, omittedRowCount, projectionTruncated } };
  }, [entry, execute]);

  return useAzureSettledRead(read, active, activeSignal);
}
