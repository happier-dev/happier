import * as React from 'react';
import { Animated, Easing, Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/store/hooks';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    overlay: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.pressedOverlay,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    text: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    target: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));

export function RepositoryTreeDropOverlay(props: Readonly<{ visible: boolean; destinationLabel?: string | null }>) {
    const styles = stylesheet;
    const uiBackdropBlurEnabled = useLocalSetting('uiBackdropBlurEnabled') !== false;
    const { theme } = useUnistyles();
    const opacity = React.useRef(new Animated.Value(0)).current;

    React.useEffect(() => {
        const toValue = props.visible ? 1 : 0;
        Animated.timing(opacity, {
            toValue,
            duration: props.visible ? 120 : 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
        }).start();
    }, [opacity, props.visible]);

    return (
        <Animated.View testID="repository-tree-drop-overlay" pointerEvents="none" style={[styles.overlay, { opacity }]}>
            <View
                style={[
                    styles.content,
                    Platform.OS === 'web' && !uiBackdropBlurEnabled
                        ? ({ backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.inset } as ViewStyle)
                        : null,
                    Platform.OS === 'web' && uiBackdropBlurEnabled
                        ? ({ backdropFilter: 'blur(6px)' } as unknown as ViewStyle)
                        : null,
                ]}
            >
                <Icon name="cloud-arrow-up" size={16} color={theme.colors.text.secondary} />
                <View style={{ gap: 2 }}>
                    <Text style={styles.text}>{t('files.repositoryTree.dropToUpload')}</Text>
                    {props.destinationLabel ? (
                        <Text style={styles.target} numberOfLines={1}>
                            {props.destinationLabel}
                        </Text>
                    ) : null}
                </View>
            </View>
        </Animated.View>
    );
}
