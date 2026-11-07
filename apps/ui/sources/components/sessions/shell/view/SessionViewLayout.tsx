import { Typography } from '@/constants/Typography';
import { resolveThemeColor } from '@/theme/parseThemeColor';
import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { AgentContentView } from '@/components/sessions/transcript/AgentContentView';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { usePaneMainBodyPresentation } from '@/components/ui/panels/paneMainComposerAnchor';
import { useSessionViewContentBottomSpacing } from './useSessionViewContentBottomSpacing';

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
    /** Viewer-local Session Companion placement. It reserves width as a flex sibling. */
    companion?: React.ReactNode;
    /**
     * The logical side the viewer chose for that rail.
     *
     * It is applied by reversing this one row rather than by an `order` style,
     * because Yoga has no `order`: a CSS-only reorder works on web and desktop
     * and silently does nothing on iOS and Android, which would leave "Move to
     * the left side" as a control with no observable effect on a tablet.
     */
    companionEdge?: 'leading' | 'trailing';
}>;

export function SessionViewLayout(props: SessionViewLayoutProps) {
    const { hiddenProps } = usePaneMainBodyPresentation();
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
    const contentPaddingBottom = useSessionViewContentBottomSpacing(measuredContentWidth ?? windowWidth, props.chatBottomSpacing ?? 'default');

    return (
        <>
            {props.shouldShowCliWarning && !showBackButton && (
                <Pressable
                    {...hiddenProps}
                    testID="session-view-cli-warning"
                    onPress={props.onDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8,
                        alignSelf: 'center',
                        backgroundColor: theme.colors.state.warning.background,
                        borderWidth: 1,
                        borderColor: theme.colors.state.warning.border,
                        borderRadius: 100,
                        paddingHorizontal: 14,
                        paddingVertical: theme.space.s6,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998,
                        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
                    }}
                >
                    <Icon name="warning" size={14} color={theme.colors.state.warning.foreground} style={{ marginRight: theme.space.s6 }} />
                    <Text style={{ ...Typography.variant('meta', 'semiBold'), color: theme.colors.state.warning.foreground,  }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Icon name="x" size={14} color={theme.colors.state.warning.foreground} style={{ marginLeft: theme.space.s8 }} />
                </Pressable>
            )}

            <View
                style={{
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                    flexDirection: props.companionEdge === 'leading' ? 'row-reverse' : 'row',
                }}
            >
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
                {props.companion}
            </View>

            {showBackButton && (
                <Pressable
                    {...hiddenProps}
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
                        backgroundColor: resolveThemeColor(theme.colors.chrome.header.background).alpha(0.9).rgb().string(),
                        alignItems: 'center',
                        justifyContent: 'center',
                        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
                    }}
                    hitSlop={15}
                >
                    <Icon
                        name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                        size={24}
                        color={theme.colors.text.primary}
                    />
                </Pressable>
            )}
        </>
    );
}
