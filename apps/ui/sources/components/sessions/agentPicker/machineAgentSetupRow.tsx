import * as React from 'react';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { MachineAgentPickerMarker } from '@/components/machines/agents/MachineAgentPickerMarker';
import { canPerformMachineAgentAction, resolveMachineAgentPickerPlacement, type MachineAgentPickerPlacement } from '@/components/machines/agents/machineAgentPresentation';
import { t } from '@/text';

import type { SessionAgentPickerOptionPresentation } from './buildSessionAgentPickerOptions';

/** An Agent the picker's Machine reports as not ready to run: its row opens that Machine's setup, not its models. */
export type MachineAgentSetupRow = Readonly<{ agent: MachineAgent; placement: MachineAgentPickerPlacement }>;

/** The one decision whether an Agent row opens setup, from the Machine's own inventory row. */
export function resolveMachineAgentSetupRow(agent: MachineAgent | null | undefined): MachineAgentSetupRow | null {
    if (!agent) return null;
    const placement = resolveMachineAgentPickerPlacement(agent);
    return placement.opensSetup ? { agent, placement } : null;
}

/**
 * How a setup row reads in every Agent picker: placed under "Not on this machine yet" / "Can't run on
 * this machine" when the Agent is not there, marked with its setup state, and installable from its
 * marker when the host offers the install Action.
 */
export function presentMachineAgentSetupRow(row: MachineAgentSetupRow, params: Readonly<{
    backendTargetKey: string;
    installMachineAgent?: (agent: MachineAgent) => void;
    canManageMachine?: boolean;
}>): SessionAgentPickerOptionPresentation {
    const install = params.installMachineAgent;
    return {
        disabled: false,
        muted: row.placement.group !== 'onMachine',
        ...(row.placement.group === 'onMachine' ? {} : {
            section: row.placement.group === 'notOnMachine'
                ? { id: 'notOnMachine', label: t('machineAgents.notOnThisMachineYet'), rank: 1 }
                : { id: 'cantRun', label: t('machineAgents.cantRunOnThisMachine'), rank: 2 },
        }),
        statusMarker: <MachineAgentPickerMarker marker={row.placement.marker} />,
        ...(row.placement.marker === 'download' && row.agent.install.available && install && canPerformMachineAgentAction(row.agent, 'install', params.canManageMachine !== false) ? {
            statusAction: {
                testID: `new-session-engine-install-rail:${params.backendTargetKey}`,
                accessibilityLabel: t('machineAgents.installAgent', { agent: row.agent.title }),
                onPress: () => install(row.agent),
            },
        } : {}),
    };
}
