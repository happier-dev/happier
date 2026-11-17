import * as React from 'react';
import { PixelRatio, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import {
    Canvas,
    ColorMatrix,
    FilterMode,
    Image as SkiaImage,
    MipmapMode,
    useImage,
} from '@shopify/react-native-skia';
import { cancelAnimation, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import type { ImageProps } from 'expo-image';

import type { ResolvedPetAnimationFrame } from '@/components/pets/contract/resolvePetAnimationFrame';
import { startBotFaceSteps } from '@/components/sessions/bots/face/botFaceSteps';
import { useHostActivelyViewedEffect } from '@/utils/runtime/useHostActivelyViewed';

import { petSpriteLayout, type PetSpriteFit } from './petSpriteGeometry';
import type { PetSpriteTrack } from './PetSprite';

type PetSpriteDataProps = ViewProps & Readonly<{
    dataSet: Readonly<{ petState: ResolvedPetAnimationFrame['state'] }>;
    'data-pet-state': ResolvedPetAnimationFrame['state'];
}>;

type NativeSkiaDataSource = string | number | Uint8Array | null | undefined;

export type { PetSpriteTrack } from './PetSprite';

export type PetSpriteProps = Readonly<{
    frame: ResolvedPetAnimationFrame;
    spriteVersionNumber?: 1 | 2;
    spritesheetSource?: ImageProps['source'];
    scale?: number;
    fit?: PetSpriteFit;
    track?: PetSpriteTrack | null;
    monochrome?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

/** Every pet size is a downscale of the atlas: linear filtering over linear mipmaps keeps eyes and outline. */
const SMOOTH_SAMPLING = Object.freeze({
    filter: FilterMode.Linear,
    mipmap: MipmapMode.Linear,
});
/** Rec. 709 luminance, for the notch's not-live faces. */
const GREYSCALE = [
    0.2126, 0.7152, 0.0722, 0, 0,
    0.2126, 0.7152, 0.0722, 0, 0,
    0.2126, 0.7152, 0.0722, 0, 0,
    0, 0, 0, 1, 0,
];
const NO_OFFSETS: readonly Readonly<{ x: number; y: number }>[] = Object.freeze([]);

function resolveSkiaDataSource(source: ImageProps['source'] | undefined): NativeSkiaDataSource {
    if (typeof source === 'string' || typeof source === 'number' || source instanceof Uint8Array) {
        return source;
    }
    if (source && typeof source === 'object' && 'uri' in source && typeof source.uri === 'string') {
        return source.uri;
    }
    return undefined;
}

export function PetSprite(props: PetSpriteProps): React.ReactElement {
    const { cellWidth, cellHeight } = props.frame;
    const box = props.fit?.box;
    const bounds = props.fit?.bounds;
    const layout = React.useMemo(
        () => petSpriteLayout({ cellWidth, cellHeight, spriteVersionNumber: props.spriteVersionNumber, scale: props.scale, fit: box === undefined ? undefined : { box, bounds }, dpr: PixelRatio.get() }),
        [cellWidth, cellHeight, props.spriteVersionNumber, props.scale, box, bounds],
    );
    const still = layout.offset(props.frame);
    const image = useImage(resolveSkiaDataSource(props.spritesheetSource));
    const { track } = props;
    const offsets = React.useMemo(() => (track ? track.cells.map(layout.offset) : NO_OFFSETS), [track, layout]);
    // −1: the still frame; otherwise the step the UI-thread track shows. Without a track the frame is a plain prop.
    const step = useSharedValue(-1);
    useHostActivelyViewedEffect((viewed) => {
        if (!track) return;
        if (!viewed) {
            if (track.steps.iterations !== Infinity) track.onFinish?.();
            return;
        }
        startBotFaceSteps(step, track.steps, track.onFinish);
        return () => {
            cancelAnimation(step);
            step.set(-1);
        };
    }, [step, track]);
    const x = useDerivedValue(() => offsets[step.get()]?.x ?? still.x, [offsets, still.x]);
    const y = useDerivedValue(() => offsets[step.get()]?.y ?? still.y, [offsets, still.y]);

    const rootStyle = {
        width: layout.width,
        height: layout.height,
        backgroundColor: 'transparent',
        overflow: 'hidden',
    } satisfies ViewStyle;
    const dataProps: PetSpriteDataProps = {
        testID: props.testID ?? 'pet-companion-sprite',
        dataSet: { petState: props.frame.state },
        'data-pet-state': props.frame.state,
        style: props.style ? [rootStyle, props.style] : rootStyle,
    };

    return (
        <View {...dataProps}>
            {props.spritesheetSource ? (
                <Canvas style={{ position: 'absolute', ...layout.clip }}>
                    <SkiaImage
                        image={image}
                        x={track ? x : still.x}
                        y={track ? y : still.y}
                        width={layout.atlasWidth}
                        height={layout.atlasHeight}
                        sampling={SMOOTH_SAMPLING}
                    >
                        {props.monochrome ? <ColorMatrix matrix={GREYSCALE} /> : null}
                    </SkiaImage>
                </Canvas>
            ) : null}
        </View>
    );
}
