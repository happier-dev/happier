import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TokenUsageRing, type TokenUsageTone } from '@/components/sessions/usage';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { t } from '@/text';

import { AgentInputContentPopover } from './AgentInputContentPopover';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

type AgentInputProviderUsageBadgeProps = Readonly<{
    viewModel: ConnectedServiceQuotaGaugeViewModel;
    marginLeft?: number;
}>;

function mapQuotaToneToTokenTone(tone: ConnectedServiceQuotaGaugeViewModel['tone']): TokenUsageTone {
    if (tone === 'critical') return 'critical';
    if (tone === 'warning') return 'warning';
    return 'neutral';
}

export function AgentInputProviderUsageBadge(props: AgentInputProviderUsageBadgeProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const anchorRef = React.useRef(null);
    const [isPinnedOpen, setIsPinnedOpen] = React.useState(false);
    const [isHovered, setIsHovered] = React.useState(false);
    const open = isPinnedOpen || isHovered;
    const accessibilityLabel = t('agentInput.providerUsage.accessibilityLabel', {
        value: props.viewModel.badgeLabel,
    });

    return (
        <>
            <View testID="agent-input-provider-quota-badge">
                <Pressable
                    ref={anchorRef}
                    testID="agent-input-provider-usage-badge"
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                    onPress={() => setIsPinnedOpen((previous) => !previous)}
                    onHoverIn={Platform.OS === 'web' ? () => setIsHovered(true) : undefined}
                    onHoverOut={Platform.OS === 'web' ? () => setIsHovered(false) : undefined}
                    style={(state) => {
                        const hovered = (state as WebHoverablePressableState).hovered === true;
                        return [
                            styles.badge,
                            { marginLeft: props.marginLeft ?? 0 },
                            (state.pressed || hovered) ? styles.badgePressed : null,
                        ];
                    }}
                >
                    <TokenUsageRing
                        used={props.viewModel.usedPct}
                        limit={100}
                        label={accessibilityLabel}
                        value={props.viewModel.ringValueLabel}
                        tone={mapQuotaToneToTokenTone(props.viewModel.tone)}
                        ringTestID="agent-input-provider-usage-ring"
                        valueTestID="agent-input-provider-usage-value"
                    />
                </Pressable>
            </View>

            <AgentInputContentPopover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => {
                    setIsPinnedOpen(false);
                    setIsHovered(false);
                }}
                maxWidthCap={360}
                testID="agent-input-provider-usage-popover"
                scrollEnabled={false}
                content={(
                    <View style={styles.popoverContent}>
                        <Text style={styles.popoverTitle}>
                            {t('agentInput.providerUsage.title')}
                        </Text>
                        <Text style={styles.popoverDetail}>
                            {props.viewModel.detailRightLabel}
                        </Text>
                        {props.viewModel.allMeterRows.map((row) => (
                            <View
                                key={row.meterId}
                                testID={`agent-input-provider-usage-meter:${row.meterId}`}
                                style={styles.meterRow}
                            >
                                <View style={styles.meterHeader}>
                                    <Text style={styles.meterLabel} numberOfLines={1}>
                                        {row.label}
                                    </Text>
                                    <Text style={styles.meterRight} numberOfLines={1}>
                                        {row.detailRightLabel}
                                    </Text>
                                </View>
                                <View style={styles.meterBarTrack}>
                                    <View
                                        testID={`agent-input-provider-usage-meter-fill:${row.meterId}`}
                                        style={[
                                            styles.meterBarFill,
                                            {
                                                width: `${row.remainingPct}%`,
                                                backgroundColor: row.tone === 'critical'
                                                    ? theme.colors.state.danger.foreground
                                                    : row.tone === 'warning'
                                                        ? theme.colors.state.warning.foreground
                                                        : theme.colors.state.success.foreground,
                                            },
                                        ]}
                                    />
                                </View>
                                {row.usedLimitLabel ? (
                                    <Text style={styles.meterUsage}>
                                        {row.usedLimitLabel}
                                    </Text>
                                ) : null}
                            </View>
                        ))}
                    </View>
                )}
            />
        </>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        position: 'relative',
        width: 20,
        height: 20,
        borderRadius: 999,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgePressed: {
        opacity: 0.9,
    },
    popoverContent: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
    },
    popoverTitle: {
        fontSize: 11,
        letterSpacing: 1,
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
        ...Typography.header(),
    },
    popoverDetail: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
    meterRow: {
        gap: 6,
    },
    meterHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    meterLabel: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    meterRight: {
        flexShrink: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    meterBarTrack: {
        height: 5,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.pressedOverlay,
        overflow: 'hidden',
    },
    meterBarFill: {
        height: 5,
        borderRadius: 999,
    },
    meterUsage: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));
