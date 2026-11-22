import * as React from 'react';
import { Platform } from 'react-native';
import { machineAgentSignInTerminalKey } from '@happier-dev/protocol/daemon/agentSignIn';

import { useAgentSignIn } from '@/agents/machineAgents/signIn/useAgentSignIn';
import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import { useMachine } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { AgentSignInTerminalView } from './AgentSignInTerminalView';
import { MachineAgentMark } from './MachineAgentMark';
import type { AgentSignInTerminalTarget } from './signInTerminalHost';

/** The key of an agent's sign-in terminal on a machine; one per (machine, agent), reused on reopen. */
export const agentSignInTerminalKey = machineAgentSignInTerminalKey;

function readDeviceCode(preview: string): string | null {
    const text = preview.replace(/\u001b\[[0-9;]*m/g, '');
    const gitHub = /^! (?:First copy your one-time code: ([A-Z0-9]+-[A-Z0-9]+)|One-time code \(([A-Z0-9]+-[A-Z0-9]+)\) copied to clipboard)\r?\n/m.exec(text);
    const codex = /^(?:2\. )?Enter this one-time code \(expires in [0-9]+ minutes\)\r?\n[ \t]*([A-Z0-9]+-[A-Z0-9]+)\r?\n/m.exec(text);
    return gitHub?.[1] ?? gitHub?.[2] ?? codex?.[1] ?? null;
}

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
    const presence = useMachinePresenceSummary(props.serverId, props.machineId);
    const terminalRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const notifiedExitTerminalRef = React.useRef<string | null>(null);
    const [deviceCode, setDeviceCode] = React.useState<{ terminalId: string; code: string } | null>(null);
    const recognizedTerminal = React.useRef<string | null>(null);
    const onAttachedOutput = React.useCallback((terminalId: string, preview: string) => {
        if (recognizedTerminal.current === terminalId) return;
        const code = readDeviceCode(preview);
        if (!code) return;
        recognizedTerminal.current = terminalId;
        setDeviceCode({ terminalId, code });
    }, []);
    const terminalKey = signIn.terminalKey ?? agentSignInTerminalKey(props.machineId, props.agentId);
    const launch = React.useMemo(() => ({ kind: 'agent_login' as const, agentId: props.agentId }), [props.agentId]);
    const controller = useMachineTerminalSession({
        machineId: props.machineId,
        serverId: props.serverId,
        cwd: machine?.metadata?.homeDir?.trim() || null,
        launch,
        machineReachable: presence.reachability === 'unknown' ? null : presence.reachability === 'reachable',
        machineRpcTargetAvailable: true,
        terminalKey,
        attachedTerminalId: signIn.terminalId,
        onAttachedOutput,
        terminalRef,
        closeOnUnmount: false,
    });
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
        // Keep the mounted Action's confirmation and request alive until cancellation settles.
        fireAndForget((async () => {
            const result = await signIn.cancel();
            if (!result || result.ok) props.onClose();
        })(), { tag: 'AgentSignInTerminal.close' });
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
            deviceCode={signIn.phase === 'waiting' && deviceCode?.terminalId === signIn.terminalId ? deviceCode.code : null}
            terminal={terminal}
            handlers={{
                onOpenUrl: (url) => { fireAndForget(openExternalUrl(url), { tag: 'AgentSignInTerminal.openUrl' }); },
                onCheckAgain: () => { fireAndForget(signIn.checkAgain(), { tag: 'AgentSignInTerminal.checkAgain' }); },
                onCopyDeviceCode: () => {
                    if (deviceCode) fireAndForget(signIn.copyTerminalDeviceCode(deviceCode.terminalId, deviceCode.code), { tag: 'AgentSignInTerminal.copyDeviceCode', logError: false });
                },
                onClose: close,
                ...(props.onStartSession ? { onStartSession: props.onStartSession } : {}),
            }}
        />
    );
});
