import * as React from 'react';
import { t } from '@/text';
import { View, Platform, StatusBar, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { useLayoutMaxWidth } from '../ui/layout/layout';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { shadowLevelStyle } from '@/shadowElevation';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { Icon } from '@/components/ui/icons/Icon';
import { HEADER_BAND_SUBTITLE_TEXT } from '@/components/ui/layout/headerBand';
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
    const leading = headerLeft ? headerLeft() : null;
    const hasLeading = leading !== null && leading !== undefined && leading !== false;

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
                    {hasLeading ? (
                        <View pointerEvents="box-none" style={styles.leftContainer}>
                            {leading}
                        </View>
                    ) : null}

                    <View
                        testID="desktop-route-header-center"
                        pointerEvents="box-none"
                        style={[styles.centerContainer, !hasLeading && styles.centerContainerAtPageEdge]}
                    >
                        {subtitle ? (
                            <View testID="desktop-route-header-title-stack" style={styles.titleStack}>
                                {title}
                                <Text style={subtitleStyle} numberOfLines={1}>{subtitle}</Text>
                            </View>
                        ) : title}
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
// The one Back of a phone's navigation bar: every page's glyph and the title after it sit on the same lines.
export const DefaultBackButton: React.FC<{ tintColor?: string; onPress: () => void; testID?: string; label?: string; accessibilityLabel?: string }> = ({ tintColor = '#000', onPress, testID, label, accessibilityLabel }) => {
    const styles = stylesheet;
    return (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? t('common.back')} testID={testID} style={styles.backButtonTarget}>
            <Icon
                name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                size={24}
                color={tintColor}
            />
            {label ? <Text numberOfLines={1} style={[Typography.variant('reading'), styles.backButtonLabel, { color: tintColor }]}>{label}</Text> : null}
        </Pressable>
    );
};

// Component wrapper for navigation header
export function NavigationHeaderTitle(props: Readonly<{ title: string; tintColor?: string; style?: NativeStackHeaderProps['options']['headerTitleStyle'] }>) {
    return <Text numberOfLines={1} ellipsizeMode="tail" style={[
        { textAlign: Platform.OS === 'ios' ? 'center' : 'left', color: props.tintColor || '#000', flexShrink: 1, minWidth: 0 },
        Typography.variant('heading'), props.style,
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
 * The trailing actions a route put in its stack header, where that header is not drawn: handed to the page's
 * own header (`PageHeader` claims them), or, on a page without one, kept in a slim actions-only bar
 * so nothing a route offers is lost.
 */
const ShellPageHeaderActions = React.memo(function ShellPageHeaderActions(props: NativeStackHeaderProps) {
    const { headerRight, headerTintColor } = props.options;
    const canGoBack = Boolean(props.back);
    // Only the trailing actions are lent. `headerLeft` is the undrawn header's way back; in the shell the page
    // header's Back, the rail and the history arrows are that way, so lending it would add a second Back.
    const render = React.useMemo(() => {
        if (!headerRight) return null;
        return () => headerRight({ tintColor: headerTintColor, canGoBack }) ?? null;
    }, [canGoBack, headerRight, headerTintColor]);
    return <PageHeaderActionsHost scopeKey={props.route.key} render={render} />;
});

/** Both stack and retained destinations lend actions through the same page-header owner. */
export function PageHeaderActionsHost(props: Readonly<{ scopeKey: string; render: (() => React.ReactNode) | null }>) {
    const styles = stylesheet;
    const { render } = props;
    useStackHeaderActionsPublisher(props.scopeKey, render);
    const claimed = useStackHeaderActionsClaimed(props.scopeKey);
    if (!render || claimed) return null;
    return <View testID="app-stack-header-actions" style={styles.shellActionsBar}>{render()}</View>;
}

// Export a render function for React Navigation
export const createHeader = (props: NativeStackHeaderProps) => {
    if (props.options.headerShown === false) {
        return null;
    }
    return <AppStackHeader {...props} />;
};

const HEADER_CONTENT_PADDING_PX = Platform.select({ ios: 8, default: 16 });

const stylesheet = StyleSheet.create((theme, runtime) => ({
    // The actions of a page with no page header, above it at the trailing edge, in no header chrome.
    shellActionsBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s8,
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
        paddingHorizontal: HEADER_CONTENT_PADDING_PX,
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
        paddingLeft: theme.space.s12,
        paddingRight: theme.space.s12,
    },
    // With nothing before it (a deep link with no Back), a leading-aligned title starts on the page's own
    // text edge, the line its purpose and sections start on, not a back button's width in.
    centerContainerAtPageEdge: Platform.OS === 'ios' ? {} : {
        paddingLeft: HAPPIER_PAGE_METRICS.pageTextInsetPx - HEADER_CONTENT_PADDING_PX,
    },
    // The page title is the page's identity; its trailing controls are secondary. They take what they
    // need up to three fifths of the bar (a page's one filled action, its overflow and a glyph chip
    // side by side) and shrink their own text beyond that, so a long control (a machine name) never
    // squeezes the title down to its first letters.
    rightContainer: {
        flexGrow: 0,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '60%',
        alignItems: 'flex-end',
    },
    title: {
        ...Typography.variant('heading'),
        textAlign: 'center',
        color: theme.colors.chrome.header.foreground,
    },
    // A name with its qualifier under it (a Project and its repository): one stack, the name above.
    titleStack: {
        flexShrink: 1,
        minWidth: 0,
        alignItems: Platform.OS === 'ios' ? 'center' : 'flex-start',
    },
    subtitle: {
        ...HEADER_BAND_SUBTITLE_TEXT,
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        color: theme.colors.text.secondary,
    },
    shadow: {
        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
    },
    backButton: {
        color: theme.colors.chrome.header.foreground,
    },
    // A finger-sized target whose glyph still starts on the bar's edge: the padding is taken back in margin.
    backButtonTarget: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.space.s8,
        margin: -theme.space.s8,
    },
    backButtonLabel: {
        marginLeft: theme.space.s4,
        flexShrink: 1,
    },
}));
