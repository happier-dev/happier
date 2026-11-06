import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { formatProviderUsageAmount } from '@/components/settings/providers/ProviderConnectionUsageSection';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { useProviderConnectionUsageForSource } from '@/providers/hooks/useProviderConnectionUsageForSource';
import { selectProviderConnectionUsageSummaryMeter } from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';
import { t } from '@/text';

type SourceUsage = ReturnType<typeof useProviderConnectionUsageForSource>;

/**
 * The browsed source's one balance or allowance, under its name: what is left, when it was read, and the
 * way to the connection's page, where the meters and their bars live. The pane's refresh re-reads it.
 * Never repeated per model.
 */
export const SessionModelSourceUsage = React.memo(function SessionModelSourceUsage(props: Readonly<{
    usage: Pick<SourceUsage, 'supported' | 'presentation' | 'refreshing' | 'failed' | 'pendingApproval'>;
    onOpenApproval: (() => void) | null;
    onOpenConnection: () => void;
}>) {
    const { theme } = useUnistyles();
    const { usage } = props;
    if (!usage.supported) return null;
    const { presentation } = usage;
    const meter = selectProviderConnectionUsageSummaryMeter(presentation);
    const failure = presentation.connectionError ?? presentation.sourceErrors[0]?.error
        ?? (usage.failed ? { code: 'usage_refresh_failed' } : null);
    const testID = 'model-picker-source-usage';
    return (
        <View testID={testID} style={styles.root}>
            <View testID={`${testID}:line`} style={styles.line}>
                {!meter && failure ? (
                    // Nothing else to say about the source: the failure leads the line, and Details stays beside it.
                    <View style={styles.failureInLine}>
                        <ProviderErrorItems presentation="line" error={failure} />
                    </View>
                ) : null}
                {meter ? (
                    <Text testID={`${testID}:meter`} numberOfLines={1} style={styles.fact}>
                        {meter.label}{' '}
                        <Text style={[
                            styles.amount,
                            meter.tone === 'warning' ? styles.amountWarning : null,
                            meter.tone === 'danger' ? styles.amountDanger : null,
                        ]}>
                            {formatProviderUsageAmount(meter.amount, meter.unit, meter.currency)}
                        </Text>
                    </Text>
                ) : !failure && usage.refreshing && !props.onOpenApproval ? (
                    <SurfaceStateCard testID={`${testID}:refreshing`} size="line" kind="loading" title={t('connectedServices.quota.refreshing')} />
                ) : null}
                {presentation.fetchedAt !== null ? <SurfaceAsOfLabel at={presentation.fetchedAt} testID={`${testID}:as-of`} /> : null}
                <HappierPressable
                    testID={`${testID}:details`}
                    accessibilityRole="link"
                    accessibilityLabel={t('common.details')}
                    onPress={props.onOpenConnection}
                    style={styles.details}
                >
                    <Text style={styles.detailsText}>{t('common.details')}</Text>
                    <Icon name="caret-right" size={12} color={theme.colors.text.secondary} />
                </HappierPressable>
            </View>
            {usage.refreshing && props.onOpenApproval ? (
                <ActionApprovalPendingNotice
                    testID={`${testID}:approval`}
                    presentation="line"
                    message={t('settingsProvidersCollection.approvalPendingTitle')}
                    openLabel={t('settingsProvidersCollection.openApproval')}
                    onOpenApproval={props.onOpenApproval}
                />
            ) : null}
            {meter && failure ? (
                // The pane's refresh is the one retry; a failure only a key can fix leads to the connection.
                <ProviderErrorItems
                    presentation="line"
                    error={failure}
                    reviewConnection={props.onOpenConnection}
                    configureSecret={props.onOpenConnection}
                />
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: theme.space.s4,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    fact: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    amount: {
        ...Typography.variant('meta', 'medium'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    amountWarning: {
        color: theme.colors.state.warning.foreground,
    },
    amountDanger: {
        color: theme.colors.state.danger.foreground,
    },
    failureInLine: {
        flexShrink: 1,
        minWidth: 0,
    },
    details: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
        marginLeft: 'auto',
    },
    detailsText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
