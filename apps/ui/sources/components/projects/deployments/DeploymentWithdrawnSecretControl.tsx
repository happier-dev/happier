import * as React from 'react';
import type { MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { MachineServiceControlOutcomeNotice } from '@/components/machines/services/MachineServiceControlOutcomeNotice';
import { useMachineServiceControl } from '@/components/machines/services/useMachineServiceDetail';
import { machineServiceControls } from '@/components/machines/services/machineServicesPresentation';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

export type DeploymentSecretControlTarget = Readonly<{
    serverId: string;
    environmentId: string;
    machineIds: readonly string[];
    active: boolean;
}>;

/** Withdrawal does not stop a generation. A person can control its exact native service here. */
export function DeploymentWithdrawnSecretControl(props: Readonly<{ target: DeploymentSecretControlTarget }>) {
    return props.target.active ? <>{props.target.machineIds.map(machineId => <MachineControls key={machineId}
        target={props.target} machineId={machineId} />)}</> : null;
}

function MachineControls(props: Readonly<{ target: DeploymentSecretControlTarget; machineId: string }>) {
    const list = useMachineServicesList({ serverId: props.target.serverId, machineId: props.machineId,
        environmentId: props.target.environmentId, active: props.target.active });
    return <>
        {list.rows?.map(service => <ServiceControl key={service.serviceId}
            serverId={props.target.serverId} machineId={props.machineId} service={service} />)}
        {list.error || list.unavailable ? <SurfaceStateCard size="line" kind="unavailable"
            title={t('common.unavailable')} diagnosticCode={list.error?.code ?? list.unavailable ?? undefined}
            action={{ label: t('common.retry'), onPress: () => { void list.refresh(); } }} />
            : list.pending && list.rows === null ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} /> : null}
    </>;
}

function ServiceControl(props: Readonly<{ serverId: string; machineId: string; service: MachineServiceRowV1 }>) {
    const control = useMachineServiceControl(props);
    const offered = machineServiceControls(props.service);
    const operation = offered.start ? 'start' : offered.stop ? 'stop' : null;
    const id = `project-deployments.environment.secret-control.${props.machineId}.${props.service.serviceId}`;
    return <>
        <Item testID={id} title={props.service.name} subtitle={t(`machineServices.state.${props.service.state}`)}
            showChevron={false} rightElement={operation ? <RoundButton size="small" display="secondary"
                testID={`${id}.${operation}`} title={t(`machineServices.control.${operation}`)} accessibilityLabel={t(`machineServices.control.${operation}`)}
                disabled={control.pending !== null} loading={control.pending === operation}
                onPress={() => control.run(operation)} /> : undefined} />
        {control.outcome ? <MachineServiceControlOutcomeNotice outcome={control.outcome}
            service={props.service.name} machine={props.machineId} testID={id + '.outcome'} /> : null}
    </>;
}
