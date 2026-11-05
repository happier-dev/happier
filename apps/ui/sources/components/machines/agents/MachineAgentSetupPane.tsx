import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { AgentSetupForm } from './AgentSetupForm';
import { resolveAgentSetupPhase } from './machineAgentPresentation';

/** The pane head: what this setup is and where (lab E2: "Set up Antigravity · Not on devbox yet"). */
export function resolveMachineAgentSetupPaneHead(agent: MachineAgent, machineName: string): Readonly<{ title: string; subtitle: string }> {
    const phase = resolveAgentSetupPhase(agent);
    switch (phase) {
        case 'signIn':
        case 'waitingForSignIn':
            return { title: t('machineAgents.signInTitle', { agent: agent.title }), subtitle: t('machineAgents.onMachine', { machine: machineName }) };
        case 'ready':
            return { title: t('machineAgents.readyTitle', { agent: agent.title }), subtitle: t('machineAgents.onMachine', { machine: machineName }) };
        case 'installing':
            return { title: t('machineAgents.setupTitle', { agent: agent.title }), subtitle: t('machineAgents.installingOn', { machine: machineName }) };
        case 'unsupported':
            return { title: agent.title, subtitle: t('machineAgents.cantRunOn', { machine: machineName }) };
        default:
            return { title: t('machineAgents.setupTitle', { agent: agent.title }), subtitle: t('machineAgents.notOnMachineYet', { machine: machineName }) };
    }
}

/** The right pane's layout: its head, then the form (the specimen passes a fixture form). */
export const MachineAgentSetupPaneView = React.memo(function MachineAgentSetupPaneView(props: Readonly<{
    agent: MachineAgent;
    machineName: string;
    form: React.ReactNode;
}>) {
    const head = resolveMachineAgentSetupPaneHead(props.agent, props.machineName);
    return (
        <View style={styles.pane} testID={`engine-setup-pane.${buildMachineAgentInventoryKey(props.agent)}`}>
            <View style={styles.head}>
                <Text style={styles.title}>{head.title}</Text>
                <Text style={styles.subtitle}>{head.subtitle}</Text>
            </View>
            {props.form}
        </View>
    );
});

/**
 * The engine popover's right pane for an agent that isn't ready on the composer's machine (user ruling
 * 2026-09-30: the real rail + pane popover, lab E2): a head naming the setup and the machine, then the
 * compact `AgentSetupForm`. When the inventory says ready, the rail row turns back into its models.
 */
export const MachineAgentSetupPane = React.memo(function MachineAgentSetupPane(props: Readonly<{
    agent: MachineAgent;
    serverId: string;
    machineId: string;
    machineName: string;
    /** The form is about to take the person to another page. */
    onLeave?: () => void;
}>) {
    return (
        <MachineAgentSetupPaneView
            agent={props.agent}
            machineName={props.machineName}
            form={(
                <AgentSetupForm
                    testID={`engine-setup.${buildMachineAgentInventoryKey(props.agent)}`}
                    serverId={props.serverId}
                    machineId={props.machineId}
                    machineName={props.machineName}
                    agentId={props.agent.agentId}
                    definitionId={props.agent.definitionId}
                    layout="compact"
                    {...(props.onLeave ? { onLeave: props.onLeave } : {})}
                />
            )}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    pane: {
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s4,
        // The engine pane leaves its top and bottom inset to its detail, which scrolls.
        paddingTop: theme.space.s16,
        paddingBottom: theme.space.s16,
    },
    head: {
        gap: 1,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
