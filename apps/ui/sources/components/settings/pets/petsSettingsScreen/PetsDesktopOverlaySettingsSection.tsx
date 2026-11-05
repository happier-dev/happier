import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { PETS_SETTINGS } from '@/components/settings/pets/petsSettings';

import type {
    PetEnabledOverride,
} from './types';

type PetsDesktopOverlaySettingsSectionProps = Readonly<{
    desktopOverlayDefaultEnabled: boolean;
    desktopPetOverlayEnabledOverride: PetEnabledOverride;
    onDefaultEnabledChange: (enabled: boolean) => void;
    onDesktopOverlayOverrideChange: (override: PetEnabledOverride) => void;
    onResetPosition: () => void;
    overrideOptions: ReadonlyArray<SegmentedChoiceOption<PetEnabledOverride>>;
}>;

export function PetsDesktopOverlaySettingsSection(props: PetsDesktopOverlaySettingsSectionProps): React.ReactElement {
    return (
        <ItemGroup title={t('settingsPets.desktopOverlayTitle')} description={t('settingsPets.desktopOverlayDescription')}>
            <SettingRow
                testID="settings-pets-desktop-overlay-enabled"
                setting={PETS_SETTINGS.settings.desktopOverlayEnabled}
                rightElement={(
                    <Switch
                        value={props.desktopOverlayDefaultEnabled}
                        onValueChange={props.onDefaultEnabledChange}
                    />
                )}
                showChevron={false}
            />
            <SettingAnchor setting={PETS_SETTINGS.settings.desktopOverlayDeviceOverride}>
                <SegmentedChoiceItem<PetEnabledOverride>
                    testID="settings-pets-desktop-overlay-device-override"
                    testIDPrefix="settings-pets-desktop-overlay-device-override"
                    title={t(PETS_SETTINGS.settings.desktopOverlayDeviceOverride.titleKey)}
                    subtitle={t('settingsPets.deviceOverrideSubtitle')}
                    options={props.overrideOptions}
                    value={props.desktopPetOverlayEnabledOverride}
                    onChange={props.onDesktopOverlayOverrideChange}
                />
            </SettingAnchor>
            <SettingRow
                testID="settings-pets-desktop-overlay-reset-position"
                setting={PETS_SETTINGS.settings.desktopOverlayResetPosition}
                onPress={props.onResetPosition}
                showChevron={false}
            />
        </ItemGroup>
    );
}
