import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
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

export type MachineAgentRowProps = Readonly<{
    agent: MachineAgent;
    /** The agent's brand mark (the catalog owner resolves it; no tile behind it). */
    mark: React.ReactNode;
    session?: MachineAgentSignInSession | null;
    onAction: (action: MachineAgentRowAction) => void;
    /** Given, the row opens in place into this (the setup form, lab M2). */
    form?: React.ReactNode;
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
    showDivider?: boolean;
    canManage?: boolean;
    /** The section already says the machine is offline; the row keeps only what it last reported. */
    machineOfflineSaid?: boolean;
    testID: string;
}>;

/**
 * One agent on one machine (lab M1): mark, name and version, one status line, and one action only when
 * there is something to do. Pressing the row (or its action, when the action needs the form) opens the
 * setup form in place — the row you pressed becomes the setup (M2).
 */
export const MachineAgentRow = React.memo(function MachineAgentRow(props: MachineAgentRowProps) {
    const { agent, session, onAction } = props;
    const status = resolveMachineAgentStatus(agent, session);
    const resolvedAction = resolveMachineAgentRowAction(agent, session);
    const action = resolvedAction && (canPerformMachineAgentAction(agent, resolvedAction.kind, props.canManage !== false))
        ? resolvedAction
        : null;
    const dim = agent.state === 'notInstalled' || agent.state === 'unsupported';
    const actionButton = action ? (
        <RoundButton
            testID={`${props.testID}.action.${action.kind}`}
            size="small"
            // A row's action repeats down the list (two agents needing sign-in): bordered, so no row shouts over its neighbours.
            display="secondary"
            title={formatMachineAgentAction(action)}
            onPress={() => onAction(action)}
        />
    ) : null;
    const header = (headerProps?: Readonly<Record<string, unknown>>) => (
        <Item
            {...headerProps}
            testID={props.testID}
            icon={<View style={dim ? styles.dimMark : null}>{props.mark}</View>}
            title={agent.title}
            titleStyle={dim ? styles.dimTitle : undefined}
            titleAccessory={agent.version ? <Text style={styles.version}>{agent.version}</Text> : undefined}
            subtitle={<MachineAgentStatusLine testID={`${props.testID}.status`} status={status} machineOfflineSaid={props.machineOfflineSaid} />}
            rightElement={actionButton}
            rightElementOutsidePressable
            showChevron={false}
            showDivider={props.form ? undefined : props.showDivider}
        />
    );
    if (!props.form || !props.onExpandedChange) return header();
    return (
        <ExpandableItem
            testID={`${props.testID}.disclosure`}
            expanded={props.expanded === true}
            onExpandedChange={props.onExpandedChange}
            showDivider={props.showDivider}
            header={({ headerProps }) => header(headerProps as Readonly<Record<string, unknown>>)}
        >
            {props.form}
        </ExpandableItem>
    );
});

const styles = StyleSheet.create((theme) => ({
    version: {
        ...Typography.mono(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
        marginLeft: theme.space.s6,
    },
    dimMark: {
        opacity: 0.6,
    },
    dimTitle: {
        color: theme.colors.text.secondary,
    },
}));
