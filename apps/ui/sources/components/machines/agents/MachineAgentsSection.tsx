import * as React from 'react';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { AgentSetupForm } from './AgentSetupForm';
import { MachineAgentMark } from './MachineAgentMark';
import { MachineAgentsSectionView } from './MachineAgentsSectionView';
import { useMachineAgentRowActions } from './useMachineAgentRowActions';

/**
 * The machine's Agents section (lab M1/M2) over the one inventory owner: rows for installed agents,
 * "Add an agent" for what could run here, each opening in place into `AgentSetupForm`. Row actions go
 * straight to the owners (install/update job, sign-in) and open the form so its steps are visible.
 */
export const MachineAgentsSection = React.memo(function MachineAgentsSection(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    /** See `MachineAgentsSectionView.titled`. */
    titled?: boolean;
    onStartSession?: (agent: MachineAgent) => void;
}>) {
    const inventory = useMachineAgents({ serverId: props.serverId, machineId: props.machineId });
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
    const setAgentExpanded = React.useCallback((agentId: string, open: boolean) => {
        setExpanded((current) => {
            if (current.has(agentId) === open) return current;
            const next = new Set(current);
            if (open) next.add(agentId); else next.delete(agentId);
            return next;
        });
    }, []);
    const openForm = React.useCallback((agent: MachineAgent) => setAgentExpanded(buildMachineAgentInventoryKey(agent), true), [setAgentExpanded]);
    const onAction = useMachineAgentRowActions({ serverId: props.serverId, machineId: props.machineId, machineName: props.machineName, onOpenForm: openForm });
    const refresh = inventory.refresh;
    return (
        <MachineAgentsSectionView
            testID="machine-agents"
            agents={inventory.agents}
            status={inventory.status}
            lastCheckedAt={inventory.lastCheckedAt}
            failure={inventory.failure}
            machineName={props.machineName}
            {...(props.titled === undefined ? {} : { titled: props.titled })}
            renderMark={(agent) => <MachineAgentMark agentId={agent.agentId} machineId={props.machineId} serverId={props.serverId} />}
            sessionFor={() => null}
            renderForm={(agent) => (
                <AgentSetupForm
                    testID={`machine-agents.form.${buildMachineAgentInventoryKey(agent)}`}
                    serverId={props.serverId}
                    machineId={props.machineId}
                    machineName={props.machineName}
                    agentId={agent.agentId}
                    definitionId={agent.definitionId}
                    layout="full"
                    {...(props.onStartSession ? { onStartSession: props.onStartSession } : {})}
                />
            )}
            expandedAgentIds={expanded}
            onExpandedChange={setAgentExpanded}
            onAction={onAction}
            onCheckAgain={() => { fireAndForget(refresh(), { tag: 'MachineAgentsSection.refresh' }); }}
        />
    );
});
