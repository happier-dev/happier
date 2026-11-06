import * as React from 'react';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { withAgentInstallJobFailureFeedback } from '@/agents/machineAgents/installJobs/installJobActionFeedback';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

import type { MachineAgentRowAction } from './machineAgentPresentation';
import { showAgentSignInTerminalSheet } from './AgentSignInTerminalSheet';
import { useAgentSignInTerminalHost } from './signInTerminalHost';

/**
 * What a row's or card's one action does, on every surface: install / update / try again start the
 * daemon job, Cancel stops it, Sign in opens the agent's form (where the way to sign in is chosen),
 * Show terminal brings its sign-in terminal back, Setup guide opens the vendor's guide. `onOpenForm` is
 * the surface's way to show the form (expand the row, open the machine page).
 */
export function useMachineAgentRowActions(input: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    onOpenForm: (agent: MachineAgent) => void;
}>): (agent: MachineAgent, action: MachineAgentRowAction) => void {
    const terminalHost = useAgentSignInTerminalHost();
    const { serverId, machineId, machineName, onOpenForm } = input;
    const { binding, execute, isCurrent } = useMountedActionExecution(serverId);
    return React.useCallback((agent, action) => {
        const target = { serverId, machineId, agentId: agent.agentId, definitionId: agent.definitionId };
        switch (action.kind) {
            case 'install':
            case 'retry':
            case 'update': {
                if (!binding?.isCurrent()) return;
                const intent = action.kind === 'retry' ? agent.job?.intent ?? 'install' : action.kind;
                fireAndForget(withAgentInstallJobFailureFeedback(execute(intent === 'uninstall' ? 'machines.agents.uninstall' : 'machines.agents.install', {
                    machineId, agentId: agent.agentId, ...(agent.definitionId === undefined ? {} : { definitionId: agent.definitionId }),
                    // Consent is reviewed by the shared Action confirmation before execution.
                    ...(intent === 'uninstall' ? {} : { intent, consent: { vendorRecipe: agent.install.requiresVendorConsent } }),
                }), isCurrent), { tag: 'machineAgentRowAction.install' });
                onOpenForm(agent);
                return;
            }
            case 'remove':
                // Removing confirms through the uninstall Action's own policy (D22: deletions confirm).
                if (!binding?.isCurrent()) return;
                fireAndForget(withAgentInstallJobFailureFeedback(execute('machines.agents.uninstall', {
                    machineId, agentId: agent.agentId, ...(agent.definitionId === undefined ? {} : { definitionId: agent.definitionId }),
                }), isCurrent), { tag: 'machineAgentRowAction.remove' });
                return;
            case 'cancel':
                if (!binding?.isCurrent() || !agent.job || agent.job.outcome) return;
                fireAndForget(withAgentInstallJobFailureFeedback(execute('machines.agents.install.cancel', { machineId, jobId: agent.job.jobId }), isCurrent), { tag: 'machineAgentRowAction.cancel' });
                return;
            case 'signIn':
                onOpenForm(agent);
                return;
            case 'showTerminal': {
                const terminalTarget = { ...target, machineName, agentTitle: agent.title };
                if (terminalHost) terminalHost.open(terminalTarget);
                else showAgentSignInTerminalSheet(terminalTarget);
                return;
            }
            case 'guide':
                fireAndForget(openExternalUrl(action.url), { tag: 'machineAgentRowAction.guide' });
                return;
        }
    }, [binding, execute, isCurrent, machineId, machineName, onOpenForm, serverId, terminalHost]);
}
