import * as React from 'react';
import { View, Platform, Pressable, type LayoutChangeEvent } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { AgentId } from '@/agents/registry/registryCore';
import { useSetting } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { Icon } from '@/components/ui/icons/Icon';


/** The gutter control's tap target, matching every other header action. */
const GUTTER_TAP_TARGET_PX = 44;

/** That tap target plus breathing room on both sides. */
const GUTTER_MIN_WIDTH_PX = 60;

/** The header's own horizontal inset — the margin every other control in it is measured from. */
const HEADER_HORIZONTAL_PADDING_PX = Platform.OS === 'ios' ? 8 : 16;

interface ChatHeaderViewProps {
    title: string;
    subtitle?: string;
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    onBackPress?: () => void;
    avatarId?: string;
    /** Resolved agent for this session, when there is one. Shown in place of the avatar on request. */
    agentId?: AgentId | null;
    rightElement?: React.ReactNode;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
    constrainWidth?: boolean;
    includeTopInset?: boolean;
    /**
     * Defaults to shown. Suppressed where a permanent sidebar is on screen: there is no stack to
     * pop back to, so the chevron is a control that does nothing but take the first slot in the
     * header. The share viewer has no sidebar and keeps it.
     */
    showBackButton?: boolean;
    /**
     * Rendered in the empty margin beside the width-constrained content when that margin is wide
     * enough to hold it, and appended to the trailing icons when it is not. For a control that acts
     * on something at the screen's edge — the right sidebar — sitting at that edge is what says so.
     */
    gutterElement?: React.ReactNode;
}

export const ChatHeaderView = React.memo(function ChatHeaderView({
    title,
    subtitle,
    subtitleEllipsizeMode = 'tail',
    badges,
    onBackPress,
    avatarId,
    agentId,
    rightElement,
    isConnected = true,
    flavor,
    constrainWidth = true,
    includeTopInset = true,
    showBackButton = true,
    gutterElement,
}: ChatHeaderViewProps): React.ReactElement {
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const insets = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const maxWidth = useLayoutMaxWidth();
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const backButtonTestId = resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-header-back');
    const avatarButtonTestId = resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-header-avatar');
    const shouldUseWebSubtitleStartEllipsis = subtitleEllipsizeMode === 'head' && Platform.OS === 'web';
    const identityMode = useSetting('sessionHeaderIdentityDisplay');

    // The header content is centred and width-capped, so on a wide window there is an empty margin
    // on each side. Measure the trailing one: if it can hold a 44pt control with air around it, the
    // gutter element goes there; otherwise it falls back into the icon row.
    const [wrapperWidth, setWrapperWidth] = React.useState(0);
    const handleWrapperLayout = React.useCallback((event: LayoutChangeEvent) => {
        setWrapperWidth(event.nativeEvent.layout.width);
    }, []);
    const trailingGutterWidth = constrainWidth && wrapperWidth > 0
        ? Math.max(0, (wrapperWidth - Math.min(wrapperWidth, maxWidth)) / 2)
        : 0;
    const gutterHoldsElement = gutterElement != null && trailingGutterWidth >= GUTTER_MIN_WIDTH_PX;
    // Half the leftover once the tap target is centred in `headerHeight` — which is also the gap the
    // control leaves above itself. Using it horizontally makes the icon's distance to the window's
    // top and right edges identical (this inset plus the icon's own centring inside the tap target),
    // so the control reads as sitting in the corner rather than pinned to one side of it. Raising it
    // to the header's content padding looks like more breathing room but breaks that symmetry.
    const cornerInset = Math.max(0, (headerHeight - GUTTER_TAP_TARGET_PX) / 2);
    // Which identity leads the header is the user's call. `agentLogo` with no resolvable agent
    // renders nothing rather than silently falling back to the avatar — that would answer a question
    // the user already answered.
    const leadingIdentity = React.useMemo(() => {
        if (identityMode === 'none') return null;
        if (identityMode === 'agentLogo') {
            return agentId ? <AgentIcon agentId={agentId} size={26} /> : null;
        }
        return avatarId
            ? <Avatar id={avatarId} size={32} monochrome={!isConnected} flavor={flavor} />
            : null;
    }, [agentId, avatarId, flavor, identityMode, isConnected]);

    const handleBackPress = () => {
        if (onBackPress) {
            onBackPress();
        } else {
            navigation.goBack();
        }
    };

    return (
        <View style={[styles.container, { paddingTop: includeTopInset ? insets.top : 0, backgroundColor: theme.colors.chrome.header.background }]}>
            <View
                onLayout={handleWrapperLayout}
                style={[styles.contentWrapper, constrainWidth ? null : { alignItems: 'stretch' }]}
            >
                <View style={[styles.content, { height: headerHeight, maxWidth }, constrainWidth ? null : { maxWidth: '100%' }]}>
                {showBackButton ? (
                    <Pressable
                        onPress={handleBackPress}
                        testID={backButtonTestId}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.back')}
                        style={styles.backButton}
                        hitSlop={15}
                    >
                        <Icon
                            name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color={theme.colors.chrome.header.foreground}
                        />
                    </Pressable>
                ) : null}

                {leadingIdentity ? (
                    <View style={styles.avatarLeading} testID={avatarButtonTestId}>
                        {leadingIdentity}
                    </View>
                ) : null}

                <View style={styles.titleContainer}>
                    <View style={styles.titleRow}>
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[
                                styles.title,
                                {
                                    color: theme.colors.chrome.header.foreground,
                                    ...Typography.default('semiBold')
                                }
                            ]}
                        >
                            {title}
                        </Text>
                        {badges && badges.length > 0 ? (
                            badges.map((badge, index) => (
                                <View
                                    key={`${badge}:${index}`}
                                    style={[
                                        styles.badge,
                                        {
                                            backgroundColor: theme.colors.state.neutral.background,
                                        },
                                    ]}
                                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-header-badge:${index}`)}
                                >
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            styles.badgeText,
                                            {
                                                color: theme.colors.state.neutral.foreground,
                                                ...Typography.default('semiBold'),
                                            },
                                        ]}
                                    >
                                        {badge}
                                    </Text>
                                </View>
                            ))
                        ) : null}
                    </View>
                    {subtitle && (
                        <Text
                            numberOfLines={1}
                            ellipsizeMode={shouldUseWebSubtitleStartEllipsis ? undefined : subtitleEllipsizeMode}
                            style={[
                                styles.subtitle,
                                shouldUseWebSubtitleStartEllipsis ? styles.subtitleHeadWeb : null,
                                {
                                    color: theme.colors.chrome.header.foreground,
                                    opacity: 0.7,
                                    ...Typography.default()
                                }
                            ]}
                        >
                            {shouldUseWebSubtitleStartEllipsis ? (
                                <Text style={styles.subtitleHeadTextWeb}>{subtitle}</Text>
                            ) : subtitle}
                        </Text>
                    )}
                </View>

                {rightElement ? (
                    <View style={styles.rightElementContainer}>
                        {rightElement}
                    </View>
                ) : null}

                {gutterHoldsElement ? null : gutterElement}
                </View>
                {gutterHoldsElement ? (
                    <View
                        pointerEvents="box-none"
                        // `top: 0` is the wrapper's own origin, which already sits below the
                        // container's safe-area padding — adding the inset here would count it twice.
                        style={[
                            styles.trailingGutter,
                            {
                                width: trailingGutterWidth,
                                height: headerHeight,
                                top: 0,
                                // Equal to the gap the centred tap target already leaves above
                                // itself, so the corner reads as a corner.
                                paddingRight: cornerInset,
                            },
                        ]}
                    >
                        {gutterElement}
                    </View>
                ) : null}
            </View>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        position: 'relative',
        zIndex: 100,
        elevation: 10,
    },
    contentWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: HEADER_HORIZONTAL_PADDING_PX,
        width: '100%',
    },
    backButton: {
        marginRight: 8,
    },
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        width: '100%',
    },
    title: {
        fontSize: Platform.select({
            ios: 15,
            android: 15,
            default: 16
        }),
        fontWeight: '600',
        flexShrink: 1,
    },
    subtitle: {
        fontSize: 12,
        fontWeight: '400',
        lineHeight: 14,
        marginTop: 1,
    },
    subtitleHeadWeb: {
        writingDirection: 'rtl' as const,
        textAlign: 'left' as const,
    },
    subtitleHeadTextWeb: {
        writingDirection: 'ltr' as const,
        unicodeBidi: 'isolate' as const,
    },
    // Matches the canonical badge (components/ui/status/StatusPill): background-only, no border
    // chrome, 8px radius. A bordered capsule in the header read as a different species from every
    // other badge in the product.
    badge: {
        borderWidth: 0,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    badgeText: {
        fontSize: 10,
        lineHeight: 14,
    },
    avatarLeading: {
        marginRight: 10,
    },
    trailingGutter: {
        position: 'absolute',
        right: 0,
        // Right-aligned so the control sits in the window corner instead of floating mid-margin,
        // and vertically centred so it lands on the same line as the header icons — both are
        // centred in the same `headerHeight`, so they agree without a hand-tuned offset.
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    rightElementContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));
