import * as React from 'react';
import { View, Platform, StatusBar, Pressable } from 'react-native';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { useLayoutMaxWidth } from '../ui/layout/layout';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { shadowLevelStyle } from '@/shadowElevation';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { Icon } from '@/components/ui/icons/Icon';


interface HeaderProps {
    title?: React.ReactNode;
    subtitle?: string;
    headerLeft?: (() => React.ReactNode) | null;
    headerRight?: (() => React.ReactNode) | null;
    headerStyle?: any;
    headerTitleStyle?: any;
    headerSubtitleStyle?: any;
    headerTintColor?: string;
    headerBackgroundColor?: string;
    headerShadowVisible?: boolean;
    headerTransparent?: boolean;
    safeAreaEnabled?: boolean;
}

export const Header = React.memo((props: HeaderProps) => {
    const styles = stylesheet;
    const maxWidth = useLayoutMaxWidth();

    const {
        title,
        subtitle,
        headerLeft,
        headerRight,
        headerStyle,
        headerTitleStyle,
        headerSubtitleStyle,
        headerTintColor, // Accept but ignore - using theme instead
        headerBackgroundColor, // Accept but ignore - using theme instead
        headerShadowVisible = true,
        headerTransparent = false,
        safeAreaEnabled = true,
    } = props;

    const insets = useChromeSafeAreaInsets();
    const paddingTop = safeAreaEnabled ? insets.top : 0;
    const headerHeight = useHeaderHeight();
    const desktopDragProps = useDesktopWindowDragMouseProps();

    const containerStyle = [
        styles.container,
        headerTransparent && styles.containerTransparent,
        !headerTransparent && styles.containerNormal,
        {
            minHeight: headerHeight + paddingTop,
            paddingTop,
        },
        headerShadowVisible && styles.shadow,
        headerStyle,
    ];

    const subtitleStyle = [
        styles.subtitle,
        headerSubtitleStyle,
    ];

    return (
        <View
            {...desktopDragProps}
            testID="desktop-route-header-drag-region"
            style={containerStyle}
        >
            <View
                testID="desktop-route-header-content-wrapper"
                pointerEvents="box-none"
                style={styles.contentWrapper}
            >
                <View
                    testID="desktop-route-header-content"
                    pointerEvents="box-none"
                    style={[styles.content, { height: headerHeight, maxWidth }]}
                >
                    <View pointerEvents="box-none" style={styles.leftContainer}>
                        {headerLeft && headerLeft()}
                    </View>

                    <View
                        testID="desktop-route-header-center"
                        pointerEvents="box-none"
                        style={styles.centerContainer}
                    >
                        {title}
                        {subtitle && <Text style={subtitleStyle} numberOfLines={1}>{subtitle}</Text>}
                    </View>

                    <View pointerEvents="box-none" style={styles.rightContainer}>
                        {headerRight && headerRight()}
                    </View>
                </View>
            </View>
        </View>
    );
});

// Extended navigation options to support subtitle
interface ExtendedNavigationOptions extends Partial<NativeStackHeaderProps['options']> {
    headerSubtitle?: string;
    headerSubtitleStyle?: any;
}

// Default back button component
const DefaultBackButton: React.FC<{ tintColor?: string; onPress: () => void }> = ({ tintColor = '#000', onPress }) => {
    return (
        <Pressable onPress={onPress} hitSlop={15} accessibilityRole="button">
            <Icon
                name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                size={24}
                color={tintColor}
            />
        </Pressable>
    );
};

// Component wrapper for navigation header
const NavigationHeaderComponent: React.FC<NativeStackHeaderProps> = React.memo((props) => {
    const { options, route, back, navigation } = props;
    const extendedOptions = options as ExtendedNavigationOptions;

    // Extract title - handle both string and function types
    let title: React.ReactNode | null = null;
    if (options.headerTitle) {
        if (typeof options.headerTitle === 'string') {
            title = (
                <Text style={[
                    { fontSize: 16, textAlign: Platform.OS === 'ios' ? 'center' : 'left', color: options.headerTintColor || '#000' },
                    Typography.default('semiBold'),
                    options.headerTitleStyle
                ]}>
                    {options.headerTitle}
                </Text>
            );
        } else if (typeof options.headerTitle === 'function') {
            // Handle function type headerTitle
            title = options.headerTitle({ children: route.name, tintColor: options.headerTintColor });
        }
    } else if (typeof options.title === 'string') {
        title = (
            <Text style={[
                { fontSize: 16, textAlign: Platform.OS === 'ios' ? 'center' : 'left', color: options.headerTintColor || '#000' },
                Typography.default('semiBold'),
                options.headerTitleStyle
            ]}>
                {options.title}
            </Text>
        );
    }

    // Determine header left content
    let headerLeftContent: (() => React.ReactNode) | undefined | null = null;
    if (options.headerLeft) {
        // Use custom headerLeft if provided
        headerLeftContent = () => options.headerLeft!({ canGoBack: !!back, tintColor: options.headerTintColor });
    } else if (back && options.headerBackVisible !== false) {
        // Show default back button if can go back and not explicitly hidden
        headerLeftContent = () => (
            <DefaultBackButton
                tintColor={options.headerTintColor}
                onPress={() => navigation.goBack()}
            />
        );
    }

    return (
        <Header
            title={title}
            subtitle={extendedOptions.headerSubtitle}
            headerLeft={headerLeftContent}
            headerRight={options.headerRight ?
                () => options.headerRight!({ canGoBack: !!back, tintColor: options.headerTintColor }) :
                undefined
            }
            headerStyle={options.headerStyle}
            headerTitleStyle={options.headerTitleStyle}
            headerSubtitleStyle={extendedOptions.headerSubtitleStyle}
            headerShadowVisible={options.headerShadowVisible}
            headerTransparent={options.headerTransparent}
        />
    );
});

// Export a render function for React Navigation
export const createHeader = (props: NativeStackHeaderProps) => {
    if (props.options.headerShown === false) {
        return null;
    }
    return <NavigationHeaderComponent {...props} />;
};

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    containerTransparent: {
        backgroundColor: 'transparent',
    },
    containerNormal: {
        backgroundColor: theme.colors.chrome.header.background,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
        position: 'relative',
        zIndex: 1,
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.select({ ios: 8, default: 16 }),
        width: '100%',
    },
    leftContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-start',
    },
    centerContainer: {
        flexGrow: 1,
        flexBasis: 0,
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: Platform.OS === 'ios' ? 'center' : 'flex-start',
        paddingHorizontal: 12,
    },
    rightContainer: {
        flexGrow: 0,
        flexShrink: 0,
        alignItems: 'flex-end',
    },
    title: {
        fontSize: 16,
        textAlign: 'center',
        color: theme.colors.chrome.header.foreground,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 13,
        fontWeight: '400',
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        marginTop: 2,
        color: theme.colors.chrome.header.foreground,
        ...Typography.default('regular'),
    },
    shadow: {
        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
    },
    backButton: {
        color: theme.colors.chrome.header.foreground,
    },
}));
