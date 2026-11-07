import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import type { TriageDetailSurfaceInputV1, TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import { GithubOverviewResultV1Schema, type GithubOverviewResultV1 } from '../../triage/detail/contracts.js';
import { settleGithubOverviewReadV1, type GithubOverviewReadStateV1 } from './overviewState.js';
import { useGithubOverviewRetention } from './overviewRetention.js';
import { dispatchFailure, ROUTE_UNAVAILABLE, UNREADABLE_RESULT, useGithubRoutingToken, type ExecuteResult } from './readBoundary.js';

export type GithubOverviewValueV1 = Extract<GithubOverviewResultV1, { kind: 'overview' }>;

export type GithubOverviewControllerV1 = Readonly<{
  /** `null` means the reader is still showing only its launch observation. */
  value: GithubOverviewValueV1 | null;
  refreshing: boolean;
  /** A warm failure sits beside `value`; it never erases a prior exact read. */
  failure: TriageSourceFailureV1 | null;
  /** Last successful native source observation; failed refreshes never advance it. */
  checkedAtMs: number | null;
  /** True only when this exact read installed a successful, non-superseded answer. */
  refresh: () => Promise<boolean>;
  readRequirements: () => Promise<boolean>;
}>;

/**
 * The Overview's one exact entity read.
 *
 * By default no effect invokes it: the launch observation is useful immediately
 * and only pressing Refresh spends a provider call. The story rail (`readWhenActive`)
 * has no Refresh control, so it reads once when it becomes active and again only
 * when GitHub reports the entry changed (`sourceUpdatedAtMs`), the way the other
 * sources' overviews read on activation. The host's presentation scope retains a
 * settled Overview across entry mounts; active-interval cancellation and pending
 * work remain with the mounted reader.
 */
export function useGithubOverview(
  input: TriageDetailSurfaceInputV1,
  options: Readonly<{ readWhenActive?: boolean; activity?: ReturnType<typeof useTabPanelActivity> }> = {},
): GithubOverviewControllerV1 {
  const action = useMemo(() => ({
    pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview,
  }), []);
  const { execute } = useExecutePluginAction(action);
  const request = useTriageDetailRequest(input);
  const { instance, localRef } = request;
  const routingToken = useGithubRoutingToken(input);
  const tabActivity = useTabPanelActivity();
  const { active, activeSignal } = options.activity ?? tabActivity;
  const head = input.observation.snapshot.reviewRevision?.headSha;
  const revision = input.observation.sourceUpdatedAtMs;
  const retentionKey = useMemo(() => JSON.stringify([request, routingToken]), [request, routingToken]);
  const retention = useGithubOverviewRetention(retentionKey);
  const retained = retention.kind === 'ready' ? retention.value : null;
  const scope = useMemo(() => ({ request, routingToken, head, retained }), [request, routingToken, head, retained]);
  const scopeNow = useRef(scope);
  const changedScope = scopeNow.current !== scope;
  const [state, setState] = useState<GithubOverviewReadStateV1>({ value: null, checkedAtMs: null, refreshing: false, failure: null });
  const visibleState = changedScope ? { value: null, checkedAtMs: null, refreshing: false, failure: null } : state;
  if (changedScope) {
    scopeNow.current = scope;
    setState(visibleState);
  }
  const readNow = useRef(visibleState);
  readNow.current = visibleState;
  const previousRead = useRef<Promise<ExecuteResult | null>>(Promise.resolve(null));
  const readLifetime = useRef<Readonly<{ scope: typeof scope; activeSignal: AbortSignal; signal: AbortSignal }> | null>(null);
  const readFor = useRef<{ scope: typeof scope; signal: AbortSignal; revision: number | undefined; settled: boolean } | null>(null);

  useEffect(() => {
    if (!active || activeSignal.aborted) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const lifetime = { scope, activeSignal, signal: controller.signal };
    readLifetime.current = lifetime;
    activeSignal.addEventListener('abort', abort, { once: true });
    return () => {
      activeSignal.removeEventListener('abort', abort);
      if (readLifetime.current === lifetime) readLifetime.current = null;
      if (readFor.current?.signal === controller.signal && !readFor.current.settled) readFor.current = null;
      controller.abort();
    };
  }, [active, activeSignal, scope]);

  useEffect(() => {
    if (active) return undefined;
    setState((current) => current.refreshing
      ? Object.freeze({ ...current, refreshing: false })
      : current);
    return undefined;
  }, [active]);

  useEffect(() => {
    const settled = retained?.settled;
    const signal = readLifetime.current?.signal;
    if (!settled || settled.head !== head || settled.revision !== revision || !signal || signal.aborted) return;
    readFor.current = { scope, signal, revision, settled: true };
    readNow.current = settled.state;
    setState(settled.state);
  }, [active, activeSignal, head, retained, revision, scope]);

  const refresh = useCallback(async (includeBranchRules = false): Promise<boolean> => {
    if (!active || activeSignal.aborted || retained === null || scopeNow.current !== scope || readNow.current.refreshing) return false;
    const lifetime = readLifetime.current;
    if (lifetime === null || lifetime.scope !== scope || lifetime.activeSignal !== activeSignal || lifetime.signal.aborted) return false;
    const settle = (next: GithubOverviewReadStateV1) => {
      retained.settled = { head, revision, state: next };
      readNow.current = next;
      setState(next);
    };
    if (routingToken === null) {
      settle(Object.freeze({
        ...readNow.current,
        refreshing: false,
        failure: ROUTE_UNAVAILABLE,
      }));
      return false;
    }
    setState((current) => Object.freeze({ ...current, refreshing: true }));
    const prior = previousRead.current;
    const pending = (async () => {
      // Re-observation can supply a new head while this Action is in flight.
      // The scope's cleanup aborts that obsolete read at the Action boundary.
      // Let cancellation settle the shared Action guard before reusing it.
      await prior;
      if (lifetime.signal.aborted || scopeNow.current !== scope) return null;
      return execute(
        { v: 1, instance, localRef, routingToken, ...(includeBranchRules ? { includeBranchRules: true } : {}) },
        { signal: lifetime.signal },
      );
    })();
    previousRead.current = pending;
    const execution: ExecuteResult | null = await pending;
    if (execution === null || lifetime.signal.aborted || scopeNow.current !== scope) return false;
    if (execution.status !== 'success') {
      settle(Object.freeze({
        ...readNow.current,
        refreshing: false,
        failure: dispatchFailure(
          execution,
          'github-overview-read-failed',
        ),
      }));
      return false;
    }
    const parsed = GithubOverviewResultV1Schema.safeParse(execution.result);
    if (!parsed.success) {
      settle(Object.freeze({
        ...readNow.current,
        refreshing: false,
        failure: UNREADABLE_RESULT,
      }));
    } else if (parsed.data.kind === 'unavailable') {
      const failure = parsed.data.failure;
      settle(Object.freeze({
        ...readNow.current,
        refreshing: false,
        failure,
      }));
    } else {
      const admitted = parsed.data;
      settle(settleGithubOverviewReadV1(readNow.current, admitted));
      if (admitted.kindId !== 'pull-request') return true;
      if (admitted.pullRequestStatus === undefined) return false;
      const observedHead = admitted.pullRequestStatus.branch?.headRevision;
      return !(observedHead !== undefined && admitted.headRevision !== undefined && observedHead !== admitted.headRevision)
        && !(head !== undefined && admitted.headRevision !== undefined && head !== admitted.headRevision);
    }
    return false;
  }, [active, activeSignal, execute, head, instance, localRef, retained, revision, routingToken, scope]);
  const readRequirements = useCallback(() => refresh(true), [refresh]);

  const readWhenActive = options.readWhenActive === true;
  useEffect(() => {
    const signal = readLifetime.current?.signal;
    // A newer same-head revision remains demand while the current read is
    // busy. Its settlement clears refreshing and admits only the latest one.
    if (!readWhenActive || !active || retained === null || visibleState.refreshing || signal === undefined || signal.aborted
      || (readFor.current?.scope === scope && readFor.current.revision === revision)) return;
    const acquisition = { scope, signal, revision, settled: false };
    readFor.current = acquisition;
    void refresh().then(() => { if (!signal.aborted) acquisition.settled = true; });
  }, [active, activeSignal, readWhenActive, refresh, retained, revision, scope, visibleState.refreshing]);

  return useMemo(() => ({ ...visibleState,
    ...(retention.kind === 'unavailable' ? { refreshing: false, failure: retention.failure } : {}),
    refresh, readRequirements }), [refresh, readRequirements, retention, visibleState]);
}
