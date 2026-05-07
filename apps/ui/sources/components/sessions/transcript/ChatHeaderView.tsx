import * as React from 'react';
import { View, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Typography } from '@/constants/Typography';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { layout } from '@/components/ui/layout/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';


interface ChatHeaderViewProps {
    title: string;
    subtitle?: string;
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    onBackPress?: () => void;
    onAvatarPress?: () => void;
    avatarId?: string;
    rightElement?: React.ReactNode;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
    constrainWidth?: boolean;
    includeTopInset?: boolean;
}

export const ChatHeaderView: React.FC<ChatHeaderViewProps> = ({
    title,
    subtitle,
    subtitleEllipsizeMode = 'tail',
    badges,
    onBackPress,
    onAvatarPress,
    avatarId,
    rightElement,
    isConnected = true,
    flavor,
    constrainWidth = true,
    includeTopInset = true,
}) => {
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const backButtonTestId = resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-header-back');
    const avatarButtonTestId = resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-header-avatar');
    const shouldUseWebSubtitleStartEllipsis = subtitleEllipsizeMode === 'head' && Platform.OS === 'web';

    const handleBackPress = () => {
        if (onBackPress) {
            onBackPress();
        } else {
            navigation.goBack();
        }
    };

    return (
        <View style={[styles.container, { paddingTop: includeTopInset ? insets.top : 0, backgroundColor: theme.colors.header.background }]}>
            <View style={[styles.contentWrapper, constrainWidth ? null : { alignItems: 'stretch' }]}>
                <View style={[styles.content, { height: headerHeight }, constrainWidth ? null : { maxWidth: '100%' }]}>
                <Pressable
                    onPress={handleBackPress}
                    testID={backButtonTestId}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.back')}
                    style={styles.backButton}
                    hitSlop={15}
                >
                    <Ionicons
                        name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                        size={Platform.select({ ios: 28, default: 24 })}
                        color={theme.colors.header.tint}
                    />
                </Pressable>
                
                <View style={styles.titleContainer}>
                    <View style={styles.titleRow}>
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            style={[
                                styles.title,
                                {
                                    color: theme.colors.header.tint,
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
                                            backgroundColor: theme.colors.surfaceHigh,
                                            borderColor: theme.colors.divider,
                                        },
                                    ]}
                                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-header-badge:${index}`)}
                                >
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            styles.badgeText,
                                            {
                                                color: theme.colors.textSecondary,
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
                                    color: theme.colors.header.tint,
                                    opacity: 0.7,
                                    ...Typography.default()
                                }
                            ]}
                        >
                            {shouldUseWebSubtitleStartEllipsis ? (
                                <Text style={styles.subtitleHeadTextWeb}>
                                    {subtitle}
                                </Text>
                            ) : subtitle}
                        </Text>
                    )}
                </View>

                {rightElement ? (
                    <View style={styles.rightElementContainer}>
                        {rightElement}
                    </View>
                ) : null}

                {avatarId && onAvatarPress && (
                    <Pressable
                        onPress={onAvatarPress}
                        hitSlop={15}
                        style={styles.avatarButton}
                        testID={avatarButtonTestId}
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionInfo.title')}
                    >
                        <Avatar
                            id={avatarId}
                            size={32}
                            monochrome={!isConnected}
                            flavor={flavor}
                        />
                    </Pressable>
                )}
                </View>
            </View>
        </View>
    );
};

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
        paddingHorizontal: Platform.OS === 'ios' ? 8 : 16,
        width: '100%',
        maxWidth: layout.headerMaxWidth,
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
    badge: {
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 6,
        paddingVertical: 2,
    },
    badgeText: {
        fontSize: 9,
        lineHeight: 12,
    },
    avatarButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: Platform.select({ ios: -8, default: -8 }),
    },
    rightElementContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));
