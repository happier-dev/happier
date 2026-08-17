import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { isPetEnabledOverride } from './helpers';
import { PetCompanionSizeSlider } from './PetCompanionSizeSlider';
import type { PetEnabledOverride } from './types';
import { Icon } from '@/components/ui/icons/Icon';

type PetsAccountSettingsSectionProps = Readonly<{
    companionSizeScale: number;
    deviceOverrideOpen: boolean;
    onDeviceOverrideOpenChange: (open: boolean) => void;
    onCompanionSizeScaleChange: (value: number) => void;
    onPetsEnabledChange: (enabled: boolean) => void;
    onPetsEnabledOverrideChange: (override: PetEnabledOverride) => void;
    overrideItems: DropdownMenuItem[];
    petsEnabled: boolean;
    petsEnabledOverride: PetEnabledOverride;
}>;

export function PetsAccountSettingsSection(props: PetsAccountSettingsSectionProps): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <ItemGroup title={t('settingsPets.accountTitle')}>
            <Item
                title={t('settingsPets.enabledTitle')}
                subtitle={t('settingsPets.enabledSubtitle')}
                icon={<Icon name="paw-print" size={24} color={theme.colors.accent.green} />}
                rightElement={(
                    <Switch
                        testID="settings-pets-enabled"
                        value={props.petsEnabled}
                        onValueChange={props.onPetsEnabledChange}
                    />
                )}
                showChevron={false}
            />
            <View testID="settings-pets-device-override">
                <DropdownMenu
                    open={props.deviceOverrideOpen}
                    onOpenChange={props.onDeviceOverrideOpenChange}
                    selectedId={props.petsEnabledOverride}
                    items={props.overrideItems}
                    onSelect={(itemId) => {
                        if (isPetEnabledOverride(itemId)) {
                            props.onPetsEnabledOverrideChange(itemId);
                        }
                    }}
                    itemTrigger={{
                        title: t('settingsPets.deviceOverrideTitle'),
                        subtitle: t('settingsPets.deviceOverrideSubtitle'),
                        icon: <Icon name="cpu" size={24} color={theme.colors.accent.blue} />,
                        itemProps: { showDivider: false },
                    }}
                    rowKind="item"
                />
            </View>
            <PetCompanionSizeSlider
                value={props.companionSizeScale}
                onValueChange={props.onCompanionSizeScaleChange}
            />
        </ItemGroup>
    );
}
