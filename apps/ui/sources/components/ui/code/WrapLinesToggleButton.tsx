import * as React from 'react';
import { Platform } from 'react-native';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

export const WrapLinesToggleButton = React.memo(() => {
    const [wrapLinesSetting, setWrapLines] = useSettingMutable('wrapLinesInDiffs');
    const wrapLines = wrapLinesSetting === true;
    const label = t('settingsAppearance.wrapLinesInDiffs');

    return (
        <IconButton
            testID="code-wrap-lines-toggle"
            accessibilityLabel={label}
            tooltip={label}
            accessibilityRole="switch"
            checked={wrapLines}
            selected={wrapLines}
            iconName="arrow-elbow-down-left"
            iconSize={18}
            size={28}
            variant="plain"
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            interactiveTargetGapPx={8}
            onPress={() => setWrapLines(!wrapLines)}
        />
    );
});

WrapLinesToggleButton.displayName = 'WrapLinesToggleButton';
