import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';

import type { SoundEffectsVolumeSliderProps } from './SoundEffectsVolumeSlider';

export function SoundEffectsVolumeSlider(props: SoundEffectsVolumeSliderProps) {
    const { theme } = useUnistyles();
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em', opacity: props.disabled ? 0.5 : 1 }}>
            <input
                data-testid="settings-notifications-sound-effects-volume"
                aria-label={props.label}
                aria-valuetext={`${props.value}%`}
                type="range"
                min={0}
                max={100}
                value={props.value}
                disabled={props.disabled}
                onChange={(event) => props.onValueChange(event.currentTarget.valueAsNumber)}
                style={{ flex: 1, minWidth: 0, height: '2.75rem', margin: 0, accentColor: theme.colors.button.primary.background }}
            />
            {/* The web font-scale stylesheet already scales this Unistyles text style. */}
            <Text aria-hidden={true} disableUiFontScaling style={styles.value}>
                {props.value}%
            </Text>
        </div>
    );
}

const styles = StyleSheet.create((theme) => ({
    value: {
        ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
        color: theme.colors.text.secondary,
        minWidth: 42,
        textAlign: 'right',
        fontVariant: ['tabular-nums'],
    },
}));
