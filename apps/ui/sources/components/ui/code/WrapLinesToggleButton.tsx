import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { IconAction } from '@/components/ui/buttons/IconAction';
import { Icon } from '@/components/ui/icons/Icon';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

type ControlledWrapLinesProps = Readonly<{
    wrapLines: boolean;
    onChange: (wrapLines: boolean) => void;
}>;

type WrapLinesToggleButtonProps = ControlledWrapLinesProps | Readonly<{
    wrapLines?: never;
    onChange?: never;
}>;

const WrapLinesToggleSwitch = React.memo(({ wrapLines, onChange }: ControlledWrapLinesProps) => {
    const { theme } = useUnistyles();
    const label = t('settingsAppearance.wrapLinesInDiffs');

    return (
        <IconAction
            testID="code-wrap-lines-toggle"
            accessibilityLabel={label}
            accessibilityRole="switch"
            accessibilityState={{ checked: wrapLines }}
            active={wrapLines}
            hitSlop={Platform.OS === 'web' ? undefined : 5}
            onPress={() => onChange(!wrapLines)}
        >
            <Icon
                name="arrow-elbow-down-left"
                size={18}
                color={wrapLines ? theme.colors.text.primary : theme.colors.text.secondary}
            />
        </IconAction>
    );
});

const AccountWrapLinesToggleButton = React.memo(() => {
    const [wrapLinesSetting, setWrapLines] = useSettingMutable('wrapLinesInDiffs');
    return <WrapLinesToggleSwitch wrapLines={wrapLinesSetting === true} onChange={setWrapLines} />;
});

export const WrapLinesToggleButton = React.memo((props: WrapLinesToggleButtonProps) => (
    typeof props.wrapLines === 'boolean'
        ? <WrapLinesToggleSwitch wrapLines={props.wrapLines} onChange={props.onChange} />
        : <AccountWrapLinesToggleButton />
));

WrapLinesToggleButton.displayName = 'WrapLinesToggleButton';
