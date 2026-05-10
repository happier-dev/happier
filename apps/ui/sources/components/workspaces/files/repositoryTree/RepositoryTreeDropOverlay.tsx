import * as React from 'react';
import { Animated, Easing, Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/store/hooks';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    overlay: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 12,
        backgroundColor: theme.colors.surfacePressedOverlay,
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
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    text: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    target: {
        fontSize: 12,
        color: theme.colors.text,
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
                        ? ({ backgroundColor: theme.colors.surfaceHighest ?? theme.colors.surfaceHigh } as ViewStyle)
                        : null,
                    Platform.OS === 'web' && uiBackdropBlurEnabled
                        ? ({ backdropFilter: 'blur(6px)' } as unknown as ViewStyle)
                        : null,
                ]}
            >
                <SafeIonicons name="cloud-upload-outline" size={18} color={theme.colors.textSecondary} />
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
