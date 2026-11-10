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
import { createDeploymentReadTransport, type DeploymentTargetLinkChoiceV1 } from './deploymentReadTransport';
import { buildPreviewBranchReadInput, previewBranchTargets, readPreviewBranchParents,
  type PreviewBranchTarget, type PreviewBranchParent } from './previewDatabaseBranches';

type Template = NonNullable<DeploymentEnvironmentReadDetailV1['content']['previewTemplate']>;
type ReadState = Readonly<{ kind: 'loading'; targetLinkId: string }>
  | Readonly<{ kind: 'failed'; targetLinkId: string; code: string }>
  | Readonly<{ kind: 'ready'; targetLinkId: string; parent: PreviewBranchParent }>;
type TargetChoices = Readonly<{ scope: object; rows: readonly DeploymentTargetLinkChoiceV1[] }>
  & (Readonly<{ kind: 'loading' | 'ready' }> | Readonly<{ kind: 'failed'; code: string }>);

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
  const candidates = React.useMemo(() => state.status === 'ready'
    ? previewBranchTargets(state.declarations, props.detail) : [], [state, props.detail]);
  const transport = React.useMemo(() => createDeploymentReadTransport(props.lifetime), [props.lifetime]);
  const [open, setOpen] = React.useState(false);
  const selected = props.detail.content.previewTemplate?.data.find(entry => entry.kind === 'managed');
  const selectedLinkId = selected?.kind === 'managed' ? selected.dataTargetLinkId : null;
  const choiceScope = React.useMemo(() => ({}), [props.lifetime, props.detail.environment.id]);
  const [choiceState, setChoices] = React.useState<TargetChoices | null>(null);
  const choices = choiceState?.scope === choiceScope ? choiceState : null;
  const wanted = React.useMemo(() => open ? candidates : candidates.filter(row => row.targetLink.id === selectedLinkId),
    [open, candidates, selectedLinkId]);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (state.status !== 'ready') return;
    const controller = new AbortController();
    setChoices(previous => ({ scope: choiceScope, kind: wanted.length === 0 ? 'ready' : 'loading',
      rows: previous?.scope === choiceScope ? previous.rows : [] }));
    if (wanted.length === 0) return () => controller.abort();
    void transport.readTargetLinks(props.lifetime.scope, wanted.map(row => row.targetLink), { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setChoices(previous => result.ok ? { scope: choiceScope, kind: 'ready', rows: result.value }
          : { scope: choiceScope, kind: 'failed', code: result.failure.code,
            rows: previous?.scope === choiceScope ? previous.rows : [] });
      });
    return () => controller.abort();
  }, [state.status, wanted, transport, props.lifetime, choiceScope, attempt]);
  const openedById = new Map(choices?.rows.map(row => [row.targetLink.id, row]));
  const targets = candidates.map(candidate => {
    const opened = openedById.get(candidate.targetLink.id);
    return opened ? { ...candidate, ...opened, title: opened.title || candidate.title } : candidate;
  });
  const [read, setRead] = React.useState<ReadState | null>(null);
  const flight = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => flight.current?.abort(), []);
  const selectedId = read?.targetLinkId ?? (selected?.kind === 'managed' ? selected.dataTargetLinkId : null);
  const readBranches = async (target: PreviewBranchTarget) => {
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    const targetLinkId = target.targetLink.id;
    const input = buildPreviewBranchReadInput(props.detail, target);
    if (!input) { setRead({ kind: 'failed', targetLinkId, code: 'credential_unavailable' }); return; }
    setRead({ kind: 'loading', targetLinkId });
    let cursor: string | undefined;
    do {
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
      if (parent) {
        setRead({ kind: 'ready', targetLinkId, parent });
        props.onSave([{ kind: 'managed', dataTargetLinkId: targetLinkId, ownership: 'providerNative', parentBranchRef: parent.parentBranchRef }]);
        return;
      }
      cursor = isRecord(result.value) && typeof result.value.nextCursor === 'string' ? result.value.nextCursor : undefined;
    } while (cursor);
    setRead({ kind: 'failed', targetLinkId, code: 'deployment_unavailable' });
  };
  const target = targets.find(entry => entry.targetLink.id === selectedId);
  const failureCode = state.status === 'failed' ? state.code : choices?.kind === 'failed' ? choices.code : read?.kind === 'failed' ? read.code : null;
  const loading = state.status === 'loading' || choices?.kind === 'loading' || read?.kind === 'loading';
  return <>
    <DropdownMenu testID={`${props.testID}.parent`} open={open} onOpenChange={setOpen}
      items={targets.map(entry => ({ id: entry.targetLink.id, title: entry.title, disabled: loading }))}
      selectedId={selectedId} onSelect={(id) => { setOpen(false); const entry = targets.find(value => value.targetLink.id === id);
        if (entry) void readBranches(entry); }}
      // The row says what the choice does; the field holds the parent, and reads in place so nothing moves while it loads.
      itemTrigger={{ title: t('projects.deployments.settingsSections.previewsDataParent'),
        subtitle: t('projects.deployments.settingsSections.previewsDataParentBody'), showSelectedSubtitle: false,
        detailFormatter: () => loading ? t('common.loading')
          : read?.kind === 'ready' ? `${target?.title ?? ''} · ${read.parent.title}`
            : target && selected?.kind === 'managed' && selected.dataTargetLinkId === target.targetLink.id && selected.parentBranchRef.displayName
              ? `${target.title} · ${selected.parentBranchRef.displayName}` : target?.title ?? null,
        itemProps: { accessoryLayout: 'adaptive', disabled: props.saving || state.status !== 'ready' || loading } }} />
    {failureCode ? (
      <SurfaceStateCard testID={`${props.testID}.failed`} size="line" kind="error"
        title={t('projects.deployments.platformLink.refused')}
        reason={readDeploymentFailureRecoveryV1(failureCode).remedy}
        diagnosticCode={failureCode}
        action={{ label: t('common.retry'), onPress: () => {
          if (state.status === 'failed') retry();
          else if (choices?.kind === 'failed') setAttempt(value => value + 1);
          else if (target) void readBranches(target);
        } }} />
    ) : state.status === 'ready' && choices?.kind === 'ready' && targets.length === 0 ? (
      <Item testID={`${props.testID}.empty`} title={t('projects.deployments.settingsSections.previewsDataUnavailable')} mode="info" />
    ) : null}
  </>;
}
