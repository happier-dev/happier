import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMachinePoolProjections } from '@/sync/engine/machines/useMachinePoolProjections';
import { invalidateMachinePoolProjection } from '@/sync/engine/machines/machinePoolProjection';
import { t } from '@/text';
import { ManagedFieldRow } from './MachinePresetDetail';

/** Authoring a target never resolves a pool. Acquire alone chooses the exact controller. */
export function ManagedPresetControllerSection(props: Readonly<{
    serverId: string;
    controllerPoolId: string | undefined;
    allowPool: boolean;
    disabled: boolean;
    exactController: React.ReactNode;
    onChange: (poolId: string | undefined) => void;
}>) {
    const pooled = props.controllerPoolId !== undefined;
    return <ItemGroup title={t('managedMachines.config.managedFrom')}
        description={pooled ? t('machinePresets.controllerPoolHelp') : undefined}>
        {props.allowPool ? <SegmentedChoiceItem title={t('machinePresets.controllerTarget')} testIDPrefix="managed-config.controller-target"
            options={[{ id: 'exact', label: t('machinePresets.controllerExact') }, { id: 'pool', label: t('machinePresets.controllerPool') }]}
            value={pooled ? 'pool' : 'exact'} disabled={props.disabled}
            onChange={kind => props.onChange(kind === 'pool' ? '' : undefined)} /> : null}
        {pooled ? <ManagedPresetPoolChoice {...props} value={props.controllerPoolId ?? ''} />
            : props.exactController ? <Item title={t('machinePresets.controllerRow')} mode="info" showChevron={false}
                rightElement={props.exactController} accessoryLayout="adaptive" /> : null}
    </ItemGroup>;
}

function ManagedPresetPoolChoice(props: Readonly<{
    serverId: string; value: string; disabled: boolean; onChange: (poolId: string | undefined) => void;
}>) {
    // The Pool mode is explicit demand for this existing projection; exact targets and delegated
    // creation reviews never mount it, read its roster, or issue a resolve Action.
    const scopes = React.useMemo(() => [{ serverId: props.serverId, machines: [] }], [props.serverId]);
    const projection = useMachinePoolProjections(scopes)[0];
    const available = projection?.pools.filter(row => row.access?.canResolve === true) ?? [];
    const failed = projection?.status === 'error' || projection?.featureStatus === 'error';
    const pending = !projection || !projection.ready && !failed && projection.featureStatus !== 'disabled';
    return <>
        <ManagedFieldRow testID="managed-config.controller-pool" row={{ title: t('machinePresets.controllerPool'),
            value: props.value, choices: available.map(row => ({ id: row.pool.id, title: row.pool.name })),
            disabled: props.disabled || pending || failed || projection?.featureEnabled !== true,
            onChange: props.onChange }} />
        {pending ? <SurfaceStateCard testID="managed-config.controller-pool.loading" kind="loading" size="line" title={t('common.loading')} />
            : failed ? <SurfaceStateCard testID="managed-config.controller-pool.error" kind="error" size="line"
                title={t('machinePools.refreshFailed')} action={{ label: t('common.retry'), onPress: () => {
                    void invalidateMachinePoolProjection(props.serverId, { forceFeatures: true }).catch(() => {});
                } }} />
                : !available.length ? <SurfaceStateCard testID="managed-config.controller-pool.empty" kind="unavailable" size="line"
                    title={t('common.unavailable')} /> : null}
    </>;
}
