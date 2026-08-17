import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { HappierSurface } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';

type SurfaceCardTone = 'surface' | 'muted';
type SurfaceCardPadding = 'none' | 'sm' | 'md' | 'lg';

type SurfaceCardProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    onPress?: () => void;
    tone?: SurfaceCardTone;
    padding?: SurfaceCardPadding;
    style?: StyleProp<ViewStyle>;
}>;

const styles = StyleSheet.create((theme) => {
    const surfaceBorderStyle = resolveThemeSurfaceBorderStyle({
        borderColor: theme.colors.border.surface,
        highlightColor: theme.colors.effect.surfaceHighlight,
    });
    const hasVisibleSurfaceChrome = surfaceBorderStyle.borderWidth > 0 || surfaceBorderStyle.borderTopWidth > 0;

    return {
        cardBase: {
            width: '100%',
            minWidth: 0,
            borderRadius: Platform.select({ ios: 10, default: 16 }),
            backgroundColor: theme.colors.surface.base,
            ...surfaceBorderStyle,
            ...(hasVisibleSurfaceChrome ? shadowLevelStyle(theme.colors.shadowLevels[1]) : {}),
        },
        toneMuted: {
            backgroundColor: theme.colors.surface.inset,
        },
        paddingSm: {
            paddingHorizontal: 14,
            paddingVertical: 12,
        },
        paddingMd: {
            paddingHorizontal: 18,
            paddingVertical: 16,
        },
        paddingLg: {
            paddingHorizontal: 22,
            paddingVertical: 20,
        },
        pressable: {
            width: '100%',
            borderRadius: Platform.select({ ios: 10, default: 16 }),
        },
        pressablePressed: {
            opacity: 0.985,
        },
    };
});

function resolvePaddingStyle(padding: SurfaceCardPadding): StyleProp<ViewStyle> {
    if (padding === 'none') {
        return undefined;
    }
    if (padding === 'sm') {
        return styles.paddingSm;
    }
    if (padding === 'lg') {
        return styles.paddingLg;
    }
    return styles.paddingMd;
}

export const SurfaceCard = React.memo(function SurfaceCard(props: SurfaceCardProps) {
    const {
        children,
        testID,
        onPress,
        tone = 'surface',
        padding = 'md',
        style,
    } = props;

    const content = (
        <View
            style={[
                styles.cardBase,
                tone === 'muted' ? styles.toneMuted : null,
                resolvePaddingStyle(padding),
                style,
            ]}
        >
            {children}
        </View>
    );

    return (
        <HappierSurface
            testID={testID}
            onPress={onPress}
            pressableStyle={styles.pressable}
            pressedStyle={styles.pressablePressed}
        >
            {content}
        </HappierSurface>
    );
});
