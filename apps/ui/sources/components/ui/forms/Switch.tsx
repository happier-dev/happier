import * as React from 'react';
import { Platform, Switch as RNSwitch, SwitchProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

import { Deferred } from './Deferred';

const MINIMUM_INTERACTIVE_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const MINIMUM_INTERACTIVE_TARGET_STYLE = Object.freeze({
    minWidth: MINIMUM_INTERACTIVE_TARGET_SIZE,
    minHeight: MINIMUM_INTERACTIVE_TARGET_SIZE,
});

export type AppSwitchProps = SwitchProps & {
    compact?: boolean;
};

export const Switch = React.forwardRef<React.ElementRef<typeof RNSwitch>, AppSwitchProps>(function Switch(
    { compact: _compact, style, ...props },
    ref,
) {
    const { theme } = useUnistyles();
    return (
        <Deferred enabled={Platform.OS === 'android'}>
            <RNSwitch
                ref={ref}
                {...props}
                style={[style, MINIMUM_INTERACTIVE_TARGET_STYLE]}
                trackColor={{ false: theme.colors.switch.track.inactive, true: theme.colors.switch.track.active }}
                ios_backgroundColor={theme.colors.switch.track.inactive}
                thumbColor={theme.colors.switch.thumb.active}
                {...{
                    activeThumbColor: theme.colors.switch.thumb.active,
                }}
            />
        </Deferred>
    );
});
