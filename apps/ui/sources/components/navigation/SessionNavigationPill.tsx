import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Typography } from '@/constants/Typography';
import type { ShadowLevel } from '@/shadowElevation';

/** Shared capsule and row geometry for the switcher's Stay and pending-request Next. */
export function SessionNavigationPill(props: Readonly<{
    children: React.ReactNode;
    attention?: boolean;
    /** The capsule's row when it rides above a composer rather than the phone bar (its own height and insets). */
    rowStyle?: StyleProp<ViewStyle>;
    radius?: number;
    shadowLevel?: ShadowLevel;
    /** How the capsule sizes in its parent (e.g. `maxWidth: '100%'` so a long row can give way). */
    frameStyle?: StyleProp<ViewStyle>;
}>) {
    const { theme } = useUnistyles();
    return (
        <GlassPanel
            surfaceColor={props.attention ? theme.colors.state.warning.background : theme.colors.surface.base}
            radius={props.radius}
            shadowLevel={props.shadowLevel}
            frameStyle={props.frameStyle}
        >
            <View style={[sessionNavigationPillStyles.row, props.rowStyle]}>{props.children}</View>
        </GlassPanel>
    );
}

export const sessionNavigationPillStyles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingHorizontal: 18, minHeight: 48,
    },
    label: { fontSize: 14, color: theme.colors.text.secondary, ...Typography.default() },
    title: { flexShrink: 1, fontSize: 14, color: theme.colors.text.primary, ...Typography.default('semiBold') },
}));
