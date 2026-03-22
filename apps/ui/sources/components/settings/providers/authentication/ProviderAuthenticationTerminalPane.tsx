import * as React from 'react';
import { Platform, View } from 'react-native';

import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/sessions/terminal/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import type { AgentId } from '@/agents/catalog/catalog';
import type { ProviderLocalAuthLaunch } from '@/agents/providers/shared/providerLocalAuthPlugin';
import { useMachine } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { buildTerminalAutoExitCommand } from './buildTerminalAutoExitCommand';

type ProviderAuthenticationTerminalPaneProps = Readonly<{
    providerId: AgentId;
    machineId: string | null;
    machineHomeDir: string | null;
    loginLaunch: ProviderLocalAuthLaunch | null;
    onRequestClose: () => void;
    onTerminalExit?: () => void;
}>;

export const ProviderAuthenticationTerminalPane = React.memo(function ProviderAuthenticationTerminalPane(props: ProviderAuthenticationTerminalPaneProps) {
    const machine = useMachine(props.machineId ?? '');
    const terminalRendererRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const machineReachable = Boolean(props.machineId && machine && isMachineOnline(machine));
    const machineRpcTargetAvailable = Boolean(props.machineId);
    const terminalCwd = React.useMemo(() => {
        const machineHomeDir = String(props.machineHomeDir ?? '').trim();
        return machineHomeDir || '/';
    }, [props.machineHomeDir]);
    const terminalKey = React.useMemo(
        () => `provider-login:${props.machineId ?? 'none'}:${props.providerId}`,
        [props.machineId, props.providerId],
    );
    const controller = useMachineTerminalSession({
        machineId: props.machineId,
        cwd: terminalCwd,
        machineReachable,
        machineRpcTargetAvailable,
        terminalKey,
        terminalRef: terminalRendererRef,
        initialCommand: props.loginLaunch?.initialCommand
            ? buildTerminalAutoExitCommand(props.loginLaunch.initialCommand, machine?.metadata?.platform)
            : null,
        closeOnUnmount: true,
    });

    const didNotifyExitRef = React.useRef(false);
    const didSendInitialInputRef = React.useRef(false);

    React.useEffect(() => {
        if (controller.status === 'connected') return;
        didSendInitialInputRef.current = false;
        if (controller.status !== 'exited') {
            didNotifyExitRef.current = false;
        }
    }, [controller.status]);

    React.useEffect(() => {
        if (controller.status !== 'exited' || didNotifyExitRef.current) return;
        didNotifyExitRef.current = true;
        props.onTerminalExit?.();
    }, [controller.status, props.onTerminalExit]);

    React.useEffect(() => {
        if (controller.status !== 'connected') return;
        const initialInput = props.loginLaunch?.initialInput;
        if (!initialInput || didSendInitialInputRef.current) return;
        didSendInitialInputRef.current = true;
        controller.onInput(initialInput);
    }, [controller, props.loginLaunch?.initialInput]);

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <EmbeddedTerminalPane
                title={t('settingsProviders.authentication.terminalTitle')}
                controller={controller}
                terminalRef={terminalRendererRef}
                onRequestClose={props.onRequestClose}
                testIdPrefix="provider-auth-terminal"
                showQuickKeys={Platform.OS !== 'web'}
            />
        </View>
    );
});
