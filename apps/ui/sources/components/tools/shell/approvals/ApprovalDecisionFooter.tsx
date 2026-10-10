import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ApprovalDecisionBar } from '@/components/approvals/ApprovalDecisionBar';
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
        <ApprovalDecisionBar size="small" disabled={disabled}
            approve={{ label: props.approveLabel, testID: `${testIDPrefix}-approve`, controlRef: primaryAnswerRef,
                accessibilityHint: props.approveAccessibilityHint, disabled: approveDisabled,
                busy: props.isDeciding, onPress: props.onApprove }}
            reject={{ label: props.rejectLabel, testID: `${testIDPrefix}-reject`, onPress: props.onReject }} />
    );
});

const styles = StyleSheet.create((theme) => ({
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
