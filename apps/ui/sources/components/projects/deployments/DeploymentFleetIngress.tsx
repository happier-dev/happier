import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { DeploymentIngressV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { Item } from '@/components/ui/lists/Item';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import { suggestFleetEdgeMachineId } from './fleetIngressSuggestion';

const id = 'project-deployments.environment.settings.servers-build.ingress';
const noop = () => {};
type FleetIngressDraft = Readonly<{ serverId: string; value: DeploymentIngressV1 | undefined;
  onChange: (value: DeploymentIngressV1) => void }>;


/** Author topology intent once; Domain preparation admits the real zone, edge and private network. */
export function DeploymentFleetIngress(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  editing: DeploymentEnvironmentEditing | null;
  draft?: FleetIngressDraft;
  machineName: (machineId: string) => string;
}>) {
  if (props.draft) return <FleetIngressChoice {...props} />;
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
  editing: DeploymentEnvironmentEditing | null;
  draft?: FleetIngressDraft;
  machineName: (machineId: string) => string;
}>) {
  const serverId = props.draft?.serverId ?? props.editing!.serverId;
  const machines = useMachineListForServer(serverId);
  const change = useDeploymentChangePress(props.editing?.review ?? null, props.editing?.onChanged ?? noop);
  const ingress = props.draft ? props.draft.value : props.detail.content.ingress;
  // An edge runs on a Machine with an installation; the tunnel needs none, so it leads the Machine picker.
  const edgeMachines = React.useMemo(() => (machines ?? []).filter(machine => machine.installationId), [machines]);
  const suggestedMachineId = React.useMemo(() => suggestFleetEdgeMachineId(machines ?? [],
    props.detail.runtimeTargetLink?.members?.filter(member => member.state === 'active').map(member => member.machineId) ?? []),
    [machines, props.detail.runtimeTargetLink]);
  const suggested = suggestedMachineId && edgeMachines.some(machine => machine.id === suggestedMachineId) ? suggestedMachineId : null;
  React.useEffect(() => {
    if (props.draft && !props.draft.value && suggested) props.draft.onChange({ kind: 'edgeCaddy', edgeMachineId: suggested });
  }, [props.draft, suggested]);
  const choose = (value: DeploymentIngressV1) => {
    if (change.running) return;
    if (props.draft) { props.draft.onChange(value); return; }
    if (props.editing) void change.press(() => props.editing!.actions.updateEnvironment(props.detail.environment, { ingress: value }));
  };
  // The field holds what is saved; an unsaved suggestion is its placeholder, so choosing it saves it.
  const edgeMachineId = ingress?.kind === 'edgeCaddy' ? ingress.edgeMachineId : null;
  return <>
    <SessionMachineField testID={id} serverId={serverId} machines={edgeMachines} machineId={edgeMachineId}
      {...(edgeMachineId ? { machineName: props.machineName(edgeMachineId) } : {})}
      title={t('projects.deployments.settingsSections.fleetIngressTitle')}
      subtitle={ingress?.kind === 'cloudflareTunnel' ? t('projects.deployments.settingsSections.fleetIngressTunnelBody')
        : ingress?.kind === 'edgeCaddy' ? t('projects.deployments.settingsSections.fleetIngressEdgeBody')
          : t(suggested ? 'projects.deployments.settingsSections.fleetIngressSuggestedBody'
            : 'projects.deployments.settingsSections.fleetIngressUnobserved')}
      placeholder={!ingress && suggested
        ? `${t('projects.deployments.settingsSections.fleetIngressEdge')} · ${props.machineName(suggested)}`
        : t('projects.deployments.settingsSections.fleetIngressChoose')}
      defaultChoice={{
        title: t('projects.deployments.settingsSections.fleetIngressTunnel'),
        selected: ingress?.kind === 'cloudflareTunnel',
        onChoose: () => { if (ingress?.kind !== 'cloudflareTunnel') choose({ kind: 'cloudflareTunnel' }); },
      }}
      awayMachinesChoosable disabled={change.running}
      onSelectMachine={machine => choose({ kind: 'edgeCaddy', edgeMachineId: machine.id })} />
    {change.outcome ? <DeployOutcomeBanner controller={change.banner}
      machine={props.machineName(props.detail.environment.controllerMachineId)} copy="setting" /> : null}
  </>;
}
