import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import type { createDeploymentActions } from './deploymentActions';
import { useDeploymentTargetDeclarations } from './DeploymentPlatformTargetSheet';
import { buildPreviewBranchReadInput, previewBranchTargets, readPreviewBranchParents,
  type PreviewBranchTarget, type PreviewBranchParent } from './previewDatabaseBranches';

type Template = NonNullable<DeploymentEnvironmentReadDetailV1['content']['previewTemplate']>;
type ReadState = Readonly<{ kind: 'loading'; targetLinkId: string }>
  | Readonly<{ kind: 'failed'; targetLinkId: string; code: string }>
  | Readonly<{ kind: 'page'; targetLinkId: string; cursor: string }>
  | Readonly<{ kind: 'ready'; targetLinkId: string; parent: PreviewBranchParent }>;

/** Choosing a linked parent records intent only. PR creation owns the later branch mutation. */
export function DeploymentPreviewBranchChoice(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  lifetime: ServerAccountScopeLifetime;
  inspect: ReturnType<typeof createDeploymentActions>['inspectPlatformTarget'];
  saving: boolean;
  onSave: (data: Template['data']) => void;
  testID: string;
}>) {
  const { state, retry } = useDeploymentTargetDeclarations(props.lifetime);
  const targets = state.status === 'ready' ? previewBranchTargets(state.declarations, props.detail) : [];
  const [open, setOpen] = React.useState(false);
  const [read, setRead] = React.useState<ReadState | null>(null);
  const flight = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => flight.current?.abort(), []);
  const selected = props.detail.content.previewTemplate?.data.find(entry => entry.kind === 'managed');
  const selectedId = read?.targetLinkId ?? (selected?.kind === 'managed' ? selected.dataTargetLinkId : null);
  const readBranches = async (target: PreviewBranchTarget, cursor?: string) => {
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    const targetLinkId = target.targetLink.id;
    const input = buildPreviewBranchReadInput(props.detail, target);
    if (!input) { setRead({ kind: 'failed', targetLinkId, code: 'credential_unavailable' }); return; }
    setRead({ kind: 'loading', targetLinkId });
    let result: Awaited<ReturnType<typeof props.inspect>>;
    try {
      result = await props.inspect(target.actionId, { ...input, ...(cursor ? { cursor } : {}) }, {
        signal: controller.signal,
        externalActionTarget: { kind: 'machine', machineId: props.detail.environment.controllerMachineId },
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown_error';
      setRead({ kind: 'failed', targetLinkId, code });
      return;
    }
    if (controller.signal.aborted) return;
    if (!result.ok) { setRead({ kind: 'failed', targetLinkId, code: result.code }); return; }
    const parent = readPreviewBranchParents(result.value, input.providerIdentity)[0];
    if (!parent) {
      const nextCursor = isRecord(result.value) && typeof result.value.nextCursor === 'string' ? result.value.nextCursor : null;
      setRead(nextCursor ? { kind: 'page', targetLinkId, cursor: nextCursor }
        : { kind: 'failed', targetLinkId, code: 'deployment_unavailable' });
      return;
    }
    setRead({ kind: 'ready', targetLinkId, parent });
    props.onSave([{ kind: 'managed', dataTargetLinkId: targetLinkId, ownership: 'providerNative', parentBranchRef: parent.parentBranchRef }]);
  };
  const target = targets.find(entry => entry.targetLink.id === selectedId);
  const failureCode = state.status === 'failed' ? state.code : read?.kind === 'failed' ? read.code : null;
  return <>
    <DropdownMenu testID={`${props.testID}.parent`} open={open} onOpenChange={setOpen}
      items={targets.map(entry => ({ id: entry.targetLink.id,
        title: entry.title, subtitle: entry.content.providerIdentity
          ? `${entry.content.providerIdentity.providerResourceId} · ${entry.content.providerIdentity.providerEnvironment}` : undefined }))}
      selectedId={selectedId} onSelect={(id) => { setOpen(false); const entry = targets.find(value => value.targetLink.id === id);
        if (entry) void readBranches(entry); }}
      itemTrigger={{ title: t('projects.deployments.settingsSections.previewsDataBranch'),
        itemProps: { accessoryLayout: 'adaptive', disabled: props.saving || state.status !== 'ready' || read?.kind === 'loading',
          detail: read?.kind === 'ready' ? `${target?.title ?? ''} · ${read.parent.title}` : target?.title } }} />
    {state.status === 'loading' || read?.kind === 'loading' ? (
      <SurfaceStateCard testID={`${props.testID}.loading`} size="line" kind="loading" title={t('common.loading')} />
    ) : failureCode ? (
      <SurfaceStateCard testID={`${props.testID}.failed`} size="line" kind="error"
        title={t('projects.deployments.platformLink.refused')}
        reason={readDeploymentFailureRecoveryV1(failureCode).remedy}
        diagnosticCode={failureCode}
        action={{ label: t('common.retry'), onPress: () => { if (state.status === 'failed') retry(); else if (target) void readBranches(target); } }} />
    ) : read?.kind === 'page' ? (
      <SurfaceStateCard testID={`${props.testID}.next`} size="line" kind="unavailable"
        title={t('projects.deployments.settingsSections.previewsDataBranch')}
        action={{ label: t('common.next'), onPress: () => { if (target) void readBranches(target, read.cursor); } }} />
    ) : state.status === 'ready' && targets.length === 0 ? (
      <Item testID={`${props.testID}.empty`} title={t('projects.deployments.settingsSections.previewsDataUnavailable')} mode="info" />
    ) : null}
  </>;
}
