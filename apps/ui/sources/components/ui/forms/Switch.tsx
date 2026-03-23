import { Platform, Switch as RNSwitch, SwitchProps, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Deferred } from './Deferred';

const COMPACT_SCALE = 0.78;

export type AppSwitchProps = SwitchProps & {
    compact?: boolean;
};

export const Switch = ({ compact, style, ...props }: AppSwitchProps) => {
    const { theme } = useUnistyles();
    const inner = (
        <Deferred enabled={Platform.OS === 'android'}>
            <RNSwitch
                {...props}
                style={compact ? undefined : style}
                trackColor={{ false: theme.colors.switch.track.inactive, true: theme.colors.switch.track.active }}
                ios_backgroundColor={theme.colors.switch.track.inactive}
                thumbColor={theme.colors.switch.thumb.active}
                {...{
                    activeThumbColor: theme.colors.switch.thumb.active,
                }}
            />
        </Deferred>
    );

    if (!compact) return inner;

    return (
        <View style={[{ transform: [{ scale: COMPACT_SCALE }] }, style]}>
            {inner}
        </View>
    );
}