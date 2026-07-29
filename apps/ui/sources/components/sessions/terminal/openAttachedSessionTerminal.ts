import * as React from 'react';

import { isAttachedSessionTerminalAvailableForSession } from '@/agents/registry/registryUiBehavior';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useMachine, useSession } from '@/sync/domains/state/storage';

import { openEmbeddedTerminalInDockLocation } from './embeddedTerminalDocking';
import { setSessionTerminalMode } from './sessionTerminalMode';
import { useSessionTerminalAvailability } from './useSessionTerminalAvailability';

export type AttachedSessionTerminalUnavailableReason =
    | 'missing_session'
    | 'session_not_attachable'
    | 'missing_machine'
    | 'terminal_disabled'
    | 'cli_update_required';

export function useOpenAttachedSessionTerminal(sessionId: string | null): Readonly<{
    available: boolean;
    unavailableReason: AttachedSessionTerminalUnavailableReason | null;
    open: () => void;
}> {
    const normalizedSessionId = sessionId?.trim() ?? '';
    const pane = useAppPaneScope(`session:${normalizedSessionId}`);
    const cockpitChrome = useSessionCockpitChromeRegistration();
    const session = useSession(normalizedSessionId);
    const machineTarget = useSessionMachineTarget(normalizedSessionId);
    const machine = useMachine(machineTarget?.machineId ?? '');
    const terminalAvailability = useSessionTerminalAvailability();
    const unavailableReason: AttachedSessionTerminalUnavailableReason | null = !normalizedSessionId
        ? 'missing_session'
        : !session
            ? 'missing_session'
            : !isAttachedSessionTerminalAvailableForSession(session)
                ? 'session_not_attachable'
                : !machineTarget
                    ? 'missing_machine'
                    : !terminalAvailability.terminalEnabled
                        ? 'terminal_disabled'
                        : machine?.metadata?.daemonTerminalSessionAttachSupported !== true
                            ? 'cli_update_required'
                            : null;
    const available = unavailableReason === null;
    const open = React.useCallback(() => {
        if (!available) return;
        setSessionTerminalMode(normalizedSessionId, 'session_attach');
        if (
            cockpitChrome?.sessionId === normalizedSessionId
            && cockpitChrome.terminalTabAvailable
        ) {
            cockpitChrome.switchSurface('terminal');
            return;
        }
        openEmbeddedTerminalInDockLocation({ pane, dockLocation: terminalAvailability.dockLocation });
    }, [available, cockpitChrome, normalizedSessionId, pane, terminalAvailability.dockLocation]);
    return React.useMemo(() => ({ available, unavailableReason, open }), [available, open, unavailableReason]);
}
