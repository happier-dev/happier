import * as React from 'react';
import { requestSaveFile } from '@/sync/runtime/files/requestSaveFile';
import type { DeploymentReceiptLogFactV1 } from '@happier-dev/deployments';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { LogViewerControlsV1 } from '@happier-dev/forge-ci/ui';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { MachineServiceFirstLogRead } from '@/components/machines/services/useMachineServiceFirstLogRead';
import { useNativeLogViewer } from '@/components/machines/services/useMachineServiceLogViewer';
import type { createDeploymentActions } from './deploymentActions';

export type DeploymentReadLogs = ReturnType<
  typeof createDeploymentActions
>['readLogs'];
export type DeploymentLogReference = DeploymentReceiptLogFactV1['reference'] & Readonly<{ ref?: string }>;
type FollowReference = Extract<
  PluginUiHostReadReferenceV1,
  { hostRead: 'deployments.logs' }
>;

function readError(error: unknown) {
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'action_failed';
  return { code, message: 'deployments.logs.read' };
}

/**
 * One receipt's masked operation or step log (DEP-43). The Action owner reads the latest window, qualified by ref for a step;
 * while the step can still grow, the existing Account Resource follows that same read. Indexing, Find, last-good
 * lines and follow state are the shared native log viewer's. Download walks the finite pages of the same ref.
 */
export function useDeploymentStepLog(
  input: LogViewerControlsV1 &
    Readonly<{
      serverId: string;
      lifetime: ServerAccountScopeLifetime | null;
      reference: DeploymentLogReference | null;
      readLogs: DeploymentReadLogs | null;
      /** The step is still running: its log can grow, so Follow can attach. */
      followable: boolean;
      active: boolean;
      fileName: string;
    }>,
) {
  const { reference, readLogs, serverId } = input;
  const key = reference
    ? JSON.stringify([
        serverId,
        reference.deploymentId,
        reference.machineId,
        reference.installationId,
        reference.ref,
      ])
    : null;
  const [record, setRecord] = React.useState<
    Readonly<{ key: string | null; state: MachineServiceFirstLogRead }>
  >({ key, state: { kind: 'idle' } });
  const generation = React.useRef(0);
  React.useEffect(
    () => () => {
      generation.current += 1;
    },
    [key],
  );
  const read = React.useCallback(async () => {
    if (!reference || !readLogs) return;
    const current = ++generation.current;
    setRecord({ key, state: { kind: 'reading' } });
    let state: MachineServiceFirstLogRead;
    try {
      const result = await readLogs({ ...reference, tail: true });
      state = result.ok
        ? { kind: 'read', value: result.logs, readAt: Date.now() }
        : {
            kind: 'failed',
            error: { code: result.error, message: 'deployments.logs.read' },
          };
    } catch (error) {
      state = { kind: 'failed', error: readError(error) };
    }
    if (current === generation.current) setRecord({ key, state });
  }, [key, reference, readLogs]);
  // A newly selected step is unread in this render, before any reset effect can run.
  const first: MachineServiceFirstLogRead =
    record.key === key ? record.state : { kind: 'idle' };
  const page =
    first.kind === 'read' && first.value.kind === 'page'
      ? first.value.page
      : null;
  const follow = React.useMemo<FollowReference | null>(
    () =>
      page && reference && input.followable
        ? {
            hostRead: 'deployments.logs',
            input: { ...reference, serverId, tail: true },
            sourceRevision: page.sourceRevision,
          }
        : null,
    [page, reference, serverId, input.followable],
  );
  const logs = useNativeLogViewer({
    ...input,
    first,
    read,
    accountLifetime: input.lifetime,
    reference: follow,
    sourceKey: key ?? '',
    active: input.active && reference !== null && readLogs !== null,
    followable: input.followable,
  });
  const latest = React.useRef({
    reference,
    readLogs,
    lifetime: input.lifetime,
    fileName: input.fileName,
  });
  latest.current = { reference, readLogs, lifetime: input.lifetime, fileName: input.fileName };
  /** The file Action owns the complete export; its source ref reuses deployments.logs.read. */
  const download = React.useCallback(async (): Promise<
    'saved' | 'canceled' | 'failed'
  > => {
    const { reference: target, readLogs: readPage, lifetime, fileName } = latest.current;
    if (!target || !readPage || !lifetime?.isCurrent()) return 'canceled';
    return (await requestSaveFile({ fileName, source: {
      kind: 'deploymentLog', reference: { ...target, serverId: lifetime.scope.serverId },
    } }, lifetime.scope)).status;
  }, []);
  return { ...logs, download };
}
