import * as React from 'react';

import { useMachineAgent } from '@/agents/machineAgents/useMachineAgents';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { useServerScopedMachine } from '@/sync/store/hooks';

import { AgentSetupForm } from './AgentSetupForm';
import { resolveAgentSetupPhase, type MachineAgentRowAction } from './machineAgentPresentation';
import { MachineAgentMark } from './MachineAgentMark';
import { MachineAgentRow } from './MachineAgentRow';
import { useMachineAgentRowActions } from './useMachineAgentRowActions';

/**
 * One agent on the selected machine, as Settings → Agents shows it (user default 2026-09-30: the same
 * model and form as the machine page): the agent's row, open into `AgentSetupForm` whenever there is
 * something to do (install, sign in, a failure), folded when it is ready.
 */
export const MachineAgentReadiness = React.memo(function MachineAgentReadiness(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    agentId: string;
    /** Open the form on arrival (a recovery that sent the person here to install, `?installIntent=`). */
    openForm?: boolean;
    testID: string;
}>) {
    const agent = useMachineAgent({ serverId: props.serverId, machineId: props.machineId, agentId: props.agentId });
    const phase = agent ? resolveAgentSetupPhase(agent) : null;
    const needsSetup = phase !== null && phase !== 'ready' && phase !== 'checking';
    const [expanded, setExpanded] = React.useState<boolean | null>(props.openForm ? true : null);
    const open = expanded ?? needsSetup;
    const openForm = React.useCallback(() => setExpanded(true), []);
    const canManage = useServerScopedMachine(props.serverId, props.machineId, canManageMachine);
    const runAction = useMachineAgentRowActions({ serverId: props.serverId, machineId: props.machineId, machineName: props.machineName, onOpenForm: openForm });
    const onAction = React.useCallback((action: MachineAgentRowAction) => { if (agent) runAction(agent, action); }, [agent, runAction]);
    if (!agent) {
        return <SurfaceStateCard testID={`${props.testID}.checking`} size="line" kind="loading" title={t('machineAgents.checking')} />;
    }
    return (
        <MachineAgentRow
            testID={props.testID}
            agent={agent}
            canManage={canManage}
            mark={<MachineAgentMark agentId={agent.agentId} machineId={props.machineId} serverId={props.serverId} />}
            onAction={onAction}
            form={agent.stale ? undefined : (
                <AgentSetupForm
                    testID={`${props.testID}.form`}
                    serverId={props.serverId}
                    machineId={props.machineId}
                    machineName={props.machineName}
                    agentId={props.agentId}
                    layout="full"
                />
            )}
            expanded={open}
            onExpandedChange={setExpanded}
            showDivider={false}
        />
    );
});
