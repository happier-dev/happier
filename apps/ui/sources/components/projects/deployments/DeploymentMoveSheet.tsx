import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/store/hooks';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { useDeploymentMoveWorkflow } from './useDeploymentMoveWorkflow';

export type DeploymentMoveSheetInput = Readonly<{
    detail: DeploymentEnvironmentDetailV1;
    sourceLink: DeploymentTargetLinkHeaderV1;
    receipt: DeploymentReceiptDetailV1;
    lifetime: ServerAccountScopeLifetime;
}>;

/** Review only; the admitted Workflow owns health, recovery and every effect. */
export function DeploymentMoveSheet(props: DeploymentMoveSheetInput & CustomModalInjectedProps) {
    const { detail, sourceLink, receipt, lifetime } = props;
    const router = useRouter();
    const machines = useMachineListForServer(lifetime.scope.serverId) ?? [];
    const move = useDeploymentMoveWorkflow(lifetime, detail.environment.projectSourceId, detail.environment.id);
    const [sourceId, setSourceId] = React.useState(sourceLink.members[0]?.machineId ?? null);
    const [destinationId, setDestinationId] = React.useState<string | null>(null);
    const [stateless, setStateless] = React.useState(false);
    const [starting, setStarting] = React.useState(false);
    const destinations = machines.filter((machine): machine is typeof machine & { installationId: string } =>
        Boolean(machine.installationId) && !sourceLink.machines.includes(machine.id));
    const members = machines.filter(machine => sourceLink.members.some(member => member.machineId === machine.id));
    const destination = destinations.find(machine => machine.id === destinationId) ?? null;
    const sourceIntent = 'sourceIntent' in receipt.content ? receipt.content.sourceIntent : null;
    const primaryService = sourceIntent?.kind === 'repository' ? sourceIntent.compose?.primaryService : null;
    const controllerMachineId = detail.environment.controllerMachineId;
    const supported = sourceLink.targetKind === 'ownServer' && sourceLink.source.kind === 'host'
        && sourceIntent?.kind === 'repository' && Boolean(primaryService) && Boolean(controllerMachineId);
    const busy = starting || move.pending;
    const confirm = async () => {
        if (busy || !stateless || !sourceId || !destination || sourceLink.source.kind !== 'host'
            || sourceIntent?.kind !== 'repository' || !sourceIntent.compose || !primaryService || !controllerMachineId) return;
        setStarting(true);
        try {
            const accepted = await move.run({ serverId: lifetime.scope.serverId, environment: detail,
                sourceLink: { ...sourceLink, source: sourceLink.source }, sourceDeploymentId: receipt.deployment.id,
                sourceIntent: { ...sourceIntent, compose: sourceIntent.compose }, primaryService, sourceMachineId: sourceId,
                destination: { machineId: destination.id, installationId: destination.installationId },
            }, `${detail.content.name} · ${t('projects.deployments.move.title')}`, controllerMachineId);
            if (accepted) {
                props.onClose();
                router.push(createWorkflowRunRoute(accepted.run.id, lifetime.scope.serverId) as never);
            }
        } finally { setStarting(false); }
    };
    const footer = <ModalCardFooterActions cancel={{ onPress: props.onClose, disabled: busy,
        testID: 'project-deployments.move.cancel' }}>
        <RoundButton testID="project-deployments.move.confirm" size="normal" title={t('projects.deployments.move.run')}
            loading={busy} disabled={busy || !supported || !stateless || !sourceId || !destination}
            onPress={() => { void confirm(); }} />
    </ModalCardFooterActions>;
    React.useEffect(() => { props.setChrome?.({ kind: 'card', footer }); });
    React.useEffect(() => () => props.setChrome?.(null), [props.setChrome]);
    const name = (machineId: string) => {
        const machine = machines.find(candidate => candidate.id === machineId);
        return machine ? getMachineDisplayName(machine, machines) : machineId;
    };
    return <ListPresentationProvider value="page" pageInsets="contained">
        <View testID="project-deployments.move" style={deploymentSheetStyles.body}>
            <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.move.description')}</Text>
            {supported ? <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.move.restriction')}</Text>
                : <SurfaceStateCard testID="project-deployments.move.scope" size="line" kind="unavailable"
                    title={t('projects.deployments.move.restriction')} />}
            {supported ? <ItemGroup header="none">
                {/* The link's own Machines, then the ones it can move to, both in New Session's Machine picker. */}
                <SessionMachineField testID="project-deployments.move.source" serverId={lifetime.scope.serverId}
                    machines={members} machineId={sourceId} machineName={sourceId ? name(sourceId) : null}
                    title={t('projects.deployments.move.source')} awayMachinesChoosable
                    onSelectMachine={machine => setSourceId(machine.id)} />
                <SessionMachineField testID="project-deployments.move.destination" serverId={lifetime.scope.serverId}
                    machines={destinations} machineId={destinationId}
                    title={t('projects.deployments.move.destination')} awayMachinesChoosable
                    onSelectMachine={machine => setDestinationId(machine.id)} />
                <Item testID="project-deployments.move.stateless" title={t('projects.deployments.move.stateless')}
                    disabled={busy} rightElement={<Switch value={stateless} onValueChange={setStateless} disabled={busy} />} />
            </ItemGroup> : null}
            {props.setChrome ? null : footer}
        </View>
    </ListPresentationProvider>;
}

export function showDeploymentMoveSheet(input: DeploymentMoveSheetInput) {
    showDeploymentSheet({ component: DeploymentMoveSheet, props: input,
        title: t('projects.deployments.move.title'), testID: 'project-deployments.move.sheet' });
}
