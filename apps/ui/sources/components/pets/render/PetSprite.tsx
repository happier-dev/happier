import * as React from 'react';
import { Platform, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { Image, type ImageProps } from 'expo-image';

import type { ResolvedPetAnimationFrame } from '@/components/pets/animation/resolvePetAnimationTimeline';
import { PET_ATLAS_V1 } from '@happier-dev/protocol';

type PetSpriteDataProps = ViewProps & Readonly<{
    dataSet: Readonly<{ petState: ResolvedPetAnimationFrame['state'] }>;
    'data-pet-state': ResolvedPetAnimationFrame['state'];
}>;

export type PetSpriteProps = Readonly<{
    frame: ResolvedPetAnimationFrame;
    spritesheetSource?: ImageProps['source'];
    scale?: number;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

export function PetSprite(props: PetSpriteProps): React.ReactElement {
    const scale = typeof props.scale === 'number' && Number.isFinite(props.scale) && props.scale > 0
        ? props.scale
        : 1;
    const rootStyle = {
        width: props.frame.cellWidth * scale,
        height: props.frame.cellHeight * scale,
        backgroundColor: 'transparent',
        overflow: 'hidden',
    } satisfies ViewStyle;

    const dataProps: PetSpriteDataProps = {
        testID: props.testID ?? 'pet-companion-sprite',
        dataSet: { petState: props.frame.state },
        'data-pet-state': props.frame.state,
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
        style: props.style ? [rootStyle, props.style] : rootStyle,
    };
    const imageStyle = {
        width: PET_ATLAS_V1.width * scale,
        height: PET_ATLAS_V1.height * scale,
        backgroundColor: 'transparent',
        transform: [
            { translateX: -(props.frame.frame * props.frame.cellWidth * scale) },
            { translateY: -(props.frame.row * props.frame.cellHeight * scale) },
        ],
        ...(Platform.OS === 'web' ? { imageRendering: 'pixelated' as const } : {}),
    };

    return (
        <View {...dataProps}>
            {props.spritesheetSource ? (
                <Image
                    source={props.spritesheetSource}
                    contentFit="fill"
                    pointerEvents="none"
                    style={imageStyle}
                />
            ) : (
                <View
                    style={[
                        {
                            width: props.frame.cellWidth * scale,
                            height: props.frame.cellHeight * scale,
                            backgroundColor: 'transparent',
                        },
                        props.style,
                    ]}
                />
            )}
        </View>
    );
}
