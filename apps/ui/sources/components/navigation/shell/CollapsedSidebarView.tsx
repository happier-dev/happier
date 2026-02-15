import * as React from 'react';
import { Pressable, View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.divider,
        paddingTop: 12,
        paddingHorizontal: 8,
        gap: 8,
    },
    button: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 40,
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    buttonText: {
        color: theme.colors.text,
        fontSize: 12,
    },
}));

export const CollapsedSidebarView = React.memo(() => {
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');

    return (
        <View style={styles.container}>
            <Pressable
                testID="sidebar-expand-button"
                onPress={() => setSidebarCollapsed(false)}
                style={styles.button}
                accessibilityRole="button"
            >
                <Text style={styles.buttonText}>{'>'}</Text>
            </Pressable>
        </View>
    );
});
