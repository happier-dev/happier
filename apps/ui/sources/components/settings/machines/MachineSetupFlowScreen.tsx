import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';

export const MachineSetupFlowScreen = React.memo(function MachineSetupFlowScreen() {
    const { theme } = useUnistyles();
    const openComingSoon = React.useCallback(() => {
        Modal.alert(t('settings.addMachine'), t('settings.machineSetupComingSoon'));
    }, []);

    return (
        <ItemList>
            <ItemGroup title={t('settings.addMachine')}>
                <Item
                    title={t('settings.machineSetupCurrentMachineTitle')}
                    subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                    icon={<Ionicons name="laptop-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={openComingSoon}
                />
                <Item
                    title={t('settings.machineSetupSshMachineTitle')}
                    subtitle={t('settings.machineSetupSshMachineSubtitle')}
                    icon={<Ionicons name="server-outline" size={29} color={theme.colors.accent.orange} />}
                    onPress={openComingSoon}
                />
            </ItemGroup>
            <ItemGroup title={t('settings.machineSetupStagesTitle')}>
                <Item
                    title={t('settings.machineSetupStageConnect')}
                    icon={<Ionicons name="link-outline" size={29} color={theme.colors.accent.blue} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settings.machineSetupStageInstall')}
                    icon={<Ionicons name="download-outline" size={29} color={theme.colors.accent.orange} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settings.machineSetupStageFinish')}
                    icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.accent.indigo} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>
        </ItemList>
    );
});
