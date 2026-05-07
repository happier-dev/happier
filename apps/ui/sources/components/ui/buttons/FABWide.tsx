import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';


const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        left: 16,
        right: 16,
    },
    button: {
        borderRadius: 12,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
        alignItems: 'center',
        justifyContent: 'center',
    },
    surface: {
        width: '100%',
        paddingVertical: 12,
        paddingHorizontal: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    text: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
    },
}));

export const FABWide = React.memo(({ onPress }: { onPress: () => void }) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    return (
        <View
            style={[
                styles.container,
                { bottom: safeArea.bottom + 16 }
            ]}
        >
            <Pressable
                style={styles.button}
                onPress={onPress}
            >
                {({ pressed }) => (
                    <GradientSurface
                        fallbackColor={pressed ? theme.colors.fab.backgroundPressed : theme.colors.fab.background}
                        gradient={pressed ? undefined : theme.colors.fab.gradient}
                        borderRadius={12}
                        style={styles.surface}
                    >
                        <Text style={styles.text}>{t('newSession.title')}</Text>
                    </GradientSurface>
                )}
            </Pressable>
        </View>
    )
});
