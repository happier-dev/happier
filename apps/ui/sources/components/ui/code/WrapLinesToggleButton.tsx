import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { IconAction } from '@/components/ui/buttons/IconAction';
import { Icon } from '@/components/ui/icons/Icon';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

export const WrapLinesToggleButton = React.memo(() => {
    const { theme } = useUnistyles();
    const [wrapLinesSetting, setWrapLines] = useSettingMutable('wrapLinesInDiffs');
    const wrapLines = wrapLinesSetting === true;
    const label = t('settingsAppearance.wrapLinesInDiffs');

    return (
        <IconAction
            testID="code-wrap-lines-toggle"
            accessibilityLabel={label}
            accessibilityRole="switch"
            accessibilityState={{ checked: wrapLines }}
            active={wrapLines}
            hitSlop={Platform.OS === 'web' ? undefined : 5}
            onPress={() => setWrapLines(!wrapLines)}
        >
            <Icon
                name="arrow-elbow-down-left"
                size={18}
                color={wrapLines ? theme.colors.text.primary : theme.colors.text.secondary}
            />
        </IconAction>
    );
});

WrapLinesToggleButton.displayName = 'WrapLinesToggleButton';
