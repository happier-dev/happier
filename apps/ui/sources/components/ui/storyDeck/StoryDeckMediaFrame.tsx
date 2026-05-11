import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { shadowLevelStyle } from '@/shadowElevation';

/**
 * Square media frame replicating Notelet visuals:
 *   - fills the card width inside the same 30px inset as the text
 *   - rounded corners (modalCard token)
 *   - soft shadow
 *   - clipped overflow so cover-cropped media stays inside the frame
 */
const MEDIA_MIN_WIDTH = 300;
const MEDIA_HORIZONTAL_PADDING_PX = 30;
const MEDIA_TOP_PADDING_PX = 30;
const MEDIA_BOTTOM_PADDING_PX = 0;

export type StoryDeckMediaFrameProps = Readonly<{
    children: React.ReactNode;
    containerWidth: number;
    maxSize?: number;
    horizontalPadding?: number;
    topPadding?: number;
    bottomPadding?: number;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        alignSelf: 'stretch',
        paddingHorizontal: MEDIA_HORIZONTAL_PADDING_PX,
        paddingTop: MEDIA_TOP_PADDING_PX,
        paddingBottom: MEDIA_BOTTOM_PADDING_PX,
    },
    frame: {
        borderRadius: theme.borderRadius.modalCard,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.inset,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
}));

export function clampMediaSize(containerWidth: number, maxWidth?: number, horizontalPadding = MEDIA_HORIZONTAL_PADDING_PX): number {
    const effectiveMaxWidth = maxWidth ?? Math.max(containerWidth, MEDIA_MIN_WIDTH);
    const clamped = Math.min(Math.max(containerWidth, MEDIA_MIN_WIDTH), effectiveMaxWidth);
    return Math.max(0, clamped - horizontalPadding * 2);
}

export function StoryDeckMediaFrame(props: StoryDeckMediaFrameProps) {
    useUnistyles();
    const styles = stylesheet;
    const horizontalPadding = props.horizontalPadding ?? MEDIA_HORIZONTAL_PADDING_PX;
    const topPadding = props.topPadding ?? MEDIA_TOP_PADDING_PX;
    const bottomPadding = props.bottomPadding ?? MEDIA_BOTTOM_PADDING_PX;
    const size = clampMediaSize(props.containerWidth, props.maxSize, horizontalPadding);

    return (
        <View
            style={[
                styles.container,
                {
                    paddingHorizontal: horizontalPadding,
                    paddingTop: topPadding,
                    paddingBottom: bottomPadding,
                },
            ]}
            testID={props.testID}
        >
            <View style={[styles.frame, { width: size, height: size }]}>
                {props.children}
            </View>
        </View>
    );
}
