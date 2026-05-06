import Color from 'color';
import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { AgentContentView } from '@/components/sessions/transcript/AgentContentView';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform/platform';
import {
    resolveSessionViewContentBottomSpacing,
    SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX,
} from './resolveSessionViewContentBottomSpacing';

export type SessionViewLayoutProps = Readonly<{
    content: React.ReactNode;
    input: React.ReactNode;
    placeholder: React.ReactNode;
    shouldShowCliWarning: boolean;
    onDismissCliWarning: () => void;
    isLandscape: boolean;
    deviceType: string;
    onBackPress: () => void;
    chatBottomSpacing?: 'default' | 'none';
}>;

export function SessionViewLayout(props: SessionViewLayoutProps) {
    const { theme } = useUnistyles();
    const safeArea = useChromeSafeAreaInsets();
    const { width: windowWidth } = useWindowDimensions();
    const [measuredContentWidth, setMeasuredContentWidth] = React.useState<number | null>(null);
    const showBackButton = props.isLandscape && props.deviceType === 'phone';
    const handleContentLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextWidth = Math.trunc(event.nativeEvent.layout.width);
        if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;
        setMeasuredContentWidth((currentWidth) => (
            currentWidth === nextWidth ? currentWidth : nextWidth
        ));
    }, []);
    const contentPaddingBottom = resolveSessionViewContentBottomSpacing({
        chatBottomSpacing: props.chatBottomSpacing ?? 'default',
        safeAreaBottomPx: safeArea.bottom,
        availableWidthPx: measuredContentWidth ?? windowWidth,
        contentMaxWidthPx: layout.maxWidth,
        defaultContentBottomGapPx: (isRunningOnMac() || Platform.OS === 'web')
            ? SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX
            : 0,
        inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    });

    return (
        <>
            {props.shouldShowCliWarning && !showBackButton && (
                <Pressable
                    onPress={props.onDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8,
                        alignSelf: 'center',
                        backgroundColor: theme.colors.box.warning.background,
                        borderWidth: 1,
                        borderColor: theme.colors.box.warning.border,
                        borderRadius: 100,
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998,
                        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color={theme.colors.box.warning.text} style={{ marginRight: 6 }} />
                    <Text style={{ fontSize: 12, color: theme.colors.box.warning.text, fontWeight: '600' }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color={theme.colors.box.warning.text} style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            <View
                onLayout={handleContentLayout}
                style={{ flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0, paddingBottom: contentPaddingBottom }}
            >
                <AgentContentView
                    content={props.content}
                    input={props.input}
                    placeholder={props.placeholder}
                />
            </View>

            {showBackButton && (
                <Pressable
                    onPress={props.onBackPress}
                    testID="session-view-landscape-back-button"
                    style={{
                        position: 'absolute',
                        top: safeArea.top + 8,
                        left: 16,
                        zIndex: 1000,
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: Color(theme.colors.header.background).alpha(0.9).rgb().string(),
                        alignItems: 'center',
                        justifyContent: 'center',
                        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
                    }}
                    hitSlop={15}
                >
                    <Ionicons
                        name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                        size={24}
                        color={theme.colors.text}
                    />
                </Pressable>
            )}
        </>
    );
}
