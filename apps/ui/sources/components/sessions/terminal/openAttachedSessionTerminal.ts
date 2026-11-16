import * as React from 'react';

import { isAttachedSessionTerminalAvailableForSession } from '@/agents/registry/registryUiBehavior';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useReadSessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { getStorage, useMachine, useServerScopedMachine } from '@/sync/domains/state/storage';

import { openEmbeddedTerminalInDockLocation } from './embeddedTerminalDocking';
import { setSessionTerminalMode } from './sessionTerminalMode';
import { useSessionTerminalAvailability } from './useSessionTerminalAvailability';
import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { t } from '@/text';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';

export type AttachedSessionTerminalUnavailableReason =
    | 'missing_session'
    | 'session_not_attachable'
    | 'missing_machine'
    | 'terminal_disabled'
    | 'cli_update_required';

/**
 * Why the agent's own terminal cannot be shown, in words. `session_not_attachable` names the host
 * requirement only where the caller offers the terminal itself (the pane's + menu); the chat card
 * stays silent for it because it never offers the terminal then.
 */
export function resolveAttachedTerminalUnavailableMessage(
    reason: AttachedSessionTerminalUnavailableReason | null,
    options?: Readonly<{ includeNotAttachable?: boolean }>,
): string | null {
    switch (reason) {
        case 'missing_machine':
            return t('terminalEmbedded.errors.missingMachineTarget');
        case 'terminal_disabled':
            return t('terminalEmbedded.errors.disabled');
        case 'cli_update_required':
            return t('deps.ui.notAvailableUpdateCli');
        case 'session_not_attachable':
            return options?.includeNotAttachable ? t('terminalWorkspace.agentNotAttachable') : null;
        default:
            return null;
    }
}

export function useOpenAttachedSessionTerminal(sessionId: string | null, serverId?: string | null, suppliedSession?: Session | null): Readonly<{
    available: boolean;
    unavailableReason: AttachedSessionTerminalUnavailableReason | null;
    open: () => void;
}> {
    const normalizedSessionId = sessionId?.trim() ?? '';
    const normalizedServerId = serverId?.trim() || null;
    const pane = useAppPaneScope(useDestinationPaneScopeId(createSessionPaneScopeId(normalizedSessionId, normalizedServerId)));
    const readCockpitChrome = useReadSessionCockpitChromeRegistration();
    // Subscription width: this hook feeds `SessionHeaderRightElement`, whose
    // `onSelectExtraItem` identity gates `SessionHeaderActionMenu`'s comparator. Subscribing
    // to the whole `Session` record re-rendered the header chrome on every turn-lifecycle
    // field a send touches (thinking, agentState, agentStateVersion, updatedAt, seq), none of
    // which can change attachability. Select the decision itself, not the record.
    const sessionAttachability = getStorage()((state): 'missing_session' | 'session_not_attachable' | null => {
        if (!normalizedSessionId) return 'missing_session';
        const suppliedSessionMatches = suppliedSession?.id === normalizedSessionId
            && (!normalizedServerId || areServerProfileIdentifiersEquivalent(suppliedSession.serverId, normalizedServerId));
        const session = suppliedSessionMatches ? suppliedSession : state.sessions[normalizedSessionId];
        if (!session || (normalizedServerId && !areServerProfileIdentifiersEquivalent(session.serverId, normalizedServerId))) return 'missing_session';
        return isAttachedSessionTerminalAvailableForSession(session) ? null : 'session_not_attachable';
    });
    const machineTarget = useSessionMachineTarget(normalizedSessionId, normalizedServerId);
    const legacyMachine = useMachine(normalizedServerId ? '' : machineTarget?.machineId ?? '');
    const scopedMachine = useServerScopedMachine(normalizedServerId, normalizedServerId ? machineTarget?.machineId ?? '' : '');
    const machine = normalizedServerId ? scopedMachine : legacyMachine;
    const terminalAvailability = useSessionTerminalAvailability(normalizedServerId);
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
        setSessionTerminalMode(normalizedSessionId, 'session_attach', normalizedServerId, pane.scopeId);
        const cockpitChrome = readCockpitChrome();
        if (
            cockpitChrome?.sessionId === normalizedSessionId
            && (!normalizedServerId || areServerProfileIdentifiersEquivalent(cockpitChrome.serverId, normalizedServerId))
            && cockpitChrome.terminalTabAvailable
        ) {
            cockpitChrome.switchSurface('terminal');
            return;
        }
        openEmbeddedTerminalInDockLocation({ pane, dockLocation: terminalAvailability.dockLocation });
    }, [available, readCockpitChrome, normalizedSessionId, normalizedServerId, pane, terminalAvailability.dockLocation]);
    return React.useMemo(() => ({ available, unavailableReason, open }), [available, open, unavailableReason]);
}
