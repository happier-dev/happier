import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { TokenUsageRing, type TokenUsageTone } from '@/components/sessions/usage';

import {
    formatContextUsageDetail,
    type ContextUsageState,
} from '../contextWarning';
import { AgentInputContentPopover } from './AgentInputContentPopover';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

type AgentInputContextUsageBadgeProps = Readonly<{
    state: ContextUsageState;
    marginLeft?: number;
    showLabels?: boolean;
    onRefresh?: () => void;
}>;

function areContextUsageBadgePropsEqual(
    left: AgentInputContextUsageBadgeProps,
    right: AgentInputContextUsageBadgeProps,
): boolean {
    return left.showLabels === right.showLabels
        && left.onRefresh === right.onRefresh
        && left.marginLeft === right.marginLeft
        && left.state.severity === right.state.severity
        && left.state.usedTokens === right.state.usedTokens
        && left.state.contextWindowTokens === right.state.contextWindowTokens
        && left.state.usedPercentage === right.state.usedPercentage;
}

export const AgentInputContextUsageBadge = React.memo(function AgentInputContextUsageBadge(
    props: AgentInputContextUsageBadgeProps,
) {
    const styles = stylesheet;
    const anchorRef = React.useRef<any>(null);
    const [isPinnedOpen, setIsPinnedOpen] = React.useState(false);
    const [isHovered, setIsHovered] = React.useState(false);
    const tone: TokenUsageTone = props.state.severity;
    const remainingPercentage = Math.max(0, Math.min(100, 100 - props.state.usedPercentage));
    const badgeValueLabel = React.useMemo(
        () => String(Math.round(remainingPercentage)),
        [remainingPercentage],
    );
    const popoverDetail = React.useMemo(
        () => formatContextUsageDetail(props.state),
        [props.state],
    );
    const open = isPinnedOpen || isHovered;

    return (
        <>
            <Pressable
                ref={anchorRef}
                testID="agent-input-context-usage-badge"
                accessibilityRole="button"
                accessibilityLabel={popoverDetail}
                onPress={() => {
                    props.onRefresh?.();
                    setIsPinnedOpen((previous) => !previous);
                }}
                onHoverIn={Platform.OS === 'web' ? () => setIsHovered(true) : undefined}
                onHoverOut={Platform.OS === 'web' ? () => setIsHovered(false) : undefined}
                style={(state) => {
                    const hovered = (state as WebHoverablePressableState).hovered === true;
                    return [
                        styles.badge,
                        {
                            marginLeft: props.marginLeft ?? 0,
                        },
                        (state.pressed || hovered) ? styles.badgePressed : null,
                    ];
                }}
            >
                {props.showLabels === true ? <Text testID="agent-input-context-usage-label" style={styles.label} numberOfLines={1}>
                    {t('agentInput.context.badgeLabel')}
                </Text> : null}
                <TokenUsageRing
                    used={Math.max(0, props.state.contextWindowTokens - props.state.usedTokens)}
                    limit={props.state.contextWindowTokens}
                    label={popoverDetail}
                    value={badgeValueLabel}
                    tone={tone}
                    remainingPct={100 - props.state.usedPercentage}
                    ringTestID="agent-input-context-usage-ring"
                    valueTestID="agent-input-context-usage-value"
                />
            </Pressable>

            <AgentInputContentPopover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => {
                    setIsPinnedOpen(false);
                    setIsHovered(false);
                }}
                maxWidthCap={340}
                scrollEnabled={false}
                content={(
                    <View testID="agent-input-context-usage-popover" style={styles.popoverContent}>
                        <Text style={styles.popoverTitle}>
                            {t('agentInput.context.windowTitle')}
                        </Text>
                        <Text testID="agent-input-context-usage-popover-detail" style={styles.popoverDetail}>
                            {popoverDetail}
                        </Text>
                        <Text testID="agent-input-context-usage-popover-description" style={styles.popoverDescription}>
                            {t('agentInput.context.description')}
                        </Text>
                    </View>
                )}
            />
        </>
    );
}, areContextUsageBadgePropsEqual);

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        position: 'relative',
        flexDirection: 'row',
        minWidth: 20,
        height: 20,
        gap: 4,
        borderRadius: 999,
        justifyContent: 'center',
        alignItems: 'center',
    },
    label: {
        ...Typography.pillLabel(),
        color: theme.colors.text.secondary,
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
    popoverDescription: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));
