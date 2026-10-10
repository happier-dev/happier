import * as React from 'react';
import { t } from '@/text';
import { View, Platform, StatusBar, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { useLayoutMaxWidth } from '../ui/layout/layout';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { shadowLevelStyle } from '@/shadowElevation';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { Icon } from '@/components/ui/icons/Icon';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { useStackHeaderActionsClaimed, useStackHeaderActionsPublisher } from '@/components/navigation/stackHeaderActions';


interface HeaderProps {
    title?: React.ReactNode;
    subtitle?: string;
    headerLeft?: (() => React.ReactNode) | null;
    headerRight?: (() => React.ReactNode) | null;
    headerStyle?: any;
    headerContentStyle?: StyleProp<ViewStyle>;
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
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const maxWidth = useLayoutMaxWidth();

    const {
        title,
        subtitle,
        headerLeft,
        headerRight,
        headerStyle,
        headerContentStyle,
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
        !headerTransparent && { backgroundColor: materialColor(theme.colors.chrome.header.background, 'transparent') },
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
                    style={[styles.content, { height: headerHeight, maxWidth }, headerContentStyle]}
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

// Default back button component; also the explicit back of a route whose stack reports no `back`.
export const DefaultBackButton: React.FC<{ tintColor?: string; onPress: () => void; testID?: string }> = ({ tintColor = '#000', onPress, testID }) => {
    return (
        <Pressable onPress={onPress} hitSlop={15} accessibilityRole="button" accessibilityLabel={t('common.back')} testID={testID}>
            <Icon
                name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                size={24}
                color={tintColor}
            />
        </Pressable>
    );
};

// Component wrapper for navigation header
export function NavigationHeaderTitle(props: Readonly<{ title: string; tintColor?: string; style?: NativeStackHeaderProps['options']['headerTitleStyle'] }>) {
    return <Text numberOfLines={1} ellipsizeMode="tail" style={[
        { fontSize: 16, textAlign: Platform.OS === 'ios' ? 'center' : 'left', color: props.tintColor || '#000', flexShrink: 1, minWidth: 0 },
        Typography.default('semiBold'), props.style,
    ]}>{props.title}</Text>;
}

const NavigationHeaderComponent: React.FC<NativeStackHeaderProps> = React.memo((props) => {
    const { options, route, back, navigation } = props;
    const extendedOptions = options as ExtendedNavigationOptions;

    // Extract title - handle both string and function types
    let title: React.ReactNode | null = null;
    if (options.headerTitle) {
        if (typeof options.headerTitle === 'string') {
            title = <NavigationHeaderTitle title={options.headerTitle} tintColor={options.headerTintColor} style={options.headerTitleStyle} />;
        } else if (typeof options.headerTitle === 'function') {
            // Handle function type headerTitle
            title = options.headerTitle({ children: route.name, tintColor: options.headerTintColor });
        }
    } else if (typeof options.title === 'string') {
        title = <NavigationHeaderTitle title={options.title} tintColor={options.headerTintColor} style={options.headerTitleStyle} />;
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

/** Presentations that sit over the app rather than in it keep their own bar, shell or not. */
const OVERLAY_PRESENTATIONS: ReadonlySet<string> = new Set(['modal', 'transparentModal', 'containedModal', 'containedTransparentModal', 'fullScreenModal', 'formSheet']);

/**
 * The one rule for stack headers inside the desktop app shell (R1): a page there draws no stack
 * header. It renders its own page header, and the way back is the rail, the column and the title
 * strip's history arrows. Outside the shell (phones) the header and its back button stay. Modals keep
 * theirs everywhere.
 */
const AppStackHeader = React.memo(function AppStackHeader(props: NativeStackHeaderProps) {
    const shell = useAppShellColumn();
    const presentation = (props.options as { presentation?: string }).presentation;
    const hidden = shell.present && !(presentation && OVERLAY_PRESENTATIONS.has(presentation));
    return hidden ? <ShellPageHeaderActions {...props} /> : <NavigationHeaderComponent {...props} />;
});

/**
 * The actions a route put in its stack header, where that header is not drawn: handed to the page's
 * own header (`PageHeader` claims them), or, on a page without one, kept in a slim actions-only bar
 * so nothing a route offers is lost.
 */
const ShellPageHeaderActions = React.memo(function ShellPageHeaderActions(props: NativeStackHeaderProps) {
    const styles = stylesheet;
    const { headerLeft, headerRight, headerTintColor } = props.options;
    const canGoBack = Boolean(props.back);
    const render = React.useMemo(() => {
        if (!headerLeft && !headerRight) return null;
        return () => (
            <>
                {headerLeft?.({ tintColor: headerTintColor, canGoBack, label: undefined, href: undefined }) ?? null}
                {headerRight?.({ tintColor: headerTintColor, canGoBack }) ?? null}
            </>
        );
    }, [canGoBack, headerLeft, headerRight, headerTintColor]);
    useStackHeaderActionsPublisher(props.route.key, render);
    const claimed = useStackHeaderActionsClaimed(props.route.key);
    if (!render || claimed) return null;
    return <View testID="app-stack-header-actions" style={styles.shellActionsBar}>{render()}</View>;
});

// Export a render function for React Navigation
export const createHeader = (props: NativeStackHeaderProps) => {
    if (props.options.headerShown === false) {
        return null;
    }
    return <AppStackHeader {...props} />;
};

const stylesheet = StyleSheet.create((theme, runtime) => ({
    // The actions of a page with no page header, above it at the trailing edge, in no header chrome.
    shellActionsBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 8,
    },
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
        minWidth: 0,
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
