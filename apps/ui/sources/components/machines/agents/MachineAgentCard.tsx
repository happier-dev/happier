import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
import { SurfaceCard, SURFACE_CARD_PADDING_PX } from '@/components/ui/cards/SurfaceCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { formatMachineAgentAction } from './machineAgentCopy';
import {
    canPerformMachineAgentAction,
    resolveMachineAgentRowAction,
    resolveMachineAgentStatus,
    type MachineAgentRowAction,
} from './machineAgentPresentation';
import { MachineAgentStatusLine } from './MachineAgentStatusLine';

/**
 * One agent as a grid card (lab S1, user ruling 2026-09-30: the computer's agents are a grid, not
 * rows): the mark and version on top, the name, and one fixed footer — the status left, its one action
 * right. The footer action acts; it never opens the card.
 */
export const MachineAgentCard = React.memo(function MachineAgentCard(props: Readonly<{
    agent: MachineAgent;
    mark: React.ReactNode;
    session?: MachineAgentSignInSession | null;
    onAction: (action: MachineAgentRowAction) => void;
    onOpen?: () => void;
    canManage?: boolean;
    testID: string;
}>) {
    const { agent, session } = props;
    const status = resolveMachineAgentStatus(agent, session);
    const resolvedAction = resolveMachineAgentRowAction(agent, session);
    const action = resolvedAction && canPerformMachineAgentAction(agent, resolvedAction.kind, props.canManage !== false) ? resolvedAction : null;
    return (
        <View style={styles.frame}>
            <SurfaceCard testID={props.testID} padding="sm" fill onPress={props.onOpen}>
                <View style={styles.card}>
                    <View style={styles.top}>
                        {props.mark}
                        {agent.version ? <Text style={styles.version} numberOfLines={1}>{agent.version}</Text> : null}
                    </View>
                    <Text style={styles.name} numberOfLines={1}>{agent.title}</Text>
                    <View style={[styles.footer, action ? styles.footerWithAction : null]}>
                        <MachineAgentStatusLine testID={`${props.testID}.status`} status={status} numberOfLines={2} />
                    </View>
                </View>
            </SurfaceCard>
            {action ? (
                <View style={styles.action}>
                    <RoundButton
                        testID={`${props.testID}.action.${action.kind}`}
                        size="small"
                        display="secondary"
                        title={formatMachineAgentAction(action)}
                        onPress={() => props.onAction(action)}
                    />
                </View>
            ) : null}
        </View>
    );
});

/** The computer's agents on the card grid (three columns wide, two on a phone's width, one when narrower). */
export const MachineAgentCardGrid = React.memo(function MachineAgentCardGrid(props: Readonly<{
    children: React.ReactNode;
    testID: string;
}>) {
    return <CardGrid testID={props.testID} columns={3}>{props.children}</CardGrid>;
});

const styles = StyleSheet.create((theme) => ({
    frame: {
        flex: 1,
    },
    card: {
        flex: 1,
        minHeight: 112,
    },
    top: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s8,
        height: 24,
        marginBottom: theme.space.s10,
    },
    version: {
        ...Typography.mono(),
        fontSize: 11.5,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
    },
    name: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
    },
    footer: {
        marginTop: 'auto',
        paddingTop: theme.space.s8,
        minHeight: 36,
        justifyContent: 'center',
    },
    // The action sits over the footer's right edge; the status keeps clear of it.
    footerWithAction: {
        paddingRight: 84,
    },
    action: {
        position: 'absolute',
        right: SURFACE_CARD_PADDING_PX.sm.horizontal,
        bottom: SURFACE_CARD_PADDING_PX.sm.vertical,
    },
}));
