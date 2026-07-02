import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

export const ApprovalDecisionFooter = React.memo(function ApprovalDecisionFooter(props: Readonly<{
    disabled?: boolean;
    disabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    isDeciding: boolean;
    onApprove: () => void;
    onReject: () => void;
}>) {
    const { theme } = useUnistyles();
    const disabled = props.disabled === true || props.isDeciding;

    if (props.disabledReason === 'inactive') return null;

    if (props.disabled === true) {
        const disabledMessage =
            props.disabledReason === 'public'
                ? t('session.sharing.permissionApprovalsDisabledPublic')
                : props.disabledReason === 'readOnly'
                    ? t('session.sharing.permissionApprovalsDisabledReadOnly')
                    : t('session.sharing.permissionApprovalsDisabledNotGranted');
        return (
            <View style={styles.disabledNotice}>
                <Text style={styles.disabledTitle}>{t('session.sharing.permissionApprovalsDisabledTitle')}</Text>
                <Text style={styles.disabledBody}>{disabledMessage}</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Pressable
                testID="approval-prompt-approve"
                accessibilityRole="button"
                accessibilityLabel={t('approvals.approve')}
                disabled={disabled}
                onPress={props.onApprove}
                style={({ pressed }) => [
                    styles.button,
                    styles.approveButton,
                    pressed && !disabled ? styles.buttonPressed : null,
                    disabled ? styles.buttonDisabled : null,
                ]}
            >
                {props.isDeciding ? (
                    <ActivitySpinner size="small" color={theme.colors.button.primary.tint} />
                ) : (
                    <Text style={styles.approveText}>{t('approvals.approve')}</Text>
                )}
            </Pressable>
            <Pressable
                testID="approval-prompt-reject"
                accessibilityRole="button"
                accessibilityLabel={t('approvals.reject')}
                disabled={disabled}
                onPress={props.onReject}
                style={({ pressed }) => [
                    styles.button,
                    styles.rejectButton,
                    pressed && !disabled ? styles.buttonPressed : null,
                    disabled ? styles.buttonDisabled : null,
                ]}
            >
                <Text style={styles.rejectText}>{t('approvals.reject')}</Text>
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 8,
    },
    button: {
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        opacity: 0.72,
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    rejectButton: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    approveButton: {
        backgroundColor: theme.colors.button.primary.background,
    },
    rejectText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    approveText: {
        fontSize: 13,
        fontWeight: '700',
        color: theme.colors.button.primary.tint,
    },
    disabledNotice: {
        marginTop: 4,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        padding: 12,
        gap: 6,
    },
    disabledTitle: {
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
    disabledBody: {
        color: theme.colors.text.secondary,
    },
}));
