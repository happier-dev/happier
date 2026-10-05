import * as React from 'react';
import { Platform } from 'react-native';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { useEffectiveDiffWrapLines } from './diff/diffPresentationStyle';

export const WrapLinesToggleButton = React.memo(() => {
    const [wrapLinesSetting, setWrapLines] = useSettingMutable('wrapLinesInDiffs');
    const phone = useSurfaceStateSize() === 'phone';
    const wrapLines = useEffectiveDiffWrapLines(wrapLinesSetting === true) === true;
    const label = t('settingsAppearance.wrapLinesInDiffs');

    return (
        <IconButton
            testID="code-wrap-lines-toggle"
            accessibilityLabel={label}
            tooltip={label}
            accessibilityRole="switch"
            checked={wrapLines}
            selected={wrapLines}
            disabled={phone}
            iconName="arrow-elbow-down-left"
            iconSize={18}
            size={28}
            variant="plain"
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            interactiveTargetGapPx={8}
            onPress={() => { if (!phone) setWrapLines(!wrapLines); }}
        />
    );
});

WrapLinesToggleButton.displayName = 'WrapLinesToggleButton';
