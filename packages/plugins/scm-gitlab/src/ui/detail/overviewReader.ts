import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useExecutePluginAction, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import type { TriageDetailSurfaceInputV1, TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { GITLAB_PLUGIN_ID, GITLAB_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/contribution.js';
import { GitlabOpeningDetailV1Schema, GitlabOverviewResultV1Schema,
  type GitlabOverviewResultV1 } from '../../triage/detail/contracts.js';
import { dispatchFailure, ROUTE_UNAVAILABLE, UNREADABLE_RESULT, useGitlabRoutingToken,
  type ExecuteResult } from './readBoundary.js';

export type GitlabOverviewValueV1 = Extract<GitlabOverviewResultV1, { kind: 'overview' }>;
export type GitlabOverviewControllerV1 = Readonly<{
  value: GitlabOverviewValueV1 | null;
  refreshing: boolean;
  failure: TriageSourceFailureV1 | null;
  refresh: () => Promise<void>;
}>;

function newestOverview(current: GitlabOverviewValueV1 | null, candidate: GitlabOverviewValueV1): GitlabOverviewValueV1 {
  if (current === null) return candidate;
  const priorRevision = current.observation.kind === 'present' ? current.observation.sourceUpdatedAtMs : undefined;
  const nextRevision = candidate.observation.kind === 'present' ? candidate.observation.sourceUpdatedAtMs : undefined;
  if (priorRevision !== undefined && nextRevision !== undefined && priorRevision !== nextRevision) {
    return nextRevision > priorRevision ? candidate : current;
  }
  return candidate.observedAtMs > current.observedAtMs ? candidate : current;
}

/** Opening and completed writes supply this same read; standalone panels still read on activation. */
export function useGitlabOverview(input: TriageDetailSurfaceInputV1): GitlabOverviewControllerV1 {
  const action = useMemo(() => ({ pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview }), []);
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const routingToken = useGitlabRoutingToken(input);
  const { active, activeSignal } = useTabPanelActivity();
  const seed = useMemo(() => {
    const parsed = GitlabOpeningDetailV1Schema.safeParse(input.detailData);
    return parsed.success && parsed.data.overview.kind === 'overview' ? parsed.data.overview : null;
  }, [input.detailData]);
  // The source revision changes demand; a publication's observation clock does not.
  const version = JSON.stringify([input.observation.sourceUpdatedAtMs, input.observation.nativeRevision]);
  const readFor = useRef<Readonly<{ version: string }> | null>(seed === null ? null : { version });
  const activeRequest = useRef<AbortSignal | null>(null);
  const [state, setState] = useState<Omit<GitlabOverviewControllerV1, 'refresh'>>({
    value: seed, refreshing: false, failure: null,
  });

  useEffect(() => {
    if (seed === null) return;
    if (readFor.current?.version !== version) readFor.current = { version };
    setState(current => {
      const value = newestOverview(current.value, seed);
      return value === current.value ? current : { ...current, value, failure: null };
    });
  }, [seed, version]);

  const read = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (activeRequest.current !== null && !activeRequest.current.aborted) return;
    const demand = { version };
    readFor.current = demand;
    if (routingToken === null) {
      setState(current => ({ ...current, refreshing: false, failure: ROUTE_UNAVAILABLE }));
      return;
    }
    activeRequest.current = signal;
    setState(current => ({ ...current, refreshing: true, failure: null }));
    try {
      const execution = await execute({ v: 1, instance, localRef, routingToken }, { signal }) as ExecuteResult;
      if (signal.aborted) return;
      if (execution.status !== 'success') {
        setState(current => ({ ...current, refreshing: false,
          failure: dispatchFailure(execution, 'gitlab-overview-read-failed') }));
        return;
      }
      const parsed = GitlabOverviewResultV1Schema.safeParse(execution.result);
      if (!parsed.success) {
        setState(current => ({ ...current, refreshing: false, failure: UNREADABLE_RESULT }));
      } else if (parsed.data.kind === 'unavailable') {
        const failure = parsed.data.failure;
        setState(current => ({ ...current, refreshing: false, failure }));
      } else {
        const value = parsed.data;
        setState(current => ({ value: newestOverview(current.value, value), refreshing: false, failure: null }));
      }
    } finally {
      if (activeRequest.current === signal) activeRequest.current = null;
      if (signal.aborted && readFor.current === demand) readFor.current = null;
    }
  }, [execute, instance, localRef, routingToken, version]);

  useEffect(() => {
    if (!active) {
      setState(current => current.refreshing || current.failure !== null
        ? { ...current, refreshing: false, failure: null } : current);
    } else if (readFor.current?.version !== version) {
      void read(activeSignal);
    }
  }, [active, activeSignal, read, version, state.refreshing]);

  const refresh = useCallback(async (): Promise<void> => {
    if (active) await read(activeSignal);
  }, [active, activeSignal, read]);
  return useMemo(() => ({ ...state, refresh }), [refresh, state]);
}
