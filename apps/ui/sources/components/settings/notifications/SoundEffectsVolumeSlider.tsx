import * as React from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export type SoundEffectsVolumeSliderProps = Readonly<{
    label: string;
    value: number;
    disabled: boolean;
    onValueChange: (value: number) => void;
}>;

const STEP = 5;
const THUMB_SIZE = 20;

export function SoundEffectsVolumeSlider(props: SoundEffectsVolumeSliderProps) {
    const trackWidth = React.useRef(0);
    const [dragValue, setDragValue] = React.useState<number | null>(null);
    const value = dragValue ?? props.value;

    function readValue(event: GestureResponderEvent): number | null {
        const x = event.nativeEvent.locationX;
        if (!Number.isFinite(x) || trackWidth.current <= 0) return null;
        return Math.round(Math.min(100, Math.max(0, x / trackWidth.current * 100)));
    }

    function updateDrag(event: GestureResponderEvent) {
        if (!props.disabled) setDragValue(readValue(event));
    }

    return (
        <View style={[styles.slider, props.disabled && styles.disabled]}>
            <View
                testID="settings-notifications-sound-effects-volume"
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel={props.label}
                accessibilityState={{ disabled: props.disabled }}
                accessibilityValue={{ min: 0, max: 100, now: value, text: `${value}%` }}
                accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                onAccessibilityAction={({ nativeEvent }) => {
                    if (props.disabled) return;
                    if (nativeEvent.actionName === 'increment') props.onValueChange(Math.min(100, props.value + STEP));
                    if (nativeEvent.actionName === 'decrement') props.onValueChange(Math.max(0, props.value - STEP));
                }}
                onLayout={({ nativeEvent }) => { trackWidth.current = nativeEvent.layout.width; }}
                onStartShouldSetResponder={() => !props.disabled}
                onResponderGrant={updateDrag}
                onResponderMove={updateDrag}
                onResponderRelease={(event) => {
                    const next = readValue(event) ?? dragValue;
                    if (!props.disabled && next !== null && next !== props.value) props.onValueChange(next);
                    setDragValue(null);
                }}
                onResponderTerminate={() => setDragValue(null)}
                style={styles.hitbox}
            >
                <View pointerEvents="none" style={styles.track}>
                    <View style={[styles.fill, { width: `${value}%` }]} />
                    <View style={[styles.thumb, { left: `${value}%` }]} />
                </View>
            </View>
            <Text accessible={false} style={styles.value}>{value}%</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    slider: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    disabled: { opacity: 0.5 },
    hitbox: { flex: 1, minHeight: 44, marginHorizontal: THUMB_SIZE / 2, justifyContent: 'center' },
    track: { height: 6, borderRadius: 3, backgroundColor: theme.colors.border.default },
    fill: { height: '100%', borderRadius: 3, backgroundColor: theme.colors.button.primary.background },
    thumb: {
        position: 'absolute',
        top: (6 - THUMB_SIZE) / 2,
        marginLeft: -THUMB_SIZE / 2,
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: THUMB_SIZE / 2,
        backgroundColor: theme.colors.button.primary.background,
    },
    value: { minWidth: 42, textAlign: 'right', color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
}));
