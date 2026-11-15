import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The page's present in one quiet line: how many accounts and pools, how many need you, when usage was
 * read and "Refresh all" ("7 accounts  2 pools  ● 1 needs you … As of 10:40  ↻ Refresh all"). Healthy
 * stays quiet: the "needs you" part only appears when an account needs a new sign-in.
 */
export const ConnectedServicesSummaryLine = React.memo(function ConnectedServicesSummaryLine(props: Readonly<{
    accountCount: number;
    poolCount?: number;
    needsYouCount: number;
    asOf: number | null;
    /** Some shown usage is older than its producer's window: said here once for every row it covers. */
    stale?: boolean;
    /** Reads every account's usage again (each account's own refresh). */
    onRefreshAll?: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <View testID="connected-services-summary" style={stylesheet.row} accessibilityRole="summary">
            <Text style={stylesheet.text}>{t('connectedServicesSettings.accountCount', { count: props.accountCount })}</Text>
            {props.poolCount ? (
                <Text style={stylesheet.text}>{t('connectedServicesSettings.poolCount', { count: props.poolCount })}</Text>
            ) : null}
            {props.needsYouCount > 0 ? (
                <View style={stylesheet.part} testID="connected-services-summary-needs-you">
                    <StatusDot color={theme.colors.state.warning.foreground} size={6} />
                    <Text style={stylesheet.text}>{t('connectedServicesSettings.needsYouCount', { count: props.needsYouCount })}</Text>
                </View>
            ) : null}
            <View style={stylesheet.asOf}>
                {props.asOf !== null && props.stale ? (
                    <SurfaceFreshnessLine testID="connected-services-summary-stale" presentation="inline" asOf={props.asOf}
                        reason={t('connectedServicesCollection.railUsageStale')} />
                ) : props.asOf !== null ? <SurfaceAsOfLabel at={props.asOf} testID="connected-services-summary-as-of" /> : null}
                {props.onRefreshAll ? (
                    <HappierPressable
                        testID="connected-services-summary-refresh-all"
                        accessibilityRole="button"
                        hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
                        onPress={props.onRefreshAll}
                        style={stylesheet.refresh}
                    >
                        <Icon name="arrows-clockwise" size={13} color={theme.colors.text.primary} />
                        <Text style={stylesheet.refreshLabel}>{t('connectedServicesCollection.refreshAll')}</Text>
                    </HappierPressable>
                ) : null}
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: 14,
        rowGap: theme.space.s4,
    },
    part: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    text: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    asOf: {
        marginLeft: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s16,
    },
    refresh: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    refreshLabel: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
}));
