import * as React from 'react';

import { isAttachedSessionTerminalAvailableForSession } from '@/agents/registry/registryUiBehavior';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { getStorage, useMachine } from '@/sync/domains/state/storage';

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
    // Subscription width: this hook feeds `SessionHeaderRightElement`, whose
    // `onSelectExtraItem` identity gates `SessionHeaderActionMenu`'s comparator. Subscribing
    // to the whole `Session` record re-rendered the header chrome on every turn-lifecycle
    // field a send touches (thinking, agentState, agentStateVersion, updatedAt, seq), none of
    // which can change attachability. Select the decision itself, not the record.
    const sessionAttachability = getStorage()((state): 'missing_session' | 'session_not_attachable' | null => {
        if (!normalizedSessionId) return 'missing_session';
        const session = state.sessions[normalizedSessionId];
        if (!session) return 'missing_session';
        return isAttachedSessionTerminalAvailableForSession(session) ? null : 'session_not_attachable';
    });
    const machineTarget = useSessionMachineTarget(normalizedSessionId);
    const machine = useMachine(machineTarget?.machineId ?? '');
    const terminalAvailability = useSessionTerminalAvailability();
    const unavailableReason: AttachedSessionTerminalUnavailableReason | null = sessionAttachability !== null
        ? sessionAttachability
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
