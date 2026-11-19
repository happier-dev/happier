import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { buildDeploymentFleetWorkflowDefinition, type DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { DeploymentReceiptDetailV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/contracts/v1';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/store/hooks';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { useDeploymentWorkflow } from './useDeploymentWorkflow';
import { WorkflowStartRefusal } from '@/components/workflows/run/WorkflowStartRefusal';
import { DeploymentFleetIngress } from './DeploymentFleetIngress';
import { DeploymentMachinesEmpty } from './DeploymentMachinesEmpty';
import type { DeploymentIngressV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';

export type DeploymentFleetSheetInput = Readonly<{
    detail: DeploymentEnvironmentReadDetailV1;
    runtimeLink: DeploymentTargetLinkHeaderV1 & { source: { kind: 'host'; id: string } };
    receipt: DeploymentReceiptDetailV1 | null;
    lifetime: ServerAccountScopeLifetime;
}>;

/** Reviewed membership intent; the Workflow owns drain, health and all effects. */
export function DeploymentFleetSheet(props: DeploymentFleetSheetInput & CustomModalInjectedProps) {
    const { detail, runtimeLink, lifetime } = props;
    const router = useRouter();
    const machines = useMachineListForServer(lifetime.scope.serverId) ?? [];
    const workflow = useDeploymentWorkflow(lifetime, detail.environment.projectSourceId, `deployment-fleet:${detail.environment.id}`);
    const [ingress, setIngress] = React.useState<DeploymentIngressV1 | undefined>(() => detail.content.ingress
        ?? (props.receipt?.content.platform === undefined ? props.receipt?.content.ingress : undefined));
    const [destinationId, setDestinationId] = React.useState<string | null>(null);
    const [change, setChange] = React.useState<{ kind: 'add' } | { kind: 'remove'; machineId: string }>({ kind: 'add' });
    const [starting, setStarting] = React.useState(false);
    const destinations = machines.filter((machine): machine is typeof machine & { installationId: string } =>
        Boolean(machine.installationId) && !runtimeLink.machines.includes(machine.id));
    const destination = destinations.find(machine => machine.id === destinationId) ?? null;
    const sourceIntent = props.receipt && props.receipt.content.platform === undefined
        ? props.receipt.content.sourceIntent : undefined;
    const controllerMachineId = detail.environment.controllerMachineId;
    const busy = starting || workflow.pending;
    const ready = Boolean(controllerMachineId) && (change.kind === 'remove'
        || Boolean(destination && (!runtimeLink.activeDeploymentId || sourceIntent)));
    const name = (id: string) => { const machine = machines.find(row => row.id === id);
        return machine ? getMachineDisplayName(machine, machines) : id; };
    const confirm = async () => {
        const reviewedChange = change.kind === 'remove' ? change : destination ? { kind: 'add' as const,
            member: { machineId: destination.id, installationId: destination.installationId },
            ...(sourceIntent ? { sourceIntent } : {}), ...(ingress ? { ingress } : {}) } : null;
        if (busy || !ready || !controllerMachineId || !reviewedChange) return;
        setStarting(true);
        try {
            const accepted = await workflow.run(requestId => buildDeploymentFleetWorkflowDefinition({
                serverId: lifetime.scope.serverId, environment: detail, runtimeLink, requestId,
                change: reviewedChange,
            }), t('projects.deployments.settingsSections.fleet.title'), controllerMachineId);
            if (accepted) { props.onClose();
                router.push(createWorkflowRunRoute(accepted.run.id, lifetime.scope.serverId) as never); }
        } finally { setStarting(false); }
    };
    const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy }}>
        <RoundButton testID="project-deployments.fleet.confirm" size="normal" loading={busy}
            disabled={busy || !ready} title={t(change.kind === 'add'
                ? 'projects.deployments.settingsSections.fleet.add' : 'projects.deployments.settingsSections.fleet.remove')}
            onPress={() => { void confirm(); }} />
    </ModalCardFooterActions>;
    React.useEffect(() => { props.setChrome?.({ kind: 'card', footer }); });
    React.useEffect(() => () => props.setChrome?.(null), [props.setChrome]);
    return <ListPresentationProvider value="page" pageInsets="contained">
        <View testID="project-deployments.fleet" style={deploymentSheetStyles.body}>
            <Text style={deploymentSheetStyles.lead}>{t(change.kind === 'add'
                ? runtimeLink.activeDeploymentId ? 'projects.deployments.settingsSections.fleet.addBody' : 'projects.deployments.settingsSections.fleet.firstAddBody' : 'projects.deployments.settingsSections.fleet.removeBody')}</Text>
            <WorkflowStartRefusal refusal={workflow.refusal} testID="project-deployments.fleet.refused" />
            {change.kind === 'add' && runtimeLink.activeDeploymentId && !sourceIntent ? <SurfaceStateCard
                testID="project-deployments.fleet.sourceUnavailable" size="line" kind="unavailable"
                title={t('projects.deployments.settingsSections.fleet.sourceUnavailable')}
                reason={t('projects.deployments.settingsSections.fleet.sourceUnavailableBody')} /> : null}
            {change.kind === 'add' && destinations.length === 0 ? <DeploymentMachinesEmpty
                serverId={lifetime.scope.serverId} testID="project-deployments.fleet"
                empty={<SurfaceStateCard size="line" kind="empty"
                    title={t('projects.deployments.settingsSections.fleet.noDestination')}
                    reason={t('projects.deployments.settingsSections.fleet.noDestinationBody')} />} /> : null}
            <ItemGroup header="none">
                <Item testID="project-deployments.fleet.add" title={t('projects.deployments.settingsSections.fleet.add')}
                    onPress={() => setChange({ kind: 'add' })} disabled={busy} />
                {change.kind === 'add' ? <SessionMachineField testID="project-deployments.fleet.destination"
                    serverId={lifetime.scope.serverId} machines={destinations} machineId={destinationId}
                    title={t('projects.deployments.machine')} awayMachinesChoosable
                    onSelectMachine={machine => setDestinationId(machine.id)} /> : null}
                {change.kind === 'add' ? <DeploymentFleetIngress detail={detail} editing={null} machineName={name}
                    draft={{ serverId: lifetime.scope.serverId, value: ingress, onChange: setIngress }} /> : null}
                {runtimeLink.members.map(member => <Item key={member.machineId}
                    testID={`project-deployments.fleet.remove.${member.machineId}`} title={name(member.machineId)}
                    subtitle={t(runtimeLink.members.length < 2 ? 'projects.deployments.settingsSections.fleet.lastServer'
                        : 'projects.deployments.settingsSections.fleet.remove')}
                    disabled={busy || runtimeLink.members.length < 2}
                    onPress={() => setChange({ kind: 'remove', machineId: member.machineId })} />)}
            </ItemGroup>
            {change.kind === 'remove' ? <SurfaceStateCard size="line" kind="warning"
                title={name(change.machineId)} reason={t('projects.deployments.settingsSections.fleet.removeBody')} /> : null}
            {props.setChrome ? null : footer}
        </View>
    </ListPresentationProvider>;
}

export function showDeploymentFleetSheet(input: DeploymentFleetSheetInput) {
    showDeploymentSheet({ component: DeploymentFleetSheet, props: input,
        title: t('projects.deployments.settingsSections.fleet.title'), testID: 'project-deployments.fleet.sheet' });
}
