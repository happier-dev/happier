import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { glassContentFill } from '@/components/ui/glass/glassSurfacePaint';

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
    /** This viewer cannot give the answer at all (a shared check only its Account holder allows): only the other one shows. */
    approveHidden?: boolean;
    approveLabel?: string;
    /** The refusal's own word (a request type's label); defaults to the bar's "Deny". */
    rejectLabel?: string;
    approveAccessibilityHint?: string;
    /** The approved Action declares it cannot be undone. */
    irreversible?: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    isDeciding: boolean;
    testIDPrefix?: string;
    requestId?: string;
}> & (
    | Readonly<{ onApprove: () => void; onReject: () => void; onDismiss?: undefined }>
    /** A settled failure offers only this: closing the card on this device, never a decision. */
    | Readonly<{ onDismiss: () => void; onApprove?: undefined; onReject?: undefined }>
)) {
    const disabled = props.disabled === true || props.decisionDisabled === true || props.isDeciding;
    const approveDisabled = disabled || props.approveDisabled === true;
    const testIDPrefix = props.testIDPrefix ?? 'approval-prompt';
    const primaryAnswerRef = usePendingPromptPrimaryFocus(props.requestId ?? null, !approveDisabled && !props.disabledReason);

    if (props.onDismiss) {
        // The bar's secondary pill (Reject's own weight) keeps the lone action on the card's text column; its plain
        // text form insets the word from that column.
        return <ApprovalDecisionBar size="small"
            reject={{ label: t('approvals.dismiss'), testID: `${testIDPrefix}-dismiss`, onPress: props.onDismiss }} />;
    }

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
        <ApprovalDecisionBar size="small" disabled={disabled} irreversible={props.irreversible}
            approve={props.approveHidden ? undefined : { label: props.approveLabel, testID: `${testIDPrefix}-approve`, controlRef: primaryAnswerRef,
                accessibilityHint: props.approveAccessibilityHint, disabled: approveDisabled,
                busy: props.isDeciding, onPress: props.onApprove }}
            reject={{ label: props.rejectLabel, testID: `${testIDPrefix}-reject`, onPress: props.onReject }} />
    );
});

const styles = StyleSheet.create((theme) => ({
    disabledNotice: {
        marginTop: theme.space.s4,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: glassContentFill(theme.colors.surface.base, theme.colors, { nested: true }),
        padding: theme.space.s12,
        gap: theme.space.s6,
    },
    disabledTitle: {
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
    disabledBody: {
        color: theme.colors.text.secondary,
    },
}));
