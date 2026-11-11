import * as React from 'react';

import { noteSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { describeCheckoutUnreachable, useCheckoutReachabilityPresentation } from '@/components/workspaces/reachability/checkoutReachabilityModel';

import type { ComputerScreenViewerProps } from './ComputerScreenViewer';
import { computerTargetKey } from './ComputerTargetPicker';
import { resolveComputerTargetPickerForSession } from './openComputerTargetPickerForSession';
import { showComputerTargetPicker, type ComputerTargetPickerRequest } from './showComputerTargetPicker';
import type { ComputerScope, ComputerMachinePersonScope, ComputerActionExecute } from '@/sync/domains/computer/computerControlClient';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { useComputerScreenStream, type ComputerScreenTransport } from './useComputerScreenStream';
import { useComputerSessionControl } from './useComputerSessionControl';
import { useComputerDriverRepair } from './useComputerDriverRepair';
import { useEscapeTakesControl } from './useEscapeTakesControl';
import { createRemoteViewerClipboardShortcut } from '@/components/stream/remoteViewerClipboard';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

/**
 * The controlled Computer body model, currently consumed by the Details pane. A shared
 * presentation host must retain this owner when changing shells, not mount another instance.
 */
export function useMachineComputerScreen(props: Readonly<{
    scope: ComputerMachinePersonScope;
    accountLifetime: ServerAccountScopeLifetime | null;
    enabled?: boolean;
}>) {
    return useComputerScreen(props);
}

/** Session and Machine pages consume this same control, capture, picker and stream model. */
export function useComputerScreen(props: Readonly<{
    scope: ComputerScope;
    accountLifetime?: ServerAccountScopeLifetime | null;
    execute?: ComputerActionExecute;
    transport?: ComputerScreenTransport;
    enabled?: boolean;
    agent?: ComputerScreenViewerProps['agent'];
    refreshKey?: unknown;
}>): Omit<ComputerScreenViewerProps, 'compact' | 'testID'> & Readonly<{
    resolveChooseWindow: () => ComputerTargetPickerRequest | null;
    /** The shared source, for the Session's recorder. */
    sourceId: string | null;
}> {
    const { scope, accountLifetime } = props;
    const serverId = scope.serverId ?? accountLifetime?.scope.serverId ?? null;
    const enabled = props.enabled ?? true;
    const writeClipboard = useClipboardWrite(accountLifetime?.scope ?? serverId, { enabled });
    const control = useComputerSessionControl({ scope, refreshKey: props.refreshKey, enabled, accountLifetime, execute: props.execute });
    const clipboardOperation = control.clipboard;
    const clipboardShortcut = React.useMemo(() => createRemoteViewerClipboardShortcut({
        write: async text => {
            const result = await clipboardOperation({ kind: 'write', text });
            if (!result.ok) throw new Error(result.code);
        },
        read: async action => {
            if (action === 'cut') throw new Error('clipboard_not_supported');
            const result = await clipboardOperation({ kind: 'read' });
            if (!result.ok) throw new Error(result.code);
            if (result.text === undefined) throw new Error('clipboard_text_unavailable');
            return result.text;
        },
    }, writeClipboard), [clipboardOperation, writeClipboard]);
    const driverRepair = useComputerDriverRepair(scope, accountLifetime, control.refresh);
    const stream = useComputerScreenStream({
        scope,
        machineId: scope.machineId,
        serverId,
        accountLifetime,
        sourceId: control.canRead ? control.selection?.sourceId ?? null : null,
        machineName: control.machineName,
        enabled,
        inputEnabled: control.canInput,
        clipboardShortcut,
        transport: props.transport,
    });
    const streamStatus = stream?.playerState?.phase ?? null;
    const refreshControl = control.refresh;
    // Source availability changes are meaningful; changing image URLs are not status invalidations.
    React.useEffect(() => { if (enabled) refreshControl(); }, [enabled, refreshControl, streamStatus]);

    // Only while the capsule offers Take control: a see-only share or a machine denying input has none.
    const access = control.selection?.access ?? control.selection?.approvalDisplay.access;
    useEscapeTakesControl(enabled && control.presence.kind === 'agent' && access !== 'see' && control.inputDenied !== true, control.takeControl);
    React.useEffect(() => {
        if (scope.sessionId) noteSessionComputerMachine({ sessionId: scope.sessionId, serverId, accountLifetime, machineId: scope.machineId, machineName: control.machineName });
    }, [accountLifetime, control.machineName, scope.machineId, scope.sessionId, serverId]);

    const fallbackName = t('browserPresence.agentFallbackName');
    const agent = React.useMemo(() => props.agent ?? { agentId: null, name: fallbackName }, [fallbackName, props.agent]);
    // The machine's presence, when this client holds its row: an unreachable machine is a cause to say.
    const machinePresence = useMachinePresenceSummary(serverId, enabled ? scope.machineId : null);
    const reachability = useCheckoutReachabilityPresentation(serverId ? { serverId, machineId: scope.machineId } : null, machinePresence);
    const machineOnline = machinePresence.reachability === 'unknown' ? undefined : machinePresence.reachability === 'reachable';
    // Control owns the Machine's readable name. Presence titles can be "Loading…" or "Locked machine",
    // which are status placeholders, not names to put in recovery sentences. Unnamed copy stays generic.
    const machineName = control.machineName;
    const selectedTarget = control.selection?.selectedTarget ?? null;
    const { applySelection } = control;
    const resolveChooseWindow = React.useCallback((): ComputerTargetPickerRequest | null => {
        const params = {
            serverId, accountLifetime, machineId: scope.machineId, machineName,
            currentTargetKey: selectedTarget ? computerTargetKey(selectedTarget) : null,
            access: control.selection?.access ?? control.selection?.approvalDisplay.access,
            onSelected: applySelection,
        };
        if (scope.sessionId) {
            const request = resolveComputerTargetPickerForSession({ ...params, sessionId: scope.sessionId });
            return request && props.execute ? { ...request, execute: props.execute } : request;
        }
        if (!accountLifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(accountLifetime.scope, serverId)) return null;
        return { ...params, scope, purpose: null, machineName: machineName ?? t('computerUse.presentation.tabFallback'),
            agentName: t('browserPresence.agentFallbackName'), agentless: true, currentTargetKey: params.currentTargetKey };
    }, [accountLifetime, applySelection, control.selection?.access, control.selection?.approvalDisplay.access, machineName, props.execute, scope, selectedTarget, serverId]);
    const chooseWindow = React.useCallback(() => {
        const request = resolveChooseWindow();
        if (request) showComputerTargetPicker(request);
    }, [resolveChooseWindow]);

    return {
        agent,
        agentless: props.agent === undefined,
        targetTitle: control.targetTitle,
        appName: control.appName,
        access: control.selection?.access ?? control.selection?.approvalDisplay.access,
        targetKind: control.selection?.approvalDisplay.target?.kind ?? null,
        machineName,
        shared: Boolean(control.selection?.sourceId),
        sourceId: control.selection?.sourceId ?? null,
        selectionPending: control.selection === null && control.failure === null,
        inputDenied: control.inputDenied,
        machineOnline,
        offlineReason: reachability.unreachable ? describeCheckoutUnreachable(reachability) : null,
        grants: control.grants,
        openSettings: control.openSettings,
        onOpenSettings: control.requestSettings,
        onRefresh: control.refresh,
        stream,
        presence: control.presence,
        agentActing: control.agentActing,
        checking: control.busy === 'check',
        stopping: control.busy === 'stop',
        failure: control.failure,
        failureCause: control.failureCause,
        stopFailed: control.stopFailed,
        onRepairDriver: driverRepair.repair,
        repairingDriver: driverRepair.repairing,
        onTakeControl: control.takeControl,
        onHandBack: control.handBack,
        onCheckAgain: control.checkAgain,
        onChooseWindow: chooseWindow,
        resolveChooseWindow,
        onStopSharing: control.stopSharing,
    };
}
