import * as React from 'react';
import { Platform, Pressable, View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';

import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

export type ConnectedServicesAuthActionChipSource = 'native' | 'connected' | 'mixed' | 'unknown';

/** Amber dot + "Change pending" while the runtime reports a requested route that has not applied yet. */
function RouteChangePendingMark(props: Readonly<{ label: string; textStyle: StyleProp<TextStyle> }>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.pending}>
            <StatusDot size={6} color={theme.colors.state.warning.foreground} />
            <Text numberOfLines={1} style={[props.textStyle, styles.pendingText]}>{props.label}</Text>
        </View>
    );
}

/**
 * The composer's "Runs through" chip (D6): it names where the session's models come from — the
 * Agent's own sign-in, a pool, a gateway or a Provider — derived from the route presentation owner,
 * and opens the existing account choice. It never decides the route itself.
 */
export function createConnectedServicesAuthActionChip(params: Readonly<{
    label: string;
    /** Set only while a requested change waits for the runtime ("Now via …" + this mark). */
    changePendingLabel?: string | null;
    connectedCount: number;
    authSource: ConnectedServicesAuthActionChipSource;
    popoverContent: AgentInputPopoverContent;
    maxHeightCap?: number;
    maxWidthCap?: number;
    testID?: string;
}>): AgentInputExtraActionChip {
    const webAuthSourceProps = Platform.OS === 'web'
        ? { dataSet: { authSource: params.authSource } }
        : {};

    return {
        key: 'new-session-connected-services-auth',
        controlId: 'connectedServices',
        collapsedContentPopover: {
            title: params.label,
            label: params.label,
            icon: (tint: string) =>
                normalizeNodeForView(<Icon name="path" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            renderContent: params.popoverContent,
            maxHeightCap: params.maxHeightCap,
            maxWidthCap: params.maxWidthCap,
            scrollEnabled: false,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, countTextStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID={params.testID ?? 'new-session-connected-services-auth-chip'}
                {...webAuthSourceProps}
                onPress={() => toggleCollapsedPopover?.('new-session-connected-services-auth')}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(<Icon name="path" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {showLabel ? (
                    <AgentInputChipLabel
                        label={params.label}
                        textStyle={textStyle}
                        countTextStyle={countTextStyle}
                    />
                ) : null}
                {params.changePendingLabel ? <RouteChangePendingMark label={params.changePendingLabel} textStyle={textStyle} /> : null}
            </Pressable>
        ),
    };
}

const styles = StyleSheet.create((theme) => ({
    pending: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 6 },
    pendingText: { color: theme.colors.state.warning.textForeground },
}));
