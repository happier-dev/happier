import * as React from 'react';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { useAgentInstallJob } from '@/agents/machineAgents/installJobs/useAgentInstallJob';
import { useAgentSignIn } from '@/agents/machineAgents/signIn/useAgentSignIn';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { useMachineAgent } from '@/agents/machineAgents/useMachineAgents';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { Modal } from '@/modal';
import { t } from '@/text';

import { AgentSetupFormView, type AgentSetupFormHandlers } from './AgentSetupFormView';
import { useAgentSignInTerminalHost } from './signInTerminalHost';
import { showAgentSignInTerminalSheet } from './AgentSignInTerminalSheet';
import { buildAgentSetupCredentialIntents } from './agentSetupCredentialIntents';

export type AgentSetupFormProps = Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    agentId: string;
    definitionId?: string;
    layout: 'full' | 'compact';
    /** Ready: start a session with this agent here. */
    onStartSession?: (agent: MachineAgent) => void;
    onSetUpAnother?: () => void;
    /** A connected service to connect first (the surface's own connect flow: Settings → Connected services, the Home panel). */
    onConnectService?: (serviceId: string) => void;
    /** A surface floating over the page closes before the form routes away from it. */
    onLeave?: () => void;
    testID: string;
}>;

/**
 * The one agent-setup form, wired to its owners (lab `agent-setup`): the machine's inventory
 * (`useMachineAgent`), the daemon install job (`useAgentInstallJob`) and the native sign-in
 * (`useAgentSignIn`). Every surface — the machine's Agents section, Settings → Agents, the engine
 * popover, Home — renders this with its layout; none re-derives the state.
 */
export const AgentSetupForm = React.memo(function AgentSetupForm(props: AgentSetupFormProps) {
    const target = { serverId: props.serverId, machineId: props.machineId, agentId: props.agentId, definitionId: props.definitionId };
    const agent = useMachineAgent(target);
    const installJob = useAgentInstallJob(target);
    const signIn = useAgentSignIn(target);
    const terminalHost = useAgentSignInTerminalHost();
    const router = useRouter();
    const { mutateDefaults, execution } = useConnectedAccountPurposeDefaults(props.serverId);
    const agentRef = React.useRef(agent);
    agentRef.current = agent;

    const selectCredential = React.useCallback(async (serviceId: string | null) => {
        const current = agentRef.current;
        if (!current || !execution.isCurrent()) return false;
        for (const intent of buildAgentSetupCredentialIntents({ agent: current, machineId: props.machineId, serviceId })) {
            if (!await mutateDefaults(intent)) return false;
        }
        return execution.isCurrent();
    }, [execution.isCurrent, mutateDefaults, props.machineId]);
    const credentialFailure = React.useCallback(() => {
        Modal.alert(t('common.error'), t('errors.operationFailed'));
    }, []);

    const install = React.useCallback((intent: 'install' | 'update' | 'uninstall') => {
        const current = agentRef.current;
        if (!current) return;
        // The Action confirmation reviews the install and any vendor-recipe consent.
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
        onUseService: (serviceId) => {
            fireAndForget(selectCredential(serviceId), { tag: 'AgentSetupForm.selectCredential', onError: credentialFailure });
        },
        onConnectService: (serviceId) => {
            // Connecting is the connected-services owner's flow; surfaces with it in place pass it in.
            if (props.onConnectService) props.onConnectService(serviceId);
            else {
                props.onLeave?.();
                const serviceKey = resolveQualifiedConnectedAccountServiceKey(serviceId);
                const service = serviceKey ? parseQualifiedPluginContributionKey(serviceKey) : null;
                if (service) {
                    fireAndForget(presentConnectSheet({
                        scope: execution.binding?.scope ?? null,
                        service,
                        initialMachineTarget: {
                            serverIdentityId: captureServerProfileScopeResolver()(props.serverId),
                            machineId: props.machineId,
                        },
                    }), { tag: 'AgentSetupForm.connectService' });
                } else {
                    router.push(`${SETTINGS_ROUTES.connectedServices}/${encodeURIComponent(serviceId)}` as never);
                }
            }
        },
        onOpenNativeSignIn: () => {
            fireAndForget((async () => {
                if (!await selectCredential(null)) return;
                fireAndForget(signIn.start(), { tag: 'AgentSetupForm.signIn' });
                openTerminal();
            })(), { tag: 'AgentSetupForm.selectNativeCredential', onError: credentialFailure });
        },
        onShowTerminal: openTerminal,
        onCancelSignIn: () => { fireAndForget(signIn.cancel(), { tag: 'AgentSetupForm.cancelSignIn' }); },
        ...(props.onStartSession ? { onStartSession: () => { if (agentRef.current) props.onStartSession?.(agentRef.current); } } : {}),
        ...(props.onSetUpAnother ? { onSetUpAnother: props.onSetUpAnother } : {}),
    }), [credentialFailure, execution.binding, install, installJob, openTerminal, props.machineId, props.onConnectService, props.onLeave, props.onSetUpAnother, props.onStartSession, props.serverId, router, selectCredential, signIn]);

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
