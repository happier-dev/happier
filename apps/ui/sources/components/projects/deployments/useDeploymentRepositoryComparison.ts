import * as React from 'react';
import type { DeploymentEnvironmentDefinitionV1, DeploymentSourceIntentV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentReadDemandV1 } from '@happier-dev/deployments';
import type { ScmLogListResponse, ScmRevisionRangeV1 } from '@happier-dev/protocol/scm';
import { machineScmLogList } from '@/sync/ops/scm/machineScm';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

export type DeploymentRepositoryComparisonInput = Readonly<{
  source: Extract<DeploymentSourceIntentV1, { kind: 'repository' }>;
  current: DeploymentEnvironmentDefinitionV1 | null;
  workspaceRef?: WorkspaceRefV1 | null;
  serverId: string;
  accountId: string;
  demand: DeploymentReadDemandV1;
}>;

export type DeploymentRepositoryComparisonState = Readonly<{
  comparison: Readonly<{ range: ScmRevisionRangeV1; history: ScmLogListResponse }> | null;
  history: ScmLogListResponse['revisionRange'] | null | undefined;
  proven: boolean;
  pending: boolean;
  unavailable: boolean;
  /** The checkout's Machine could not be read (it isn't answering, or the read failed), as distinct from history that doesn't match. */
  unreadable: boolean;
  newerCommitCount: number | null;
  newerCommitWaiting: boolean;
  refresh: () => void;
}>;

/** One demanded SCM read pins both endpoints for the Environment's count and Compare. */
export function useDeploymentRepositoryComparison(props: DeploymentRepositoryComparisonInput): DeploymentRepositoryComparisonState {
  const [refresh, setRefresh] = React.useState(0);
  const [response, setResponse] = React.useState<Readonly<{ requestIdentity: string; value: NonNullable<DeploymentRepositoryComparisonState['comparison']> }> | null>(null);
  const [pending, setPending] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);
  const [unreadable, setUnreadable] = React.useState(false);
  const workspace = props.workspaceRef;
  const machineId = workspace?.machineId;
  const rootPath = workspace?.rootPath;
  const sourceRef = props.current?.kind === 'repository' ? props.current.ref : null;
  const requestIdentity = machineId && rootPath && sourceRef
    ? JSON.stringify([props.serverId, props.accountId, props.source.projectSourceId, props.source.sourceRevision,
      workspace?.id, workspace?.source?.sourceId, workspace?.source?.revision, machineId, rootPath, props.source.sha, sourceRef]) : null;
  const comparison = response?.requestIdentity === requestIdentity ? response.value : null;
  React.useEffect(() => {
    if (!machineId || !rootPath || !sourceRef || requestIdentity === null) {
      setResponse(null);
      setPending(false);
      setUnavailable(false);
      setUnreadable(false);
      return;
    }
    if (!props.demand.mounted || !props.demand.visible) return;
    const abort = new AbortController();
    const options = { serverId: props.serverId, accountId: props.accountId, signal: abort.signal };
    setPending(true);
    setResponse(null);
    void (async () => {
      try {
        const history = await machineScmLogList(machineId, { cwd: rootPath,
          revisionRangeFromRef: { baseOid: props.source.sha, headRef: sourceRef } }, options);
        if (abort.signal.aborted) return;
        if (!history.success) { setUnavailable(true); setUnreadable(true); return; }
        setUnreadable(false);
        const echoed = history.revisionRange;
        if (!echoed || echoed.baseOid !== props.source.sha || echoed.headRef !== sourceRef) { setUnavailable(true); return; }
        const range: ScmRevisionRangeV1 = { kind: 'revisionRange', baseOid: echoed.baseOid, headOid: echoed.headOid };
        setResponse({ requestIdentity, value: { range, history } });
        setUnavailable(false);
      } catch {
        if (!abort.signal.aborted) { setUnavailable(true); setUnreadable(true); }
      } finally {
        if (!abort.signal.aborted) setPending(false);
      }
    })();
    return () => abort.abort();
  }, [machineId, rootPath, sourceRef, props.source.sha, props.serverId, props.accountId, props.demand.mounted, props.demand.visible, requestIdentity, refresh]);
  const history = comparison?.history.success ? comparison.history.revisionRange : null;
  const proven = history?.historyComplete === true;
  const newerCommitCount = proven && history.graphRelation === 'equal' ? 0
    : proven && history.graphRelation === 'forward' ? history.totalCount ?? null : null;
  const newerCommitWaiting = newerCommitCount !== null && newerCommitCount > 0;
  const refreshComparison = React.useCallback(() => setRefresh(value => value + 1), []);
  return { comparison, history, proven, pending, unavailable, unreadable, newerCommitCount, newerCommitWaiting, refresh: refreshComparison };
}
