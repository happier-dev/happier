import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Slider } from '@/components/ui/forms/Slider';
import { useLocalSettingPreview, useLocalSettingPreviewValue } from '@/sync/store/settingsPreview';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import {
    PET_COMPANION_SIZE_SCALE_MAX,
    PET_COMPANION_SIZE_SCALE_MIN,
    PET_COMPANION_SIZE_SCALE_STEP,
    normalizePetCompanionSizeScale,
    petCompanionSizeScaleToPercent,
} from '@/sync/domains/pets/companionSizeScale';
import { t } from '@/text';

type PetCompanionSizeSliderProps = Readonly<{
    value: number;
    onValueChange: (value: number) => void;
    showDivider?: boolean;
}>;

/** The pet size row: a real ordered scale, so a slider whose ends show small and large. */
export function PetCompanionSizeSlider(props: PetCompanionSizeSliderProps): React.ReactElement {
    const { theme } = useUnistyles();
    const previewSize = useLocalSettingPreview('petsCompanionSizeScale');
    const previewValue = useLocalSettingPreviewValue('petsCompanionSizeScale');
    const value = normalizePetCompanionSizeScale(previewValue ?? props.value);
    const percent = petCompanionSizeScaleToPercent(value);
    const { onValueChange } = props;
    const handleValueChange = React.useCallback((next: number) => {
        onValueChange(normalizePetCompanionSizeScale(next));
    }, [onValueChange]);

    return (
        <Item
            testID="settings-pets-companion-size"
            title={t('settingsPets.companionSizeTitle')}
            subtitle={`${t('settingsPets.companionSizeValue', { percent })} · ${t('settingsPets.companionSizeSubtitle')}`}
            showDivider={props.showDivider}
            accessoryLayout="adaptive"
            showChevron={false}
            rightElement={(
                <Slider
                    testID="settings-pets-companion-size-slider"
                    value={value}
                    min={PET_COMPANION_SIZE_SCALE_MIN}
                    max={PET_COMPANION_SIZE_SCALE_MAX}
                    step={PET_COMPANION_SIZE_SCALE_STEP}
                    trackWidth={180}
                    accessibilityLabel={t('settingsPets.companionSizeTitle')}
                    formatValueText={(next) => t('settingsPets.companionSizeValue', { percent: petCompanionSizeScaleToPercent(next) })}
                    leading={<Icon name="paw-print" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                    trailing={<Icon name="paw-print" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                    onValueChange={handleValueChange}
                    onValuePreview={previewSize}
                />
            )}
        />
    );
}
