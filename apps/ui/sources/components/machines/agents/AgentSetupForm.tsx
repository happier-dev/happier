import * as React from 'react';

import { useAgentInstallJob } from '@/agents/machineAgents/installJobs/useAgentInstallJob';
import { useAgentSignIn } from '@/agents/machineAgents/signIn/useAgentSignIn';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { useMachineAgent } from '@/agents/machineAgents/useMachineAgents';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { AgentSetupFormView, type AgentSetupFormHandlers } from './AgentSetupFormView';
import { useAgentSignInTerminalHost } from './signInTerminalHost';
import { showAgentSignInTerminalSheet } from './AgentSignInTerminalSheet';

export type AgentSetupFormProps = Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    agentId: string;
    layout: 'full' | 'compact';
    /** Ready: start a session with this agent here. */
    onStartSession?: (agent: MachineAgent) => void;
    onSetUpAnother?: () => void;
    /** A connected service to connect first (the surface's own connect flow: Settings → Connected services, the Home panel). */
    onConnectService?: (serviceId: string) => void;
    /** Use a connected account for this agent on this machine. */
    onUseService?: (serviceId: string) => void;
    testID: string;
}>;

/**
 * The one agent-setup form, wired to its owners (lab `agent-setup`): the machine's inventory
 * (`useMachineAgent`), the daemon install job (`useAgentInstallJob`) and the native sign-in
 * (`useAgentSignIn`). Every surface — the machine's Agents section, Settings → Agents, the engine
 * popover, Home — renders this with its layout; none re-derives the state.
 */
export const AgentSetupForm = React.memo(function AgentSetupForm(props: AgentSetupFormProps) {
    const target = { serverId: props.serverId, machineId: props.machineId, agentId: props.agentId };
    const agent = useMachineAgent(target);
    const installJob = useAgentInstallJob(target);
    const signIn = useAgentSignIn(target);
    const terminalHost = useAgentSignInTerminalHost();
    const router = useRouter();
    const agentRef = React.useRef(agent);
    agentRef.current = agent;

    const install = React.useCallback((intent: 'install' | 'update') => {
        const current = agentRef.current;
        if (!current) return;
        // Pressing Install after the form said what runs (and whose installer) is the consent.
        fireAndForget(installJob.start(intent, { consent: { vendorRecipe: current.install.requiresVendorConsent } }), { tag: 'AgentSetupForm.install' });
    }, [installJob]);

    const openTerminal = React.useCallback(() => {
        const current = agentRef.current;
        if (!current) return;
        const terminalTarget = {
            serverId: props.serverId,
            machineId: props.machineId,
            machineName: props.machineName,
            agentId: props.agentId,
            agentTitle: current.title,
        };
        if (terminalHost) terminalHost.open(terminalTarget);
        else showAgentSignInTerminalSheet(terminalTarget);
    }, [props.agentId, props.machineId, props.machineName, props.serverId, terminalHost]);

    const handlers = React.useMemo((): AgentSetupFormHandlers => ({
        onInstall: () => install('install'),
        onRetry: () => install(agentRef.current?.job?.intent ?? 'install'),
        onCancelInstall: () => { fireAndForget(installJob.cancel(), { tag: 'AgentSetupForm.cancel' }); },
        onCheckAgain: () => { fireAndForget(signIn.checkAgain(), { tag: 'AgentSetupForm.checkAgain' }); },
        onOpenGuide: (url) => { fireAndForget(openExternalUrl(url), { tag: 'AgentSetupForm.guide' }); },
        onUseService: (serviceId) => props.onUseService?.(serviceId),
        onConnectService: (serviceId) => {
            // Connecting is the connected-services owner's flow; surfaces with it in place pass it in.
            if (props.onConnectService) props.onConnectService(serviceId);
            else router.push(`${SETTINGS_ROUTES.connectedServices}/${encodeURIComponent(serviceId)}` as never);
        },
        onOpenNativeSignIn: () => {
            fireAndForget(signIn.start(), { tag: 'AgentSetupForm.signIn' });
            openTerminal();
        },
        onShowTerminal: openTerminal,
        onCancelSignIn: () => { fireAndForget(signIn.cancel(), { tag: 'AgentSetupForm.cancelSignIn' }); },
        ...(props.onStartSession ? { onStartSession: () => { if (agentRef.current) props.onStartSession?.(agentRef.current); } } : {}),
        ...(props.onSetUpAnother ? { onSetUpAnother: props.onSetUpAnother } : {}),
    }), [install, installJob, openTerminal, props.onConnectService, props.onSetUpAnother, props.onStartSession, props.onUseService, router, signIn]);

    if (!agent) return null;
    return (
        <AgentSetupFormView
            testID={props.testID}
            agent={agent}
            machineName={props.machineName}
            layout={props.layout}
            session={signIn}
            handlers={handlers}
        />
    );
});
