import * as React from 'react';
import { View, Platform, Pressable, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { StatusPill } from '@/components/ui/status/StatusPill';
import { t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { resolveChatHeaderContentInsets } from './chatHeaderLayout';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveSessionHeaderActionTargetPx } from '@/components/sessions/actions/sessionHeaderIconMetrics';


/** The gutter control's tap target, matching every other header action. */
const GUTTER_TAP_TARGET_PX = 44;

/** That tap target plus breathing room on both sides. */
const GUTTER_MIN_WIDTH_PX = 60;

/** The header's own horizontal inset — the margin every other control in it is measured from. */
const HEADER_HORIZONTAL_PADDING_PX = 8;

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
    /** Space reserved beside the transcript, without moving the trailing header actions. */
    contentTrailingInsetPx?: number;
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
    contentTrailingInsetPx = 0,
    includeTopInset = true,
    showBackButton = true,
    gutterElement,
}: ChatHeaderViewProps): React.ReactElement {
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
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
    const contentInsets = resolveChatHeaderContentInsets({
        containerWidth: wrapperWidth,
        maxWidth,
        contentTrailingInsetPx,
        constrainWidth,
    });
    const trailingGutterWidth = contentInsets.trailing;
    const gutterHoldsElement = gutterElement != null && trailingGutterWidth >= GUTTER_MIN_WIDTH_PX;
    // Half the leftover once the tap target is centred in `headerHeight` — which is also the gap the
    // control leaves above itself. Using it horizontally makes the icon's distance to the window's
    // top and right edges identical (this inset plus the icon's own centring inside the tap target),
    // so the control reads as sitting in the corner rather than pinned to one side of it. Raising it
    // to the header's content padding looks like more breathing room but breaks that symmetry.
    const cornerInset = Math.max(0, (headerHeight - GUTTER_TAP_TARGET_PX) / 2);
    // Which identity leads the header is the user's call. `agent` with no resolvable agent renders
    // nothing rather than silently falling back to the avatar — that would answer a question the
    // user already answered.
    const leadingIdentity = React.useMemo(() => {
        if (identityMode === 'none') return null;
        if (identityMode === 'agentLogo') {
            return agentId ? <AgentIcon agentId={agentId} size={26} /> : null;
        }
        return avatarId
            ? <Avatar id={avatarId} size={32} monochrome={!isConnected} flavor={agentId ?? flavor} />
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
        <View style={[styles.container, { paddingTop: includeTopInset ? insets.top : 0, backgroundColor: theme.colors.surface.base }]}>
            <View
                onLayout={handleWrapperLayout}
                style={[styles.contentWrapper, constrainWidth ? null : { alignItems: 'stretch' }]}
            >
                <View style={[
                    styles.content,
                    { minHeight: headerHeight, maxWidth },
                    constrainWidth ? null : { maxWidth: '100%' },
                    wrapperWidth > 0 && contentTrailingInsetPx > 0 && constrainWidth ? {
                        alignSelf: 'flex-start',
                        marginLeft: contentInsets.leading,
                        width: wrapperWidth - contentInsets.leading - contentInsets.trailing,
                        maxWidth: '100%',
                    } : null,
                ]}>
                {showBackButton ? (
                    <Pressable
                        onPress={handleBackPress}
                        testID={backButtonTestId}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.back')}
                        style={{
                            width: resolveSessionHeaderActionTargetPx(),
                            height: resolveSessionHeaderActionTargetPx(),
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
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
                    <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        accessibilityRole="header"
                        style={[
                            styles.title,
                            {
                                color: theme.colors.chrome.header.foreground,
                                ...Typography.default('semiBold'),
                            },
                        ]}
                    >
                        {title}
                    </Text>
                    {badges?.length || subtitle ? (
                        <View style={styles.metadataRow}>
                            {subtitle ? (
                                <Text
                                    numberOfLines={1}
                                    ellipsizeMode={shouldUseWebSubtitleStartEllipsis ? undefined : subtitleEllipsizeMode}
                                    style={[
                                        styles.subtitle,
                                        shouldUseWebSubtitleStartEllipsis ? styles.subtitleHeadWeb : null,
                                        {
                                            color: theme.colors.chrome.header.foreground,
                                            opacity: 0.7,
                                            ...Typography.default(),
                                        },
                                    ]}
                                >
                                    {shouldUseWebSubtitleStartEllipsis ? (
                                        <Text style={styles.subtitleHeadTextWeb}>
                                            {subtitle}
                                        </Text>
                                    ) : subtitle}
                                </Text>
                            ) : null}
                            {badges?.map((badge, index) => (
                                <StatusPill
                                    key={`${badge}:${index}`}
                                    variant="neutral"
                                    chrome="plain"
                                    foregroundColor={theme.colors.text.secondary}
                                    hideDot
                                    label={badge}
                                    labelVariant="phrase"
                                    labelNumberOfLines={1}
                                    style={styles.badge}
                                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-header-badge:${index}`)}
                                />
                            ))}
                        </View>
                    ) : null}
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
    avatarLeading: {
        marginRight: 8,
        flexShrink: 0,
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
    titleContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        minWidth: 0,
    },
    metadataRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        minWidth: 0,
        marginTop: 1,
        flexShrink: 0,
    },
    title: {
        fontSize: Platform.select({
            ios: 15,
            android: 15,
            default: 16
        }),
        fontWeight: '600',
        flexShrink: 0,
        width: '100%',
    },
    subtitle: {
        fontSize: 12,
        fontWeight: '400',
        lineHeight: 14,
        flexShrink: 1,
        minWidth: 0,
    },
    subtitleHeadWeb: {
        writingDirection: 'rtl' as const,
        textAlign: 'left' as const,
    },
    subtitleHeadTextWeb: {
        writingDirection: 'ltr' as const,
        unicodeBidi: 'isolate' as const,
    },
    // Metadata yields to the session name and stays inside its column, beside the actions.
    badge: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
    },
    rightElementContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
    },
}));
