import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { shadowLevelStyle } from '@/shadowElevation';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';
import { Icon } from '@/components/ui/icons/Icon';

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
    const styles = stylesheet;
    const safeArea = useChromeSafeAreaInsets();
    return (
        <View
            style={[
                styles.container,
                { bottom: safeArea.bottom + 16 }
            ]}
        >
            <Pressable
                style={styles.button}
                onPress={props.onPress}
                accessibilityRole="button"
                accessibilityLabel={props.accessibilityLabel}
            >
                {({ pressed }) => (
                    <GradientSurface
                        fallbackColor={pressed ? theme.colors.fab.backgroundPressed : theme.colors.fab.background}
                        gradient={pressed ? undefined : theme.colors.fab.gradient}
                        borderRadius={20}
                        style={styles.surface}
                    >
                        <Icon name="plus" size={24} color={theme.colors.fab.icon} />
                    </GradientSurface>
                )}
            </Pressable>
        </View>
    )
});
