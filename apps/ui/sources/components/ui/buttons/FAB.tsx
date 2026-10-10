import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable, happierMaterialGradient, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { shadowLevelStyle } from '@/shadowElevation';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        right: 16,
    },
    button: {
        borderRadius: 20,
        width: 56,
        height: 56,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
        alignItems: 'center',
        justifyContent: 'center',
    },
    surface: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export const FAB = React.memo((props: { onPress: () => void; accessibilityLabel?: string }) => {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const styles = stylesheet;
    const safeArea = useChromeSafeAreaInsets();
    return (
        <View
            style={[
                styles.container,
                { bottom: safeArea.bottom + 16 }
            ]}
        >
            <HappierPressable
                style={styles.button}
                onPress={() => { props.onPress(); }}
                accessibilityRole="button"
                accessibilityLabel={props.accessibilityLabel}
            >
                {({ pressed, focused }) => (
                    <GradientSurface
                        fallbackColor={paintColor(pressed ? theme.colors.fab.backgroundPressed : theme.colors.fab.background)}
                        gradient={pressed ? undefined : happierMaterialGradient(theme.colors.fab.gradient, paintColor)}
                        overlay={resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed, focused })}
                        clipToPaddingBox={!theme.dark}
                        borderRadius={20}
                        style={styles.surface}
                    >
                        <Icon name="plus" size={24} color={paintColor(theme.colors.fab.icon, theme.colors.text.primary)} />
                    </GradientSurface>
                )}
            </HappierPressable>
        </View>
    )
});
