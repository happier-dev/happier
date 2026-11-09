import * as React from 'react';
import { View, type ViewProps, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { glassContentFill } from '@/components/ui/glass/glassSurfacePaint';

import type { Theme } from '@/theme';

import { TranscriptJumpAttention } from './navigation/TranscriptJumpHighlightOverlay';

/**
 * The widest a person's prompt reads, as a share of the reading column: a right-aligned
 * silhouette that stays recognisable beside unboxed agent text, even for long prompts.
 */
export const USER_MESSAGE_BUBBLE_MAX_WIDTH = '82%' as const;

/**
 * Hugs and right-aligns the bubble inside a full-width row. Committed and queued prompts share it, so
 * both resolve their width against the same reading column. The bubble stays a default-stretch child
 * of this aligner so native text wraps at the bounded width instead of measuring at max-content.
 */
export const userMessageBubbleAlignerStyle = {
    alignSelf: 'flex-end',
    maxWidth: USER_MESSAGE_BUBBLE_MAX_WIDTH,
} as const satisfies ViewStyle;

/** The bubble's inner padding; a consumer whose parts own the padding (a press target that fills the bubble) applies it to them. */
export function userMessageBubbleContentPadding(theme: Theme) {
    return { paddingHorizontal: 14, paddingVertical: theme.space.s8 } as const satisfies ViewStyle;
}

/**
 * The live user bubble (committed and queued), also rendered at static props by appearance previews.
 * Its fill alone marks the prompt: no hairline and no rim (those are for what floats). Solid, it is its own
 * fill. Over glass content it takes the material's inner translucent fill (the ink tint inner surfaces use),
 * so the prompt keeps its step over the picture instead of inheriting the page plane, which a picture clears.
 */
export function UserMessageBubble(props: Readonly<{
    theme?: Theme;
    discarded?: boolean;
    /** `parts`: the children carry `userMessageBubbleContentPadding` themselves (e.g. a press target that fills the bubble). */
    padding?: 'surface' | 'parts';
    /** Measures the painted surface, padding included. */
    onLayout?: ViewProps['onLayout'];
    attention?: Pick<React.ComponentProps<typeof TranscriptJumpAttention>, 'sessionAddress' | 'routeMessageId' | 'seq' | 'radius'>;
    testID?: string;
    children: React.ReactNode;
}>) {
    const { theme: currentTheme } = useUnistyles();
    const theme = props.theme ?? currentTheme;
    const style = {
        backgroundColor: glassContentFill(theme.colors.message.user.background, theme.colors),
        ...(props.padding === 'parts' ? null : userMessageBubbleContentPadding(theme)),
        borderRadius: theme.parts.userBubble.radius,
        maxWidth: '100%' as const,
        ...(props.discarded ? { opacity: 0.65 } : null),
    };
    return props.attention
        ? (
            <TranscriptJumpAttention {...props.attention} style={style} viewProps={{ onLayout: props.onLayout, testID: props.testID }}>
                {props.children}
            </TranscriptJumpAttention>
        )
        : <View style={style} onLayout={props.onLayout} testID={props.testID}>{props.children}</View>;
}
