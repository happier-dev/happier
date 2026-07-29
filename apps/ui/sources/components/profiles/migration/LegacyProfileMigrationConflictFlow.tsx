import * as React from 'react';
import type { ProviderSettingsMigrationPendingConflictV1 } from '@happier-dev/protocol';

import { ProviderMachineSelector } from '@/components/settings/providers/ProviderMachineSelector';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { t } from '@/text';

import { LegacyProfileMigrationConflictReview } from './LegacyProfileMigrationConflictReview';
import { useLegacyProfileMigrationTarget } from './useLegacyProfileMigrationTarget';

export const LegacyProfileMigrationConflictFlow = React.memo(function LegacyProfileMigrationConflictFlow(props: Readonly<{
    profileName: string;
    conflict: ProviderSettingsMigrationPendingConflictV1;
    onClose: () => void;
    rehydrateSettings?: (minimumVersion: number) => Promise<void>;
}>) {
    const { machineId, serverId, targetMachines, setPreferredMachineId } = useLegacyProfileMigrationTarget();
    const rehydrate = props.rehydrateSettings ?? (async (minimumVersion: number) => {
        await getSyncSingleton().refreshAccountSettingsFromServer(minimumVersion);
    });

    if (!machineId) {
        return <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup>
                <Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} />
                <Item title={t('common.cancel')} onPress={props.onClose} />
            </ItemGroup>
        </ItemList>;
    }

    return <>
        {targetMachines.length > 1 ? <ItemGroup title={t('settingsProviders.detail.targetMachine')}>
            <ProviderMachineSelector
                machines={targetMachines}
                selectedId={machineId}
                onSelect={setPreferredMachineId}
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
