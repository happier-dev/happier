import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { resolvePermissionDisabledMessage } from '@/components/tools/shell/permissions/permissionDisabledMessage';
import { usePendingPromptPrimaryFocus } from '@/components/tools/shell/permissions/usePendingPromptPrimaryFocus';

export const ApprovalDecisionFooter = React.memo(function ApprovalDecisionFooter(props: Readonly<{
    disabled?: boolean;
    decisionDisabled?: boolean;
    approveDisabled?: boolean;
    approveLabel?: string;
    /** The refusal's own word ("Deny"); defaults to Reject. */
    rejectLabel?: string;
    approveAccessibilityHint?: string;
    disabledReason?: TranscriptPermissionDisabledReason;
    isDeciding: boolean;
    onApprove: () => void;
    onReject: () => void;
    testIDPrefix?: string;
    requestId?: string;
}>) {
    const { theme } = useUnistyles();
    const disabled = props.disabled === true || props.decisionDisabled === true || props.isDeciding;
    const approveDisabled = disabled || props.approveDisabled === true;
    const testIDPrefix = props.testIDPrefix ?? 'approval-prompt';
    const primaryAnswerRef = usePendingPromptPrimaryFocus(props.requestId ?? null, !approveDisabled && !props.disabledReason);

    if (props.disabledReason === 'inactive') return null;

    if (props.disabled === true) {
        const disabledMessage =
            resolvePermissionDisabledMessage(props.disabledReason);
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
                testID={`${testIDPrefix}-approve`}
                ref={primaryAnswerRef}
                accessibilityRole="button"
                accessibilityLabel={props.approveLabel ?? t('approvals.approve')}
                accessibilityHint={props.approveAccessibilityHint}
                disabled={approveDisabled}
                onPress={props.onApprove}
                style={({ pressed }) => [
                    styles.button,
                    styles.approveButton,
                    pressed && !approveDisabled ? styles.buttonPressed : null,
                    approveDisabled ? styles.buttonDisabled : null,
                ]}
            >
                {props.isDeciding ? (
                    <ActivitySpinner size="small" color={theme.colors.button.primary.tint} />
                ) : (
                    <Text style={styles.approveText}>{props.approveLabel ?? t('approvals.approve')}</Text>
                )}
            </Pressable>
            <Pressable
                testID={`${testIDPrefix}-reject`}
                accessibilityRole="button"
                accessibilityLabel={props.rejectLabel ?? t('approvals.reject')}
                disabled={disabled}
                onPress={props.onReject}
                style={({ pressed }) => [
                    styles.button,
                    styles.rejectButton,
                    pressed && !disabled ? styles.buttonPressed : null,
                    disabled ? styles.buttonDisabled : null,
                ]}
            >
                <Text style={styles.rejectText}>{props.rejectLabel ?? t('approvals.reject')}</Text>
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
        minHeight: Platform.select({ ios: 44, default: 48 }),
        minWidth: Platform.select({ ios: 44, default: 48 }),
        paddingHorizontal: 12,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        opacity: motionTokens.press.opacity,
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
