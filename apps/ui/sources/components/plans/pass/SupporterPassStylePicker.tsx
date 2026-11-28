import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import {
    SUPPORTER_PASS_FINISH_IDS,
    SUPPORTER_PASS_STYLE_IDS,
    type SupporterPassFinishId,
    type SupporterPassStyleId,
} from '@/sync/domains/settings/registry/local/supporterPassStyleSetting';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t, type TranslationKeyNoParams } from '@/text';

import { passMaterialForFinish } from './passArt';
import { PASS_STYLE_SWATCHES } from './passArtStyles';

const STYLE_LABELS: Readonly<Record<SupporterPassStyleId, TranslationKeyNoParams>> = {
    'glyph-number': 'planSurface.passStyleGlyphNumber',
    'glyph-sunrise': 'planSurface.passStyleGlyphSunrise',
    'smile-planet': 'planSurface.passStyleSmilePlanet',
    'dawn-halftone': 'planSurface.passStyleDawnHalftone',
    'holo-foil': 'planSurface.passStyleHoloFoil',
    'star-chart': 'planSurface.passStyleStarChart',
    'embossed-number': 'planSurface.passStyleEmbossedNumber',
};

const FINISH_LABELS: Readonly<Record<SupporterPassFinishId, TranslationKeyNoParams>> = {
    dark: 'planSurface.passFinishDark',
    light: 'planSurface.passFinishLight',
};

const SWATCH = 22;
const RING_GAP = 3;
const RING = SWATCH + RING_GAP * 2 + 4;
const HIT = 36;
const SWATCH_INSET = (HIT - SWATCH) / 2;

/**
 * The pass's style switcher: one two-tone swatch per art and, on the same row, the dark or light
 * finish. The live pass beside it shows the result, so the art needs no name here. Both choices are
 * this device's look (local settings), so they cost no request and sync nowhere; every pass on the
 * device follows them.
 */
export const SupporterPassStylePicker = React.memo(function SupporterPassStylePicker(props: Readonly<{
    /** `center` under a pass; `start` in a text column beside it. */
    align?: 'center' | 'start';
}>) {
    const start = props.align === 'start';
    const [style, setStyle] = useLocalSettingMutable('supporterPassStyle');
    const [finish, setFinish] = useLocalSettingMutable('supporterPassFinish');
    const material = passMaterialForFinish(finish);
    return (
        <View style={[styles.root, start ? styles.rootStart : null]}>
            <Eyebrow style={styles.prompt} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {t('planSurface.passStyleLabel')}
            </Eyebrow>
            <View style={[styles.controls, start ? styles.controlsStart : null]}>
                <View style={[styles.swatches, start ? styles.swatchesStart : null]} accessibilityRole="radiogroup" accessibilityLabel={t('planSurface.passStyleLabel')}>
                    {SUPPORTER_PASS_STYLE_IDS.map((id) => {
                        const selected = id === style;
                        const [ground, light] = PASS_STYLE_SWATCHES[id][material];
                        return (
                            <Pressable
                                key={id}
                                testID={`supporter-pass-style:${id}`}
                                accessibilityRole="radio"
                                accessibilityLabel={t(STYLE_LABELS[id])}
                                accessibilityState={{ selected, checked: selected }}
                                onPress={() => setStyle(id)}
                                hitSlop={{ top: 4, bottom: 4 }}
                                style={({ pressed }) => [styles.hit, pressed ? styles.pressed : null]}
                            >
                                <View style={[styles.ring, selected ? styles.ringSelected : null]}>
                                    <View style={[styles.swatch, { backgroundColor: ground }]}>
                                        <View style={[styles.light, { backgroundColor: light }]} />
                                    </View>
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
                <View style={styles.finishTrack} accessibilityRole="radiogroup" accessibilityLabel={t('planSurface.passFinishLabel')}>
                    {SUPPORTER_PASS_FINISH_IDS.map((id) => {
                        const selected = id === finish;
                        return (
                            <Pressable
                                key={id}
                                testID={`supporter-pass-finish:${id}`}
                                accessibilityRole="radio"
                                accessibilityLabel={t(FINISH_LABELS[id])}
                                accessibilityState={{ selected, checked: selected }}
                                onPress={() => setFinish(id)}
                                hitSlop={{ top: 8, bottom: 8 }}
                                style={({ pressed }) => [styles.finishOption, selected ? styles.finishOptionSelected : null, pressed ? styles.pressed : null]}
                            >
                                <Text style={[styles.finishText, selected ? styles.finishTextSelected : null]}>{t(FINISH_LABELS[id])}</Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
    },
    rootStart: {
        alignItems: 'flex-start',
    },
    // Close to the swatches it names (the space above belongs to the caller).
    prompt: {
        marginBottom: 6,
    },
    // Swatches and finish on one row; on a narrow phone the finish wraps whole to the next line.
    controls: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        columnGap: 16,
        rowGap: 8,
    },
    controlsStart: {
        justifyContent: 'flex-start',
    },
    swatches: {
        flexDirection: 'row',
    },
    // Each 36 pt target pads its swatch by 7 pt; pull the row back so the first swatch lines up
    // with the text above it.
    swatchesStart: {
        marginLeft: -SWATCH_INSET,
    },
    // 36 pt wide (44 pt tall with the slop) around 22 pt swatches; neighbours touch but never overlap.
    hit: {
        width: HIT,
        height: HIT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pressed: {
        transform: [{ scale: 0.96 }],
    },
    ring: {
        width: RING,
        height: RING,
        borderRadius: RING / 2,
        borderWidth: 2,
        borderColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
    },
    ringSelected: {
        borderColor: theme.colors.text.primary,
    },
    swatch: {
        width: SWATCH,
        height: SWATCH,
        borderRadius: SWATCH / 2,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        justifyContent: 'flex-end',
    },
    // The art's light rises from the lower half, like the band every pass art spends itself in.
    light: {
        height: SWATCH * 0.42,
        opacity: 0.95,
    },
    // A small segmented control: the track is the inset surface, the chosen finish a raised chip.
    finishTrack: {
        flexDirection: 'row',
        padding: 2,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    finishOption: {
        minWidth: 52,
        height: 26,
        paddingHorizontal: 10,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    finishOptionSelected: {
        backgroundColor: theme.colors.surface.base,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
    finishText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    finishTextSelected: {
        color: theme.colors.text.primary,
    },
}));
