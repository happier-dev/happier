import * as React from 'react';
import { Platform } from 'react-native';

import { useSettingMutable } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { t } from '@/text';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

export type DiffPresentationStyleToggleButtonProps = Readonly<{
    disabled?: boolean;
    size?: number;
}>;

export const DiffPresentationStyleToggleButton = React.memo<DiffPresentationStyleToggleButtonProps>((props) => {
    const [styleSetting, setStyleSetting] = useSettingMutable('filesDiffPresentationStyle');

    const effectiveStyle = styleSetting === 'unified' || styleSetting === 'split'
        ? styleSetting
        : (settingsDefaults.filesDiffPresentationStyle === 'split' ? 'split' : 'unified');
    const disabled = props.disabled === true;
    const iconSize = typeof props.size === 'number' ? props.size : 18;

    const accessibilityLabel = t(
        effectiveStyle === 'unified'
            ? 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.title'
            : 'settingsSourceControl.filesDisplay.diffPresentation.options.split.title',
    );

    const toggle = React.useCallback(() => {
        if (disabled) return;
        setStyleSetting(effectiveStyle === 'unified' ? 'split' : 'unified');
    }, [disabled, effectiveStyle, setStyleSetting]);

    return (
        <IconButton
            onPress={toggle}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            tooltip={accessibilityLabel}
            iconName={effectiveStyle === 'unified' ? 'arrows-down-up' : 'grid-four'}
            iconSize={iconSize}
            size={28}
            variant="plain"
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            interactiveTargetGapPx={8}
        />
    );
});
