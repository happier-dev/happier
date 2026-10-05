import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { Theme } from '@/theme';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

import { TranscriptJumpAttention } from './navigation/TranscriptJumpHighlightOverlay';

/** The live user bubble, also rendered at static props by appearance previews. */
export function UserMessageBubble(props: Readonly<{
    theme?: Theme;
    discarded?: boolean;
    attention?: Pick<React.ComponentProps<typeof TranscriptJumpAttention>, 'sessionAddress' | 'routeMessageId' | 'seq' | 'radius'>;
    children: React.ReactNode;
}>) {
    const { theme: currentTheme } = useUnistyles();
    const theme = props.theme ?? currentTheme;
    const style = {
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.message.user.background, 'content', true),
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: theme.parts.userBubble.radius,
        maxWidth: '100%' as const,
        ...(props.discarded ? { opacity: 0.65 } : null),
    };
    return props.attention
        ? <TranscriptJumpAttention {...props.attention} style={style}>{props.children}</TranscriptJumpAttention>
        : <View style={style}>{props.children}</View>;
}
