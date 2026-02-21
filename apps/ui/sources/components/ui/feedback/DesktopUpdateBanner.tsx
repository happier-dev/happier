import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useDesktopUpdater } from '@/desktop/updates/useDesktopUpdater';
import { t } from '@/text';
import { getDesktopUpdateBannerModel } from './desktopUpdateBannerModel';
import { Text } from '@/components/ui/text/Text';


export function DesktopUpdateBanner() {
    const styles = stylesheet;
    const { status, availableVersion, error, dismiss, refresh, startInstall } = useDesktopUpdater();
    const { theme } = useUnistyles();

    const visible = status === 'available' || status === 'installing' || status === 'error';
    if (!visible) {
        return null;
    }

    const model = getDesktopUpdateBannerModel({
        status,
        availableVersion,
        error,
        t,
    });

    const onActionPress = async () => {
        if (model.actionDisabled) {
            return;
        }
        if (status === 'error') {
            await refresh();
            return;
        }
        await startInstall();
    };

    return (
        <View
            style={styles.container}
        >
            <Text style={styles.message}>
                {model.message}
            </Text>

            <Pressable
                onPress={onActionPress}
                disabled={model.actionDisabled}
                style={[
                    styles.actionButton,
                    model.actionDisabled ? styles.actionButtonDisabled : styles.actionButtonEnabled,
                ]}
            >
                <Text style={[styles.actionLabel, { color: model.actionDisabled ? theme.colors.textSecondary : theme.colors.button.primary.tint }]}>
                    {model.actionLabel}
                </Text>
            </Pressable>

            <Pressable
                onPress={dismiss}
                style={styles.dismissButton}
                accessibilityLabel={t('common.cancel')}
            >
                <Text style={styles.dismissLabel}>
                    ×
                </Text>
            </Pressable>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.box.warning.border,
        backgroundColor: theme.colors.box.warning.background,
    },
    message: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.box.warning.text,
    },
    actionButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
    },
    actionButtonEnabled: {
        backgroundColor: theme.colors.button.primary.background,
    },
    actionButtonDisabled: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    actionLabel: {
        fontSize: 13,
    },
    dismissButton: {
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surfacePressed,
    },
    dismissLabel: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
}));
