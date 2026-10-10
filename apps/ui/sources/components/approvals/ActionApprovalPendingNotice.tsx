import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/** Shared presentation only; the originating Action continuation owns settlement. */
export const ActionApprovalPendingNotice = React.memo(function ActionApprovalPendingNotice(props: Readonly<{
    message: string;
    onOpenApproval: () => void;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.approval} testID={props.testID}>
            <Text accessibilityLiveRegion="polite" style={[styles.notice, styles.approvalText, { color: theme.colors.text.secondary }]}>
                {props.message}
            </Text>
            <RoundButton size="small" display="secondary" title={t('approvals.title')} onPress={props.onOpenApproval} />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    approval: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    approvalText: { flexShrink: 1 },
    notice: { fontSize: 13, lineHeight: 18 },
}));
