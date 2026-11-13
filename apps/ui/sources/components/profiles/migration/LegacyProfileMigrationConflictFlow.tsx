import * as React from 'react';
import type { ProviderSettingsMigrationPendingConflictV1 } from '@happier-dev/protocol/providers/settings/v1';

import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { t } from '@/text';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import { LegacyProfileMigrationConflictReview } from './LegacyProfileMigrationConflictReview';
import { useLegacyProfileMigrationTarget } from './useLegacyProfileMigrationTarget';

export const LegacyProfileMigrationConflictFlow = React.memo(function LegacyProfileMigrationConflictFlow(props: Readonly<{
    profileName: string;
    conflict: ProviderSettingsMigrationPendingConflictV1;
    onClose: () => void;
    rehydrateSettings?: (minimumVersion: number) => Promise<void>;
}>) {
    const { machineId, serverId, targetMachines, setPreferredMachineId } = useLegacyProfileMigrationTarget();
    const expectedSettingsScope = useAccountSettingsScope();
    const rehydrate = props.rehydrateSettings ?? (async (minimumVersion: number) => {
        await getSyncSingleton().refreshAccountSettingsFromServer(minimumVersion, expectedSettingsScope);
    });

    if (!machineId) {
        return <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup>
                {targetMachines.length > 0 ? <SessionMachineField
                    serverId={serverId ?? ''}
                    machines={targetMachines}
                    machineId={null}
                    title={t('settingsProviders.detail.targetMachine')}
                    onSelectMachine={(machine) => setPreferredMachineId(machine.id)}
                /> : <Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} />}
                <Item title={t('common.cancel')} onPress={props.onClose} />
            </ItemGroup>
        </ItemList>;
    }

    return <>
        {targetMachines.length > 1 ? <ItemGroup>
            <SessionMachineField
                serverId={serverId ?? ''}
                machines={targetMachines}
                machineId={machineId}
                title={t('settingsProviders.detail.targetMachine')}
                onSelectMachine={(machine) => setPreferredMachineId(machine.id)}
            />
        </ItemGroup> : null}
        <LegacyProfileMigrationConflictReview
            profileName={props.profileName}
            conflict={props.conflict}
            machineId={machineId}
            serverId={serverId}
            onConfirmed={rehydrate}
            onClose={props.onClose}
        />
    </>;
});
