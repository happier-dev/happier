import * as React from 'react';
import { Platform } from 'react-native';
import { machineAgentSignInTerminalKey } from '@happier-dev/protocol/daemon/agentSignIn';

import { useAgentSignIn } from '@/agents/machineAgents/signIn/useAgentSignIn';
import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import { useMachine } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import { AgentSignInTerminalView } from './AgentSignInTerminalView';
import { MachineAgentMark } from './MachineAgentMark';
import type { AgentSignInTerminalTarget } from './signInTerminalHost';

/** The key of an agent's sign-in terminal on a machine; one per (machine, agent), reused on reopen. */
export const agentSignInTerminalKey = machineAgentSignInTerminalKey;

/**
 * The agent's own sign-in running in a machine terminal (lab T1), wired to the sign-in owner
 * (`useAgentSignIn`: phase, the link the CLI printed, the status probe) and one terminal session with the
 * daemon-resolved `agent_login` launch. Rendered in a page's bottom pane (`pane`) or in a sheet (`sheet`).
 */
export const AgentSignInTerminal = React.memo(function AgentSignInTerminal(props: AgentSignInTerminalTarget & Readonly<{
    layout: 'pane' | 'sheet';
    onClose: () => void;
    onStartSession?: () => void;
    onTerminalExit?: () => void;
}>) {
    const target = { serverId: props.serverId, machineId: props.machineId, agentId: props.agentId };
    const signIn = useAgentSignIn(target);
    const machine = useMachine(props.machineId);
    const terminalRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const didStartRef = React.useRef(false);
    const notifiedExitTerminalRef = React.useRef<string | null>(null);
    const terminalKey = signIn.terminalKey ?? agentSignInTerminalKey(props.machineId, props.agentId);
    const launch = React.useMemo(() => ({ kind: 'agent_login' as const, agentId: props.agentId }), [props.agentId]);
    const controller = useMachineTerminalSession({
        machineId: props.machineId,
        serverId: props.serverId,
        cwd: machine?.metadata?.homeDir?.trim() || null,
        launch,
        machineReachable: Boolean(machine && isMachineOnline(machine)),
        machineRpcTargetAvailable: true,
        terminalKey,
        attachedTerminalId: signIn.terminalId,
        terminalRef,
        closeOnUnmount: false,
    });
    React.useEffect(() => {
        if (didStartRef.current || !signIn.available) return;
        didStartRef.current = true;
        if (signIn.phase === 'idle') fireAndForget(signIn.start(), { tag: 'AgentSignInTerminal.start' });
    }, [signIn.available, signIn.phase, signIn.start]);
    React.useEffect(() => {
        signIn.reportTerminalUrl(controller.detectedUrl);
    }, [controller.detectedUrl, signIn.reportTerminalUrl]);
    React.useEffect(() => {
        if (controller.status !== 'exited' || !controller.terminalId || controller.terminalId !== signIn.terminalId || notifiedExitTerminalRef.current === controller.terminalId) return;
        notifiedExitTerminalRef.current = controller.terminalId;
        fireAndForget(signIn.reportTerminalExit(controller.terminalId), { tag: 'AgentSignInTerminal.exit' });
        props.onTerminalExit?.();
    }, [controller.status, controller.terminalId, props.onTerminalExit, signIn.reportTerminalExit, signIn.terminalId]);
    React.useEffect(() => {
        if (controller.status === 'error' && controller.error) signIn.reportTerminalFailure(controller.error);
    }, [controller.error, controller.status, signIn.reportTerminalFailure]);
    const close = React.useCallback(() => {
        fireAndForget(signIn.cancel(), { tag: 'AgentSignInTerminal.close' });
        props.onClose();
    }, [props, signIn]);
    const terminal = (
        <EmbeddedTerminalPane
            title={t('machineAgents.terminalTab', { agent: props.agentTitle })}
            controller={{ ...controller, requestRestart: () => {
                fireAndForget(signIn.restart(), { tag: 'AgentSignInTerminal.restart' });
            } }}
            terminalRef={terminalRef}
            onRequestClose={close}
            testIdPrefix="agent-sign-in-terminal"
            nativeSurfaceKey={terminalKey}
            showQuickKeys={Platform.OS !== 'web'}
        />
    );
    return (
        <AgentSignInTerminalView
            testID="agent-sign-in"
            layout={props.layout}
            agentTitle={props.agentTitle}
            mark={<MachineAgentMark agentId={props.agentId} machineId={props.machineId} serverId={props.serverId} size={props.layout === 'sheet' ? 22 : 16} />}
            machineName={props.machineName}
            session={signIn}
            accountLabel={signIn.accountLabel}
            terminal={terminal}
            handlers={{
                onOpenUrl: (url) => { fireAndForget(openExternalUrl(url), { tag: 'AgentSignInTerminal.openUrl' }); },
                onCheckAgain: () => { fireAndForget(signIn.checkAgain(), { tag: 'AgentSignInTerminal.checkAgain' }); },
                onClose: close,
                ...(props.onStartSession ? { onStartSession: props.onStartSession } : {}),
            }}
        />
    );
});
