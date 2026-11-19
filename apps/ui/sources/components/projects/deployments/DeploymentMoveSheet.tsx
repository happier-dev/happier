import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol';
import { resolveStatelessDeploymentMoveSourceV1 } from '@happier-dev/deployments';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineListForServer } from '@/sync/store/hooks';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { useDeploymentMoveWorkflow } from './useDeploymentMoveWorkflow';

type MoveSource = NonNullable<ReturnType<typeof resolveStatelessDeploymentMoveSourceV1>>;
type EligibleMove = Readonly<{
    kind: 'ready';
    sourceLink: DeploymentTargetLinkHeaderV1 & { source: Extract<DeploymentTargetLinkHeaderV1['source'], { kind: 'host' }> };
    source: MoveSource;
    sourceDeploymentId: string;
    lifetime: ServerAccountScopeLifetime;
    controllerMachineId: string;
}>;

export type DeploymentMoveEligibility = EligibleMove | Readonly<{
    kind: 'unavailable';
    reason: 'needsAccount' | 'permission' | 'needsRepository' | 'requiresOwnServer' | 'needsServingDeployment' | 'needsServiceManifest' | 'needsController';
}>;

/** The Environment menu and the Move review share one decision and the same captured serving source. */
export function readDeploymentMoveEligibility(
    detail: DeploymentEnvironmentDetailV1,
    sourceLink: DeploymentTargetLinkHeaderV1 | null,
    receipt: DeploymentReceiptDetailV1 | null,
    lifetime: ServerAccountScopeLifetime | null,
): DeploymentMoveEligibility {
    if (!lifetime) return { kind: 'unavailable', reason: 'needsAccount' };
    const { manageTargets, manageBindings, deploy } = detail.environment.capabilities;
    if (!manageTargets || !manageBindings || !deploy) return { kind: 'unavailable', reason: 'permission' };
    if (detail.content.definition.kind !== 'repository') return { kind: 'unavailable', reason: 'needsRepository' };
    if (sourceLink?.targetKind !== 'ownServer' || sourceLink.source.kind !== 'host') {
        return { kind: 'unavailable', reason: 'requiresOwnServer' };
    }
    if (!receipt || receipt.content.sourceIntent.kind !== 'repository') {
        return { kind: 'unavailable', reason: 'needsServingDeployment' };
    }
    const source = resolveStatelessDeploymentMoveSourceV1(receipt);
    if (!source) return { kind: 'unavailable', reason: 'needsServiceManifest' };
    const controllerMachineId = detail.environment.controllerMachineId;
    if (!controllerMachineId) return { kind: 'unavailable', reason: 'needsController' };
    return { kind: 'ready', source, sourceLink: { ...sourceLink, source: sourceLink.source },
        sourceDeploymentId: receipt.deployment.id, controllerMachineId, lifetime };
}

export type DeploymentMoveSheetInput = Readonly<{
    detail: DeploymentEnvironmentDetailV1;
    move: EligibleMove;
}>;

/** Review only; the admitted Workflow owns health, recovery and every effect. */
export function DeploymentMoveSheet(props: DeploymentMoveSheetInput & CustomModalInjectedProps) {
    const { detail } = props;
    const { sourceLink, source, sourceDeploymentId, controllerMachineId, lifetime } = props.move;
    const router = useRouter();
    const machines = useMachineListForServer(lifetime.scope.serverId) ?? [];
    const move = useDeploymentMoveWorkflow(lifetime, detail.environment.projectSourceId, detail.environment.id);
    const [sourceId, setSourceId] = React.useState(sourceLink.members[0]?.machineId ?? null);
    const [destinationId, setDestinationId] = React.useState<string | null>(null);
    const [stateless, setStateless] = React.useState(false);
    const [starting, setStarting] = React.useState(false);
    const [primaryService, setPrimaryService] = React.useState(source.primaryService);
    const [serviceMenuOpen, setServiceMenuOpen] = React.useState(false);
    const destinations = machines.filter((machine): machine is typeof machine & { installationId: string } =>
        Boolean(machine.installationId) && !sourceLink.machines.includes(machine.id));
    const members = machines.filter(machine => sourceLink.members.some(member => member.machineId === machine.id));
    const destination = destinations.find(machine => machine.id === destinationId) ?? null;
    const busy = starting || move.pending;
    const confirm = async () => {
        if (busy || !stateless || !sourceId || !destination || !primaryService) return;
        setStarting(true);
        try {
            const accepted = await move.run({ serverId: lifetime.scope.serverId, environment: detail,
                sourceLink, sourceDeploymentId, sourceIntent: source.sourceIntent, primaryService, sourceMachineId: sourceId,
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
            loading={busy} disabled={busy || !primaryService || !stateless || !sourceId || !destination}
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
            <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.move.restriction')}</Text>
            <ItemGroup header="none">
                {source.services.length > 1 ? <DropdownMenu
                    testID="project-deployments.move.service" open={serviceMenuOpen} onOpenChange={setServiceMenuOpen}
                    items={source.services.map(service => ({ id: service, title: service }))}
                    selectedId={primaryService ?? undefined} onSelect={setPrimaryService}
                    itemTrigger={{ title: t('projects.setup.service'), itemProps: { disabled: busy } }} /> : null}
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
            </ItemGroup>
            {props.setChrome ? null : footer}
        </View>
    </ListPresentationProvider>;
}

export function showDeploymentMoveSheet(input: DeploymentMoveSheetInput) {
    showDeploymentSheet({ component: DeploymentMoveSheet, props: input,
        title: t('projects.deployments.move.title'), testID: 'project-deployments.move.sheet' });
}
