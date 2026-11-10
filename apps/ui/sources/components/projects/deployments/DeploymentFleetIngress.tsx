import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { DeploymentIngressV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import { suggestFleetEdgeMachineId } from './fleetIngressSuggestion';

const id = 'project-deployments.environment.settings.servers-build.ingress';

/** Author topology intent once; Domain preparation admits the real zone, edge and private network. */
export function DeploymentFleetIngress(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  editing: DeploymentEnvironmentEditing | null;
  machineName: (machineId: string) => string;
}>) {
  if (props.detail.runtimeTargetLink?.targetKind !== 'ownServer'
    || props.detail.runtimeTargetLink.machines.length < 2) return null;
  if (props.editing) return <FleetIngressChoice {...props} editing={props.editing} />;
  const ingress = props.detail.content.ingress;
  return <Item testID={id} title={t('projects.deployments.settingsSections.fleetIngressTitle')}
    subtitle={ingress?.kind === 'cloudflareTunnel' ? t('projects.deployments.settingsSections.fleetIngressTunnelBody')
      : ingress?.kind === 'edgeCaddy' ? t('projects.deployments.settingsSections.fleetIngressEdgeBody')
        : t('projects.deployments.settingsSections.fleetIngressUnobserved')}
    detail={ingress?.kind === 'cloudflareTunnel' ? t('projects.deployments.settingsSections.fleetIngressTunnel')
      : ingress ? `${t('projects.deployments.settingsSections.fleetIngressEdge')} · ${props.machineName(ingress.edgeMachineId)}` : undefined}
    mode="info" />;
}

function FleetIngressChoice(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  editing: DeploymentEnvironmentEditing;
  machineName: (machineId: string) => string;
}>) {
  const machines = useMachineListForServer(props.editing.serverId);
  const [open, setOpen] = React.useState(false);
  const change = useDeploymentChangePress(props.editing.review, props.editing.onChanged);
  const ingress = props.detail.content.ingress;
  const choices = React.useMemo(() => [
    { id: 'tunnel', title: t('projects.deployments.settingsSections.fleetIngressTunnel'),
      value: { kind: 'cloudflareTunnel' } satisfies DeploymentIngressV1 },
    ...(machines ?? []).filter(machine => machine.installationId).map(machine => ({
      id: `edge:${machine.id}`,
      title: `${t('projects.deployments.settingsSections.fleetIngressEdge')} · ${getMachineDisplayName(machine, machines ?? [])}`,
      value: { kind: 'edgeCaddy', edgeMachineId: machine.id } satisfies DeploymentIngressV1,
    })),
  ], [machines]);
  const suggestedMachineId = React.useMemo(() => suggestFleetEdgeMachineId(machines ?? [],
    props.detail.runtimeTargetLink?.members?.filter(member => member.state === 'active').map(member => member.machineId) ?? []),
    [machines, props.detail.runtimeTargetLink]);
  const suggested = choices.find(choice => choice.id === `edge:${suggestedMachineId}`);
  const savedId = ingress?.kind === 'cloudflareTunnel' ? 'tunnel'
    : ingress?.kind === 'edgeCaddy' ? `edge:${ingress.edgeMachineId}` : null;
  const selectedId = savedId ?? suggested?.id ?? null;
  const items: DropdownMenuItem[] = choices.map(choice => ({ id: choice.id, title: choice.title,
    checked: choice.id === selectedId }));
  const current = ingress?.kind === 'cloudflareTunnel' ? t('projects.deployments.settingsSections.fleetIngressTunnel')
    : ingress ? `${t('projects.deployments.settingsSections.fleetIngressEdge')} · ${props.machineName(ingress.edgeMachineId)}`
      : suggested?.title ?? t('projects.deployments.settingsSections.fleetIngressChoose');
  return <>
    <DropdownMenu testID={id} open={open} onOpenChange={setOpen} items={items} selectedId={selectedId}
      onSelect={choiceId => {
        setOpen(false);
        const choice = choices.find(choice => choice.id === choiceId);
        if (!choice || change.running || choiceId === savedId) return;
        void change.press(() => props.editing.actions.updateEnvironment(props.detail.environment, { ingress: choice.value }));
      }} itemTrigger={{ title: t('projects.deployments.settingsSections.fleetIngressTitle'),
        subtitle: ingress?.kind === 'cloudflareTunnel' ? t('projects.deployments.settingsSections.fleetIngressTunnelBody')
          : ingress?.kind === 'edgeCaddy' ? t('projects.deployments.settingsSections.fleetIngressEdgeBody')
            : t(suggested ? 'projects.deployments.settingsSections.fleetIngressSuggestedBody'
              : 'projects.deployments.settingsSections.fleetIngressUnobserved'),
        detailFormatter: () => current, itemProps: { disabled: change.running, accessoryLayout: 'stacked' } }} />
    {change.outcome ? <DeployOutcomeBanner outcome={change.outcome}
      pending={change.outcome.kind === 'approval' && props.editing.review.pendingId === change.outcome.artifactId}
      machine={props.machineName(props.detail.environment.controllerMachineId)} onOpenReview={props.editing.review.open} copy="setting" /> : null}
  </>;
}
