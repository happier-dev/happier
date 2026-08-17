import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

const TOAST_HIDE_DELAY_MS = 4000;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        position: 'absolute',
        top: 12,
        left: 16,
        right: 16,
        alignItems: 'center',
        zIndex: 100,
    },
    toast: {
        maxWidth: 520,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: theme.colors.state.warning.background,
        borderWidth: 1,
        borderColor: theme.colors.state.warning.border,
        shadowColor: theme.colors.overlay.scrim,
        shadowOpacity: 0.12,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 4,
    },
    message: {
        flexShrink: 1,
        color: theme.colors.state.warning.foreground,
        fontSize: 13,
    },
}));

export const ProjectWorktreeRecoveryToast = React.memo((props: Readonly<{
    recoveryToastKey: string | null;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [visibleKey, setVisibleKey] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!props.recoveryToastKey) return;
        setVisibleKey((currentKey) => currentKey === props.recoveryToastKey ? currentKey : props.recoveryToastKey);
        const timeout = setTimeout(() => {
            setVisibleKey((currentKey) => currentKey === props.recoveryToastKey ? null : currentKey);
        }, TOAST_HIDE_DELAY_MS);
        return () => clearTimeout(timeout);
    }, [props.recoveryToastKey]);

    if (!visibleKey) {
        return null;
    }

    return (
        <View testID="project-worktree-recovery-toast" pointerEvents="none" style={styles.container}>
            <View style={styles.toast}>
                <Icon name="warning" size={16} color={theme.colors.state.warning.foreground} />
                <Text style={styles.message}>
                    {t('projects.detail.missingWorktreeRecovered')}
                </Text>
            </View>
        </View>
    );
});
