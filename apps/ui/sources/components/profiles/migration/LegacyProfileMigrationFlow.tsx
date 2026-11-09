import * as React from 'react';
import type { AIBackendProfile } from '@happier-dev/protocol/profiles/backendProfileSchema';

import { ProviderMachineSelector } from '@/components/settings/providers/ProviderMachineSelector';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { t } from '@/text';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import { LegacyProfileMigrationReview } from './LegacyProfileMigrationReview';
import { useLegacyProfileMigrationTarget } from './useLegacyProfileMigrationTarget';

export const LegacyProfileMigrationFlow = React.memo(function LegacyProfileMigrationFlow(props: Readonly<{
    profile: AIBackendProfile;
    secretBindings: Readonly<Record<string, string>>;
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
                {targetMachines.length > 0 ? <ProviderMachineSelector
                    serverId={serverId}
                    machines={targetMachines}
                    selectedId={null}
                    onSelect={setPreferredMachineId}
                /> : <Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} />}
                <Item title={t('common.cancel')} onPress={props.onClose} />
            </ItemGroup>
        </ItemList>;
    }

    return <>
        {targetMachines.length > 1 ? <ItemGroup title={t('settingsProviders.detail.targetMachine')}>
            <ProviderMachineSelector
                serverId={serverId}
                machines={targetMachines}
                selectedId={machineId}
                onSelect={setPreferredMachineId}
            />
        </ItemGroup> : null}
        <LegacyProfileMigrationReview
            profile={props.profile}
            secretBindings={props.secretBindings}
            machineId={machineId}
            serverId={serverId}
            onConfirmed={rehydrate}
            onClose={props.onClose}
        />
    </>;
});
