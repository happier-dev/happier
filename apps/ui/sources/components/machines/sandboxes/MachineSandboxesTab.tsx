import * as React from 'react';
import { View } from 'react-native';
import type { ManagedControllerV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { defineHappierScene } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachinePageState } from '@/components/machines/page/machinePageContext';
import type { MachinePageTabBodyProps } from '@/components/machines/page/machinePageTabQuery';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import { describeManagedCreation } from '@/components/settings/machines/managed/managedCreationPresentation';
import { useHostMachineSandboxes } from '@/components/settings/machines/managed/useHostMachineSandboxes';
import { MANAGED_PROVISIONER_MARK_SIZE, ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t } from '@/text';

/**
 * Machine → Sandboxes (lab machine-sandboxes-1115 scene 4 `host`): the sandboxes this Machine hosts for its work, from
 * the existing managed inventory (`useHostMachineSandboxes`). They are records you open and act on; their detail and
 * actions are the managed Machine's own page. An empty host leads to Isolation, where sandboxes are chosen.
 */
export function MachineSandboxesTab(props: MachinePageTabBodyProps) {
    const { target } = useMachinePageState();
    const machine = target.machine;
    const controller = React.useMemo<ManagedControllerV1 | null>(() => machine?.installationId
        ? { machineId: machine.id, installationId: machine.installationId } : null, [machine?.id, machine?.installationId]);
    const { setParams } = props;
    // Every door opens the one add flow, on the Isolation page, for sessions you start (lab J1 `tab`).
    const openIsolation = React.useCallback(() => setParams({ id: 'security', page: 'isolation', add: 'sessions' }), [setParams]);
    if (!machine) return null;
    return (
        <View testID="machine-sandboxes-tab">
            {controller ? <MachineHostSandboxes serverId={props.serverId} controller={controller} machineName={target.machineSentenceName}
                onOpenIsolation={openIsolation} /> : <MachineSandboxesEmpty machineName={target.machineSentenceName} onOpenIsolation={openIsolation} />}
        </View>
    );
}

function MachineHostSandboxes(props: Readonly<{
    serverId: string; controller: ManagedControllerV1; machineName: string; onOpenIsolation: () => void;
}>) {
    const host = useHostMachineSandboxes({ serverId: props.serverId, controller: props.controller });
    const live = React.useMemo(() => host.sandboxes.filter(sandbox => sandbox.archivedAt === undefined), [host.sandboxes]);
    if (host.firstAnswerPending && live.length === 0) return <SkeletonRows testID="machine-sandboxes-loading" rows={3} />;
    if (live.length === 0) return <MachineSandboxesEmpty machineName={props.machineName} onOpenIsolation={props.onOpenIsolation} />;
    return (
        <>
            <MachineTabSubHead title={null} back={null} description={t('machineDetailPage.isolation.host.count', { count: host.count })} />
            <ItemGroup testID="machine-sandboxes-list">
                {live.map(sandbox => <MachineSandboxRow key={sandbox.id} serverId={props.serverId} sandbox={sandbox} />)}
            </ItemGroup>
        </>
    );
}

function MachineSandboxRow(props: Readonly<{ serverId: string; sandbox: ManagedMachineV1 }>) {
    const router = useRouter();
    const { sandbox } = props;
    const creation = describeManagedCreation(sandbox);
    // A sandbox made for one piece of work goes with it; one kept for reuse stays (plan r3 F5, "Kept").
    const kept = sandbox.creationScopeRetention ? t('machineDetailPage.isolation.host.untilArchived') : t('machineDetailPage.isolation.kept');
    return (
        <Item testID={`machine-sandbox-row-${sandbox.id}`} title={sandbox.launch?.name ?? t('common.machine')}
            icon={<ManagedPresetMark serverId={props.serverId} preset={{ launch: sandbox.launch, controller: sandbox.controller }} size={MANAGED_PROVISIONER_MARK_SIZE.row} />}
            subtitle={kept} detail={creation.word ?? creation.line}
            onPress={() => router.push(`/settings/machines/managed/${encodeURIComponent(sandbox.id)}?serverId=${encodeURIComponent(props.serverId)}` as never)} />
    );
}

/** The named scene for a Machine with no sandboxes yet: the "no machines" composition with a crate (lab J1 `tab`). */
const NO_SANDBOXES_SCENE = defineHappierScene({
    name: 'happier.machines.no-sandboxes', horizon: 'land', moment: 'predawn', planet: 'resting', props: [{ prop: 'crate', x: 104 }],
});

function MachineSandboxesEmpty(props: Readonly<{ machineName: string; onOpenIsolation: () => void }>) {
    return (
        <EmptyState testID="machine-sandboxes-empty" layout="page" scene={NO_SANDBOXES_SCENE}
            title={t('machineDetailPage.isolation.host.emptyTitle')}
            subtitle={t('machineDetailPage.isolation.host.emptyReason', { machine: props.machineName })}
            primaryAction={{ label: t('machineDetailPage.isolation.host.emptyAction'), onPress: props.onOpenIsolation,
                testID: 'machine-sandboxes-empty-add' }} />
    );
}
