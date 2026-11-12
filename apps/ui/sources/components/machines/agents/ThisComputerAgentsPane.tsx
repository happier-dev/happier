import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { useServerScopedMachine } from '@/sync/store/hooks';

import { MachineAgentCard, MachineAgentCardGrid } from './MachineAgentCard';
import { MachineAgentMark } from './MachineAgentMark';
import { useMachineAgentRowActions } from './useMachineAgentRowActions';

/**
 * "This computer is already set up" (lab S1, user ruling 2026-09-30: agents as a grid of cards): the
 * add-a-machine form keeps This computer, marked connected, and choosing it shows the computer itself —
 * the connected line, its installed agents as cards with their real state and one action each, and the
 * next steps. Agent facts come from the one inventory owner.
 */
export const ThisComputerAgentsPane = React.memo(function ThisComputerAgentsPane(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    homeName: string;
    /** Opens the machine's page (its Agents section, where every agent can be set up). */
    onOpenMachine: () => void;
    onStartSession?: () => void;
    /** An agent's own action needs its form (sign in, show the terminal): the machine page opens at it. */
    onOpenAgent?: (agent: MachineAgent) => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const inventory = useMachineAgents({ serverId: props.serverId, machineId: props.machineId });
    const installed = inventory.agents.filter((agent) => agent.installed);
    const { onOpenAgent, onOpenMachine } = props;
    // Actions that need the agent's form (sign in, the terminal) open the machine page at it.
    const openForm = React.useCallback((agent: MachineAgent) => {
        if (onOpenAgent) onOpenAgent(agent);
        else onOpenMachine();
    }, [onOpenAgent, onOpenMachine]);
    const canManage = useServerScopedMachine(props.serverId, props.machineId, canManageMachine);
    const onAction = useMachineAgentRowActions({ serverId: props.serverId, machineId: props.machineId, machineName: props.machineName, onOpenForm: openForm });
    return (
        <View testID={props.testID} style={styles.pane}>
            <View style={styles.connected}>
                <Icon name="check-circle" size={16} color={theme.colors.state.success.foreground} />
                <Text style={styles.connectedText}>{t('machineAgents.alreadySetUp', { machine: props.machineName, home: props.homeName })}</Text>
            </View>
            {inventory.status === 'loading' && inventory.agents.length === 0 ? (
                <SurfaceStateCard testID={`${props.testID}.loading`} size="line" kind="loading" title={t('machineAgents.checking')} />
            ) : installed.length === 0 ? (
                <SurfaceStateCard testID={`${props.testID}.empty`} size="line" kind="empty" title={t('machineAgents.emptyInstalled')} />
            ) : (
                <MachineAgentCardGrid testID={`${props.testID}.agents`}>
                    {installed.map((agent) => (
                        <MachineAgentCard
                            key={buildMachineAgentInventoryKey(agent)}
                            testID={`${props.testID}.agent.${buildMachineAgentInventoryKey(agent)}`}
                            agent={agent}
                            canManage={canManage}
                            mark={<MachineAgentMark agentId={agent.agentId} machineId={props.machineId} serverId={props.serverId} size={22} />}
                            onAction={(action) => onAction(agent, action)}
                        />
                    ))}
                </MachineAgentCardGrid>
            )}
            <View style={styles.actions}>
                {props.onStartSession ? (
                    <RoundButton testID={`${props.testID}.startSession`} size="small" title={t('machineAgents.startSession')} onPress={props.onStartSession} />
                ) : null}
                <RoundButton testID={`${props.testID}.setUpAnother`} size="small" display="inverted" title={t('machineAgents.setUpAnother')} onPress={props.onOpenMachine} />
                <View style={styles.grow} />
                <RoundButton testID={`${props.testID}.openMachine`} size="small" display="inverted" title={t('machineAgents.openMachine', { machine: props.machineName })} onPress={props.onOpenMachine} />
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    pane: {
        gap: 14,
    },
    connected: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    connectedText: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    grow: {
        flexGrow: 1,
    },
}));
