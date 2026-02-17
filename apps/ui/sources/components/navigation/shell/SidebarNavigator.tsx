import { useAuth } from '@/auth/context/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useIsTablet } from '@/utils/platform/responsive';
import { SidebarView } from './SidebarView';
import { CollapsedSidebarView } from './CollapsedSidebarView';
import { Pressable, View, useWindowDimensions, Platform } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { SidebarExpandIcon } from './SidebarIcons';

export const SidebarNavigator = React.memo(() => {
    const auth = useAuth();
    const isTablet = useIsTablet();
    const showPermanentDrawer = auth.isAuthenticated && isTablet;
    const { width: windowWidth } = useWindowDimensions();
    const sidebarCollapsed = useLocalSetting('sidebarCollapsed');
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');

    // Calculate drawer width only when needed
    const drawerWidth = React.useMemo(() => {
        if (!showPermanentDrawer) return 280; // Default width for hidden drawer
        if (sidebarCollapsed) return 72;
        return Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
    }, [windowWidth, showPermanentDrawer, sidebarCollapsed]);

    const drawerNavigationOptions = React.useMemo(() => {
        if (!showPermanentDrawer) {
            // When drawer is hidden, use minimal configuration
            return {
                lazy: false,
                headerShown: false,
                drawerType: 'front' as const,
                swipeEnabled: false,
                drawerStyle: {
                    width: 0,
                    display: 'none' as const,
                },
            };
        }
        
        // When drawer is permanent
        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: {
                backgroundColor: 'white',
                borderRightWidth: 0,
                width: drawerWidth,
            },
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [showPermanentDrawer, drawerWidth]);

    // Always render SidebarView but hide it when not needed
    const drawerContent = React.useCallback(
        () => {
            if (sidebarCollapsed) {
                return <CollapsedSidebarView />;
            }
            return (
                <View style={{ flex: 1 }}>
                    <SidebarView />
                    {Platform.OS === 'web' ? (
                        <Pressable
                            testID="sidebar-collapse-button"
                            onPress={() => setSidebarCollapsed(true)}
                            style={{
                                position: 'absolute',
                                top: 12,
                                right: -24,
                                width: 28,
                                height: 28,
                                borderRadius: 8,
                                opacity: 0.7,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                            accessibilityRole="button"
                        >
                            <SidebarExpandIcon />
                        </Pressable>
                    ) : null}
                </View>
            );
        },
        [sidebarCollapsed, setSidebarCollapsed]
    );

    return (
        <Drawer
            screenOptions={drawerNavigationOptions}
            drawerContent={showPermanentDrawer ? drawerContent : undefined}
        />
    )
});
