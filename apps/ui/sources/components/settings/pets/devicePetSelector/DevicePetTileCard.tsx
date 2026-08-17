import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PetPackageSourceV1 } from '@happier-dev/protocol';

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
import type { LocalPetPreviewAsset } from '@/sync/domains/pets/localPetSourceTypes';

import {
    DEVICE_PET_PREVIEW_HEIGHT,
    DEVICE_PET_PREVIEW_SCALE,
    DEVICE_PET_PREVIEW_WIDTH,
} from './constants';
import type { DevicePetTile } from './types';
import { Icon } from '@/components/ui/icons/Icon';

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
                    borderColor: tile.selected ? theme.colors.button.primary.background : theme.colors.border.default,
                    backgroundColor: tile.selected ? theme.colors.surface.selected : theme.colors.surface.base,
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
                    pressed && tile.onPress ? { backgroundColor: theme.colors.surface.pressed } : null,
                ]}
            >
                <View
                    testID={tile.kind === 'builtIn' ? `settings-pets-built-in-card-${tile.pet.id}` : undefined}
                    style={styles.cardContent}
                >
                    <View style={styles.previewRow}>
                        {tile.kind === 'builtIn' ? (
                            <BuiltInPetPreview
                                pet={tile.pet}
                                previewScale={previewScale}
                                testID={tile.previewTestID}
                            />
                        ) : (
                            <DaemonPetPreview
                                source={tile.source}
                                previewAsset={tile.previewAsset}
                                previewScale={previewScale}
                                testID={tile.previewTestID}
                            />
                        )}
                        {tile.kind !== 'detected' ? (
                            <View
                                testID={`settings-pets-selection-control-${tile.petId}`}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: tile.selected }}
                                style={styles.selectionControl}
                            >
                                <Icon
                                    name={tile.selected ? 'check-square' : 'square'}
                                    size={24}
                                    color={tile.selected ? theme.colors.text.primary : theme.colors.text.secondary}
                                />
                            </View>
                        ) : null}
                    </View>
                    <View style={styles.text}>
                        <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: theme.colors.text.primary }}>
                            {tile.title}
                        </Text>
                        <Text numberOfLines={2} style={{ color: theme.colors.text.secondary }}>
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

type DaemonPreviewSource =
    | Extract<PetPackageSourceV1, { kind: 'detectedCodexHome' | 'happierManagedLocal' }>
    | Extract<SelectedPetPackageSource, { kind: 'accountPet' }>;

function resolveDaemonPreviewSource(
    source: DaemonPreviewSource,
    previewAsset: LocalPetPreviewAsset | null,
): Extract<SelectedPetPackageSource, { kind: 'accountPet' | 'detectedCodexHome' | 'happierManagedLocal' }> {
    if (source.kind === 'accountPet') return source;
    if (!previewAsset) {
        return {
            kind: source.kind,
            sourceKey: source.sourceKey,
        };
    }
    return {
        kind: source.kind,
        sourceKey: source.sourceKey,
        mediaType: previewAsset.mediaType,
        digest: previewAsset.digest ?? undefined,
        daemonTarget: previewAsset.target,
    };
}

function DaemonPetPreview(props: Readonly<{
    source: DaemonPreviewSource;
    previewAsset: LocalPetPreviewAsset | null;
    previewScale: number;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const previewFrame = React.useMemo(
        () => resolvePetAnimationFrame({ state: 'idle', elapsedMs: 0, reducedMotion: true }),
        [],
    );
    const previewSource = React.useMemo(
        () => resolveDaemonPreviewSource(props.source, props.previewAsset),
        [props.previewAsset, props.source],
    );
    const spritesheet = usePetSpritesheetSourceResult(previewSource, DEFAULT_BUILT_IN_PET_ID, {
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
                        { backgroundColor: theme.colors.surface.pressed },
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
        top: 0,
        right: 0,
        width: 32,
        height: 32,
    },
    actions: {
        alignItems: 'flex-end',
        minHeight: 34,
        paddingHorizontal: 14,
        paddingBottom: 12,
    },
});
