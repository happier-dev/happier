import * as React from 'react';
import { PixelRatio, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { Image, type ImageProps } from 'expo-image';

import type { ResolvedPetAnimationFrame } from '@/components/pets/animation/resolvePetAnimationTimeline';
import { playBotFaceSteps, type BotFaceSteps } from '@/components/sessions/bots/face/botFaceSteps';
import { useHostActivelyViewedLayoutEffect } from '@/utils/runtime/useHostActivelyViewed';

import { petSpriteLayout, type PetSpriteCell, type PetSpriteFit } from './petSpriteGeometry';

type PetSpriteDataProps = ViewProps & Readonly<{
    dataSet: Readonly<{ petState: ResolvedPetAnimationFrame['state'] }>;
    'data-pet-state': ResolvedPetAnimationFrame['state'];
}>;

/**
 * A row played on the compositor: step k shows `cells[k]` (the Bot face's stepped timing, offset track). A finite
 * track hands back to `frame` and calls `onFinish`; one that cannot play (nobody viewing the app) finishes at once.
 */
export type PetSpriteTrack = Readonly<{
    steps: BotFaceSteps;
    cells: readonly PetSpriteCell[];
    onFinish?: () => void;
}>;

export type PetSpriteProps = Readonly<{
    frame: ResolvedPetAnimationFrame;
    spriteVersionNumber?: 1 | 2;
    spritesheetSource?: ImageProps['source'];
    scale?: number;
    /** A Bot face's square box: the pet's opaque bounds fitted whole, centred (replaces `scale`). */
    fit?: PetSpriteFit;
    track?: PetSpriteTrack | null;
    monochrome?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const translate = (offset: Readonly<{ x: number; y: number }>) => `translate(${offset.x}px, ${offset.y}px)`;

/**
 * One pet cell drawn from its atlas: the atlas sits behind a window and moves by whole device pixels. Sampling is smooth
 * (the built-ins are drawn at the atlas' own pixel, so every size is a downscale).
 */
export function PetSprite(props: PetSpriteProps): React.ReactElement {
    const { cellWidth, cellHeight } = props.frame;
    const box = props.fit?.box;
    const bounds = props.fit?.bounds;
    const layout = React.useMemo(
        () => petSpriteLayout({ cellWidth, cellHeight, spriteVersionNumber: props.spriteVersionNumber, scale: props.scale, fit: box === undefined ? undefined : { box, bounds }, dpr: PixelRatio.get() }),
        [cellWidth, cellHeight, props.spriteVersionNumber, props.scale, box, bounds],
    );
    const still = layout.offset(props.frame);
    const atlas = React.useRef<View>(null);
    const { track } = props;
    useHostActivelyViewedLayoutEffect((viewed) => {
        if (!track) return;
        const finite = track.steps.iterations !== Infinity;
        const animation = viewed
            ? playBotFaceSteps(atlas.current, track.steps, step => ({ transform: translate(layout.offset(track.cells[step] ?? track.cells[0]!)) }), track.onFinish)
            : null;
        if (!animation && finite) track.onFinish?.();
        return () => {
            if (!animation) return;
            animation.onfinish = null;
            animation.cancel();
        };
    }, [track, layout]);

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
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
        style: props.style ? [rootStyle, props.style] : rootStyle,
    };

    return (
        <View {...dataProps}>
            {props.spritesheetSource ? (
                <View
                    pointerEvents="none"
                    style={{
                        position: 'absolute',
                        ...layout.clip,
                        overflow: 'hidden',
                        ...(props.monochrome ? { filter: 'grayscale(1)' } : {}),
                    }}
                >
                    <View
                        ref={atlas}
                        style={{
                            width: layout.atlasWidth,
                            height: layout.atlasHeight,
                            transform: [{ translateX: still.x }, { translateY: still.y }],
                        }}
                    >
                        <Image
                            source={props.spritesheetSource}
                            contentFit="fill"
                            pointerEvents="none"
                            style={{ width: layout.atlasWidth, height: layout.atlasHeight, backgroundColor: 'transparent' }}
                        />
                    </View>
                </View>
            ) : null}
        </View>
    );
}
