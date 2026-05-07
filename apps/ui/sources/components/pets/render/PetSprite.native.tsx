import * as React from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import {
    Canvas,
    FilterMode,
    Group,
    Image as SkiaImage,
    MipmapMode,
    rect,
    useImage,
} from '@shopify/react-native-skia';
import type { ImageProps } from 'expo-image';

import { PET_ATLAS_V1 } from '@happier-dev/protocol';

import type { ResolvedPetAnimationFrame } from '@/components/pets/contract/resolvePetAnimationFrame';

type PetSpriteDataProps = ViewProps & Readonly<{
    dataSet: Readonly<{ petState: ResolvedPetAnimationFrame['state'] }>;
    'data-pet-state': ResolvedPetAnimationFrame['state'];
}>;

type NativeSkiaDataSource = string | number | Uint8Array | null | undefined;

export type PetSpriteProps = Readonly<{
    frame: ResolvedPetAnimationFrame;
    spritesheetSource?: ImageProps['source'];
    scale?: number;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const NEAREST_NEIGHBOR_SAMPLING = Object.freeze({
    filter: FilterMode.Nearest,
    mipmap: MipmapMode.Nearest,
});

function resolveScale(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

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
    const scale = resolveScale(props.scale);
    const width = props.frame.cellWidth * scale;
    const height = props.frame.cellHeight * scale;
    const image = useImage(resolveSkiaDataSource(props.spritesheetSource));
    const rootStyle = {
        width,
        height,
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
                <Canvas style={{ width, height }}>
                    <Group clip={rect(0, 0, width, height)}>
                        <SkiaImage
                            image={image}
                            x={-(props.frame.frame * props.frame.cellWidth * scale)}
                            y={-(props.frame.row * props.frame.cellHeight * scale)}
                            width={PET_ATLAS_V1.width * scale}
                            height={PET_ATLAS_V1.height * scale}
                            sampling={NEAREST_NEIGHBOR_SAMPLING}
                        />
                    </Group>
                </Canvas>
            ) : (
                <View
                    style={[
                        {
                            width,
                            height,
                            backgroundColor: 'transparent',
                        },
                        props.style,
                    ]}
                />
            )}
        </View>
    );
}
