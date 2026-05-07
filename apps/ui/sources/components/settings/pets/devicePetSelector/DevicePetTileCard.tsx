import * as React from 'react';
import {
    Pressable,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    DEFAULT_BUILT_IN_PET_ID,
    type BuiltInPetPackage,
} from '@/components/pets/builtIns/builtInPetRegistry';
import { resolvePetAnimationFrame } from '@/components/pets/contract/resolvePetAnimationFrame';
import { PetSprite } from '@/components/pets/render/PetSprite';
import { usePetSpritesheetSourceResult } from '@/components/pets/render/usePetSpritesheetSource';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import { Text } from '@/components/ui/text/Text';
import { normalizePetCompanionSizeScale } from '@/sync/domains/pets/companionSizeScale';

import {
    DEVICE_PET_PREVIEW_HEIGHT,
    DEVICE_PET_PREVIEW_SCALE,
    DEVICE_PET_PREVIEW_WIDTH,
} from './constants';
import type { DevicePetTile } from './types';

export function resolveFallbackTileWidthStyle(columns: number): StyleProp<ViewStyle> {
    if (columns <= 1) return styles.tileFallbackSingle;
    if (columns === 2) return styles.tileFallbackDouble;
    if (columns === 3) return styles.tileFallbackTriple;
    if (columns === 4) return styles.tileFallbackQuad;
    if (columns === 5) return styles.tileFallbackFive;
    return styles.tileFallbackSix;
}

export function DevicePetTileCard(props: Readonly<{
    companionSizeScale?: number;
    tile: DevicePetTile;
    widthStyle: StyleProp<ViewStyle>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { tile, widthStyle } = props;
    const previewScale = DEVICE_PET_PREVIEW_SCALE * normalizePetCompanionSizeScale(props.companionSizeScale);

    return (
        <View
            testID={tile.testID}
            style={[
                styles.tileFrame,
                widthStyle,
                {
                    borderColor: tile.selected ? theme.colors.button.primary.background : theme.colors.divider,
                    backgroundColor: tile.selected ? theme.colors.surfaceSelected : theme.colors.surface,
                },
            ]}
        >
            <Pressable
                testID={tile.pressableTestID}
                accessibilityRole={tile.kind === 'detected' ? 'image' : 'radio'}
                accessibilityState={{ selected: tile.selected }}
                onPress={tile.onPress}
                style={({ pressed }) => [
                    styles.tilePressable,
                    pressed && tile.onPress ? { backgroundColor: theme.colors.surfacePressed } : null,
                ]}
            >
                <View
                    testID={tile.kind === 'builtIn' ? `settings-pets-built-in-card-${tile.pet.id}` : undefined}
                    style={styles.cardContent}
                >
                    <View style={styles.previewRow}>
                        {tile.kind === 'builtIn' ? (
                            <BuiltInPetPreview pet={tile.pet} previewScale={previewScale} testID={tile.previewTestID} />
                        ) : (
                            <DaemonPetPreview source={tile.source} previewScale={previewScale} testID={tile.previewTestID} />
                        )}
                        {tile.kind !== 'detected' ? (
                            <View
                                testID={tile.selectionControlTestID}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: tile.selected }}
                                style={styles.selectionControl}
                            >
                                <Ionicons
                                    name={tile.selected ? 'checkbox-outline' : 'square-outline'}
                                    size={24}
                                    color={tile.selected ? theme.colors.text : theme.colors.textSecondary}
                                />
                            </View>
                        ) : null}
                    </View>
                    <View style={styles.text}>
                        <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: theme.colors.text }}>
                            {tile.title}
                        </Text>
                        <Text numberOfLines={2} style={{ color: theme.colors.textSecondary }}>
                            {tile.subtitle}
                        </Text>
                    </View>
                </View>
            </Pressable>
            {tile.actions ? (
                <View style={styles.actions}>
                    {tile.actions}
                </View>
            ) : null}
        </View>
    );
}

function BuiltInPetPreview(props: Readonly<{
    pet: BuiltInPetPackage;
    previewScale: number;
    testID: string;
}>): React.ReactElement {
    const previewFrame = React.useMemo(
        () => resolvePetAnimationFrame({ state: 'idle', elapsedMs: 0, reducedMotion: true }),
        [],
    );

    return (
        <View testID={props.testID} style={styles.preview}>
            <PetSprite
                frame={previewFrame}
                spritesheetSource={props.pet.spritesheetSource}
                scale={props.previewScale}
            />
        </View>
    );
}

function DaemonPetPreview(props: Readonly<{
    previewScale: number;
    source: Extract<SelectedPetPackageSource, { kind: 'accountPet' | 'detectedCodexHome' | 'happierManagedLocal' }>;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const previewFrame = React.useMemo(
        () => resolvePetAnimationFrame({ state: 'idle', elapsedMs: 0, reducedMotion: true }),
        [],
    );
    const spritesheet = usePetSpritesheetSourceResult(props.source, DEFAULT_BUILT_IN_PET_ID, {
        fallbackOnError: false,
        fallbackWhileLoading: false,
    });

    return (
        <View testID={props.testID} style={styles.preview}>
            {spritesheet.source ? (
                <PetSprite
                    frame={previewFrame}
                    spritesheetSource={spritesheet.source}
                    scale={props.previewScale}
                />
            ) : (
                <View
                    testID={`${props.testID}-skeleton`}
                    style={[
                        styles.previewSkeleton,
                        { backgroundColor: theme.colors.surfacePressed },
                    ]}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    tileFrame: {
        borderRadius: 8,
        borderWidth: 1,
        minHeight: 184,
        overflow: 'hidden',
    },
    tileFallbackSingle: {
        width: '100%',
    },
    tileFallbackDouble: {
        width: '48.5%',
        maxWidth: '48.5%',
    },
    tileFallbackTriple: {
        width: '32%',
        maxWidth: '32%',
    },
    tileFallbackQuad: {
        width: '23.75%',
        maxWidth: '23.75%',
    },
    tileFallbackFive: {
        width: '18.9%',
        maxWidth: '18.9%',
    },
    tileFallbackSix: {
        width: '15.7%',
        maxWidth: '15.7%',
    },
    tilePressable: {
        alignItems: 'stretch',
        flex: 1,
        minHeight: 154,
        paddingHorizontal: 14,
        paddingTop: 12,
        paddingBottom: 10,
    },
    cardContent: {
        flex: 1,
    },
    previewRow: {
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: DEVICE_PET_PREVIEW_HEIGHT,
    },
    preview: {
        alignItems: 'center',
        justifyContent: 'center',
        width: DEVICE_PET_PREVIEW_WIDTH,
        height: DEVICE_PET_PREVIEW_HEIGHT,
        overflow: 'hidden',
    },
    previewSkeleton: {
        width: DEVICE_PET_PREVIEW_WIDTH * 0.68,
        height: DEVICE_PET_PREVIEW_HEIGHT * 0.78,
        borderRadius: 8,
        opacity: 0.72,
    },
    text: {
        gap: 3,
        minWidth: 0,
    },
    selectionControl: {
        alignItems: 'center',
        justifyContent: 'center',
        position: 'absolute',
        top: 2,
        right: 2,
        width: 28,
        height: 28,
    },
    actions: {
        alignItems: 'flex-end',
        minHeight: 34,
        paddingHorizontal: 14,
        paddingBottom: 12,
    },
});
