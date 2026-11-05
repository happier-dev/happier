import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { Modal } from '@/modal';
import { ModalCloseButton } from '@/modal/components/card';

import { MachineAgentSetupPane } from './MachineAgentSetupPane';

type AgentSetupTarget = Readonly<{
    agent: MachineAgent;
    serverId: string;
    machineId: string;
    machineName: string;
}>;

/**
 * An Agent's install and sign-in chooser, where the person is: the same form Settings → Agents shows, for a
 * composer line that says the Agent can't start yet.
 */
export function showAgentSetupSheet(target: AgentSetupTarget): void {
    Modal.show({
        component: AgentSetupModal,
        props: { target },
        chrome: {
            kind: 'card',
            phonePresentation: 'sheet',
            // The form names itself ("Sign in to Claude, on this Machine"); the card adds no second title.
            header: 'none',
            title: target.agent.title,
            material: 'solid',
            testID: 'agent-setup-sheet',
            dimensions: { size: 'dialog' },
        },
    });
}

function AgentSetupModal(props: Readonly<{ target: AgentSetupTarget; onClose: () => void }>) {
    return (
        <View style={styles.frame}>
            <View style={styles.close}>
                <ModalCloseButton testID="agent-setup-sheet.close" onPress={props.onClose} />
            </View>
            <MachineAgentSetupPane {...props.target} onLeave={props.onClose} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    frame: {
        paddingHorizontal: theme.space.s16,
    },
    close: {
        position: 'absolute',
        top: theme.space.s12,
        right: theme.space.s12,
        zIndex: 1,
    },
}));
