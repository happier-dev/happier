import * as React from 'react';
import { Platform } from 'react-native';

import { useBrowserSessionAgentIdentity } from '@/components/browser/copresence/BrowserShellPresence';
import { noteSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { useMachine } from '@/sync/store/hooks';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import type { ComputerScreenViewerProps } from './ComputerScreenViewer';
import { computerTargetKey } from './ComputerTargetPicker';
import { openComputerTargetPickerForSession, resolveComputerTargetPickerForSession } from './openComputerTargetPickerForSession';
import type { ComputerTargetPickerRequest } from './showComputerTargetPicker';
import { useComputerScreenStream } from './useComputerScreenStream';
import { useComputerSessionControl } from './useComputerSessionControl';

/** Esc requests takeover while the Agent owns input; after takeover the target handles it. */
function useEscapeTakesControl(active: boolean, takeControl: () => void): void {
    React.useEffect(() => {
        if (!active || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            // Escape inside a floating frame's own chrome is the frame's (it restores an expanded view).
            const target = event.target as Element | null;
            if (target?.closest?.('[data-happier-floating-frame="true"]')) return;
            event.preventDefault();
            event.stopPropagation();
            takeControl();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [active, takeControl]);
}

/**
 * The controlled Computer body model, currently consumed by the Details pane. A shared
 * presentation host must retain this owner when changing shells, not mount another instance.
 */
export function useSessionComputerScreen(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    machineId: string;
    enabled?: boolean;
}>): Omit<ComputerScreenViewerProps, 'compact' | 'testID'> & Readonly<{
    /** The picker request at the person's intent, for a presentation that anchors the picker itself. */
    resolveChooseWindow: () => ComputerTargetPickerRequest | null;
}> {
    const accountLifetime = useSessionViewerSourceAccountLifetime();
    const serverId = props.serverId ?? accountLifetime?.scope.serverId ?? null;
    const identity = useBrowserSessionAgentIdentity({ sessionId: props.sessionId, serverId });
    const scope = React.useMemo(
        () => ({ sessionId: props.sessionId, machineId: props.machineId, serverId }),
        [props.machineId, serverId, props.sessionId],
    );
    const enabled = props.enabled ?? true;
    const control = useComputerSessionControl({ scope, refreshKey: identity.turnActive, enabled, accountLifetime });
    const stream = useComputerScreenStream({
        sessionId: props.sessionId,
        machineId: props.machineId,
        serverId,
        accountLifetime,
        sourceId: control.canRead ? control.selection?.sourceId ?? null : null,
        machineName: control.machineName,
        enabled,
        inputEnabled: control.canInput,
    });
    const streamStatus = stream?.playerState?.phase ?? null;
    const refreshControl = control.refresh;
    // Source availability changes are meaningful; changing image URLs are not status invalidations.
    React.useEffect(() => { if (enabled) refreshControl(); }, [enabled, refreshControl, streamStatus]);

    useEscapeTakesControl(enabled && control.presence.kind === 'agent', control.takeControl);
    React.useEffect(() => {
        noteSessionComputerMachine({ sessionId: props.sessionId, machineId: props.machineId, machineName: control.machineName });
    }, [control.machineName, props.machineId, props.sessionId]);

    const agent = React.useMemo(() => ({ agentId: identity.agentId, name: identity.name }), [identity.agentId, identity.name]);
    // The machine's presence, when this client holds its row: an unreachable machine is a cause to say.
    const machineRow = useMachine(props.machineId, enabled);
    const machineOnline = machineRow ? isMachineOnline(machineRow) : undefined;
    const selectedTarget = control.selection?.selectedTarget ?? null;
    const { applySelection, refresh } = control;
    const pickerParams = React.useCallback(() => ({
        sessionId: props.sessionId,
        serverId,
        accountLifetime,
        machineId: props.machineId,
        machineName: control.machineName ?? props.machineId,
        currentTargetKey: selectedTarget ? computerTargetKey(selectedTarget) : null,
        access: control.selection?.access ?? control.selection?.approvalDisplay.access,
        onSelected: applySelection,
        onStoppedSharing: refresh,
    }), [accountLifetime, applySelection, control.machineName, control.selection?.access, control.selection?.approvalDisplay.access, props.machineId, serverId, props.sessionId, refresh, selectedTarget]);
    const chooseWindow = React.useCallback(() => openComputerTargetPickerForSession(pickerParams()), [pickerParams]);
    const resolveChooseWindow = React.useCallback(() => resolveComputerTargetPickerForSession(pickerParams()), [pickerParams]);

    return {
        agent,
        targetTitle: control.targetTitle,
        appName: control.appName,
        access: control.selection?.access ?? control.selection?.approvalDisplay.access,
        targetKind: control.selection?.approvalDisplay.target?.kind ?? null,
        machineName: control.machineName,
        shared: Boolean(control.selection?.sourceId),
        inputDenied: control.inputDenied,
        machineOnline,
        grants: control.grants,
        openSettings: control.openSettings,
        onOpenSettings: control.requestSettings,
        onRefresh: control.refresh,
        stream,
        presence: control.presence,
        agentActing: control.agentActing,
        checking: control.busy === 'check',
        onTakeControl: control.takeControl,
        onHandBack: control.handBack,
        onCheckAgain: control.checkAgain,
        onChooseWindow: chooseWindow,
        resolveChooseWindow,
        onStopSharing: control.stopSharing,
    };
}
