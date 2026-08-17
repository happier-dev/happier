import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

import {
    isDesktopPetOverlayVisibilityModeOverride,
    isPetEnabledOverride,
} from './helpers';
import type {
    DesktopPetOverlayVisibilityModeOverride,
    PetEnabledOverride,
} from './types';

type PetsDesktopOverlaySettingsSectionProps = Readonly<{
    desktopOverlayDefaultEnabled: boolean;
    desktopOverlayOverrideOpen: boolean;
    desktopOverlayVisibilityModeOpen: boolean;
    desktopPetOverlayEnabledOverride: PetEnabledOverride;
    desktopPetOverlayVisibilityModeOverride: DesktopPetOverlayVisibilityModeOverride;
    onDefaultEnabledChange: (enabled: boolean) => void;
    onDesktopOverlayOverrideChange: (override: PetEnabledOverride) => void;
    onDesktopOverlayOverrideOpenChange: (open: boolean) => void;
    onDesktopOverlayVisibilityModeOverrideChange: (override: DesktopPetOverlayVisibilityModeOverride) => void;
    onDesktopOverlayVisibilityModeOpenChange: (open: boolean) => void;
    onResetPosition: () => void;
    overrideItems: DropdownMenuItem[];
    visibilityModeItems: DropdownMenuItem[];
}>;

export function PetsDesktopOverlaySettingsSection(props: PetsDesktopOverlaySettingsSectionProps): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <ItemGroup title={t('settingsPets.desktopOverlayTitle')}>
            <Item
                testID="settings-pets-desktop-overlay-enabled"
                title={t('settingsPets.desktopOverlayEnabledTitle')}
                subtitle={t('settingsPets.desktopOverlayEnabledSubtitle')}
                icon={<Icon name="desktop" size={24} color={theme.colors.accent.blue} />}
                rightElement={(
                    <Switch
                        value={props.desktopOverlayDefaultEnabled}
                        onValueChange={props.onDefaultEnabledChange}
                    />
                )}
                showChevron={false}
            />
            <View testID="settings-pets-desktop-overlay-device-override">
                <DropdownMenu
                    open={props.desktopOverlayOverrideOpen}
                    onOpenChange={props.onDesktopOverlayOverrideOpenChange}
                    selectedId={props.desktopPetOverlayEnabledOverride}
                    items={props.overrideItems}
                    onSelect={(itemId) => {
                        if (isPetEnabledOverride(itemId)) {
                            props.onDesktopOverlayOverrideChange(itemId);
                        }
                    }}
                    itemTrigger={{
                        title: t('settingsPets.desktopOverlayDeviceOverrideTitle'),
                        subtitle: t('settingsPets.deviceOverrideSubtitle'),
                        icon: <Icon name="cpu" size={24} color={theme.colors.accent.blue} />,
                        itemProps: { showDivider: false },
                    }}
                    rowKind="item"
                />
            </View>
            <View testID="settings-pets-desktop-overlay-visibility-mode">
                <DropdownMenu
                    open={props.desktopOverlayVisibilityModeOpen}
                    onOpenChange={props.onDesktopOverlayVisibilityModeOpenChange}
                    selectedId={props.desktopPetOverlayVisibilityModeOverride}
                    items={props.visibilityModeItems}
                    onSelect={(itemId) => {
                        if (isDesktopPetOverlayVisibilityModeOverride(itemId)) {
                            props.onDesktopOverlayVisibilityModeOverrideChange(itemId);
                        }
                    }}
                    itemTrigger={{
                        title: t('settingsPets.desktopOverlayVisibilityModeTitle'),
                        subtitle: t('settingsPets.desktopOverlayVisibilityModeSubtitle'),
                        icon: <Icon name="eye" size={24} color={theme.colors.accent.blue} />,
                    }}
                    rowKind="item"
                />
            </View>
            <Item
                testID="settings-pets-desktop-overlay-reset-position"
                title={t('settingsPets.desktopOverlayResetPositionTitle')}
                subtitle={t('settingsPets.desktopOverlayResetPositionSubtitle')}
                icon={<Icon name="crosshair" size={24} color={theme.colors.accent.orange} />}
                onPress={props.onResetPosition}
            />
        </ItemGroup>
    );
}
