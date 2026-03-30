import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { shadowLevelForSheet } from '@/shadowElevation';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';


const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        left: 16,
        right: 16,
    },
    button: {
        borderRadius: 12,
        paddingVertical: 16,
        paddingHorizontal: 20,
        ...shadowLevelForSheet(theme.colors.shadowLevels[4]),
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonDefault: {
        backgroundColor: theme.colors.fab.background,
    },
    buttonPressed: {
        backgroundColor: theme.colors.fab.backgroundPressed,
    },
    text: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.fab.icon,
    },
}));

export const FABWide = React.memo(({ onPress }: { onPress: () => void }) => {
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
                style={({ pressed }) => [
                    styles.button,
                    pressed ? styles.buttonPressed : styles.buttonDefault
                ]}
                onPress={onPress}
            >
                <Text style={styles.text}>{t('newSession.title')}</Text>
            </Pressable>
        </View>
    )
});