import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { SidebarCollapseIcon } from './SidebarIcons';

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
        marginTop: 8
    },
}));

export const CollapsedSidebarView = React.memo(() => {
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');

    return (
        <View style={styles.container}>
            {Platform.OS === 'web' ? (
                <Pressable
                    testID="sidebar-expand-button"
                    onPress={() => setSidebarCollapsed(false)}
                    style={styles.button}
                    accessibilityRole="button"
                >
                    <SidebarCollapseIcon />
                </Pressable>
            ) : null}
        </View>
    );
});
