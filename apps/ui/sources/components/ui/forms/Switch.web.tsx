import * as React from 'react';
import type { SwitchProps } from 'react-native';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const TRACK_WIDTH = 40;
const TRACK_HEIGHT = 22;
const THUMB_SIZE = 18;
const PADDING = 2;

const COMPACT_TRACK_WIDTH = 32;
const COMPACT_TRACK_HEIGHT = 18;
const COMPACT_THUMB_SIZE = 14;
const COMPACT_PADDING = 2;

const stylesheet = StyleSheet.create(() => ({
    track: {
        width: TRACK_WIDTH,
        height: TRACK_HEIGHT,
        borderRadius: TRACK_HEIGHT / 2,
        padding: PADDING,
        justifyContent: 'center',
    },
    trackCompact: {
        width: COMPACT_TRACK_WIDTH,
        height: COMPACT_TRACK_HEIGHT,
        borderRadius: COMPACT_TRACK_HEIGHT / 2,
        padding: COMPACT_PADDING,
    },
    thumb: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: THUMB_SIZE / 2,
    },
    thumbCompact: {
        width: COMPACT_THUMB_SIZE,
        height: COMPACT_THUMB_SIZE,
        borderRadius: COMPACT_THUMB_SIZE / 2,
    },
}));

export type AppSwitchProps = SwitchProps & {
    compact?: boolean;
};

export const Switch = ({ value, disabled, onValueChange, style, compact, ...rest }: AppSwitchProps) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const trackW = compact ? COMPACT_TRACK_WIDTH : TRACK_WIDTH;
    const thumbS = compact ? COMPACT_THUMB_SIZE : THUMB_SIZE;
    const pad = compact ? COMPACT_PADDING : PADDING;
    const translateX = value ? trackW - thumbS - pad * 2 : 0;

    return (
        <Pressable
            {...rest}
            accessibilityRole="switch"
            accessibilityState={{ checked: !!value, disabled: !!disabled }}
            aria-checked={!!value}
            aria-disabled={disabled ? true : undefined}
            disabled={disabled}
            onPress={() => onValueChange?.(!value)}
            style={({ pressed }) => [
                style as any,
                { opacity: disabled ? 0.6 : pressed ? 0.85 : 1 },
            ]}
        >
            <View
                style={[
                    styles.track,
                    compact ? styles.trackCompact : null,
                    {
                        backgroundColor: value ? theme.colors.switch.track.active : theme.colors.switch.track.inactive,
                    },
                ]}
            >
                <View
                    style={[
                        styles.thumb,
                        compact ? styles.thumbCompact : null,
                        {
                            backgroundColor: theme.colors.switch.thumb.active,
                            transform: [{ translateX }],
                        },
                    ]}
                />
            </View>
        </Pressable>
    );
};
