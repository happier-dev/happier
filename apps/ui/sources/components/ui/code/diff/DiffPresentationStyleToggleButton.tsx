import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useSettingMutable } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { IconAction } from '@/components/ui/buttons/IconAction';

export type DiffPresentationStyleToggleButtonProps = Readonly<{
    disabled?: boolean;
    size?: number;
}>;

export const DiffPresentationStyleToggleButton = React.memo<DiffPresentationStyleToggleButtonProps>((props) => {
    const { theme } = useUnistyles();
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
        <IconAction
            onPress={toggle}
            disabled={disabled}
            accessibilityLabel={accessibilityLabel}
        >
            <Icon
                name={effectiveStyle === 'unified' ? 'arrows-down-up' : 'grid-four'}
                size={iconSize}
                color={theme.colors.text.secondary}
            />
        </IconAction>
    );
});
