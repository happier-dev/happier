import * as React from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import {
    PET_COMPANION_SIZE_SCALE_MAX,
    PET_COMPANION_SIZE_SCALE_MIN,
    normalizePetCompanionSizeScale,
    petCompanionSizeScaleToPercent,
    resolvePetCompanionSizeScaleFromTrackPosition,
} from '@/sync/domains/pets/companionSizeScale';
import { t } from '@/text';

type PetCompanionSizeSliderProps = Readonly<{
    value: number;
    onValueChange: (value: number) => void;
    showDivider?: boolean;
}>;

function readLocationX(event: GestureResponderEvent): number | null {
    const locationX = event.nativeEvent.locationX;
    return typeof locationX === 'number' && Number.isFinite(locationX) ? locationX : null;
}

export function PetCompanionSizeSlider(props: PetCompanionSizeSliderProps): React.ReactElement {
    const { theme } = useUnistyles();
    const [trackWidth, setTrackWidth] = React.useState(0);
    const value = normalizePetCompanionSizeScale(props.value);
    const progress =
        (value - PET_COMPANION_SIZE_SCALE_MIN)
        / (PET_COMPANION_SIZE_SCALE_MAX - PET_COMPANION_SIZE_SCALE_MIN);
    const percent = petCompanionSizeScaleToPercent(value);

    const updateFromEvent = React.useCallback((event: GestureResponderEvent) => {
        const locationX = readLocationX(event);
        if (locationX == null) return;
        props.onValueChange(resolvePetCompanionSizeScaleFromTrackPosition({
            locationX,
            trackWidth,
        }));
    }, [props, trackWidth]);

    const handleTrackLayout = React.useCallback((event: LayoutChangeEvent) => {
        setTrackWidth(event.nativeEvent.layout.width);
    }, []);

    return (
        <View
            testID="settings-pets-companion-size-slider"
            accessibilityRole="adjustable"
            accessibilityLabel={t('settingsPets.companionSizeTitle')}
            accessibilityValue={{ min: 75, max: 150, now: percent, text: t('settingsPets.companionSizeValue', { percent }) }}
            style={styles.row}
        >
            <View style={styles.header}>
                <View style={styles.copy}>
                    <Text numberOfLines={1} style={[styles.title, { color: theme.colors.text }]}>
                        {t('settingsPets.companionSizeTitle')}
                    </Text>
                    <Text numberOfLines={2} style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
                        {t('settingsPets.companionSizeSubtitle')}
                    </Text>
                </View>
                <Text
                    testID="settings-pets-companion-size-slider-value"
                    style={[styles.value, { color: theme.colors.textSecondary }]}
                >
                    {t('settingsPets.companionSizeValue', { percent })}
                </Text>
            </View>
            <View
                testID="settings-pets-companion-size-slider-track"
                onLayout={handleTrackLayout}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={updateFromEvent}
                onResponderMove={updateFromEvent}
                style={[
                    styles.trackHitbox,
                    props.showDivider === false ? styles.lastRowPadding : null,
                ]}
            >
                <View style={[styles.track, { backgroundColor: theme.colors.divider }]}>
                    <View
                        testID="settings-pets-companion-size-slider-fill"
                        style={[
                            styles.fill,
                            {
                                width: `${Math.round(progress * 100)}%`,
                                backgroundColor: theme.colors.button.primary.background,
                            },
                        ]}
                    />
                    <View
                        testID="settings-pets-companion-size-slider-thumb"
                        style={[
                            styles.thumb,
                            {
                                left: `${Math.round(progress * 100)}%`,
                                backgroundColor: theme.colors.button.primary.background,
                                borderColor: theme.colors.surface,
                            },
                        ]}
                    />
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 12,
        gap: 10,
    } satisfies ViewStyle,
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 14,
        justifyContent: 'space-between',
    },
    copy: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
    },
    subtitle: {
        ...Typography.default('regular'),
        fontSize: 13,
        lineHeight: 18,
    },
    value: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        fontVariant: ['tabular-nums'],
        lineHeight: 18,
    },
    trackHitbox: {
        height: 40,
        justifyContent: 'center',
    },
    lastRowPadding: {
        paddingBottom: 2,
    },
    track: {
        borderRadius: 999,
        height: 6,
        overflow: 'visible',
        position: 'relative',
    },
    fill: {
        borderRadius: 999,
        height: 6,
    },
    thumb: {
        borderRadius: 12,
        borderWidth: 3,
        height: 24,
        marginLeft: -12,
        marginTop: -9,
        position: 'absolute',
        top: 0,
        width: 24,
    },
});
