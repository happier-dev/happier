import * as React from 'react';
import { Platform } from 'react-native';

import { useBrowserSessionAgentIdentity } from '@/components/browser/copresence/BrowserShellPresence';
import { noteSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import { useDeviceType } from '@/utils/platform/responsive';

import { ComputerScreenViewer } from './ComputerScreenViewer';
import { computerTargetKey } from './ComputerTargetPicker';
import { openComputerTargetPickerForSession } from './openComputerTargetPickerForSession';
import { useComputerScreenStream } from './useComputerScreenStream';
import { useComputerSessionControl } from './useComputerSessionControl';

/**
 * Esc stops the agent while it holds the window (lab LV: "Take control · Esc"). Captured before the
 * stream's own key forwarding, and only while the agent may act, so after the takeover Esc reaches the
 * window like any other key the person types.
 */
function useEscapeTakesControl(active: boolean, takeControl: () => void): void {
    React.useEffect(() => {
        if (!active || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            takeControl();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [active, takeControl]);
}

/**
 * The Session's shared window in Details (lab `computer` LV): the computer owner's selection and
 * control status, the live `screen` stream for that exact source, and the person's controls.
 */
export function SessionComputerScreenPane(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    machineId: string;
    testID?: string;
}>): React.ReactElement {
    const identity = useBrowserSessionAgentIdentity({ sessionId: props.sessionId, serverId: props.serverId ?? null });
    const scope = React.useMemo(
        () => ({ sessionId: props.sessionId, machineId: props.machineId, serverId: props.serverId ?? null }),
        [props.machineId, props.serverId, props.sessionId],
    );
    const control = useComputerSessionControl({ scope, refreshKey: identity.turnActive });
    const stream = useComputerScreenStream({
        sessionId: props.sessionId,
        machineId: props.machineId,
        serverId: props.serverId ?? null,
        sourceId: control.selection?.sourceId ?? null,
        machineName: control.machineName,
    });
    const streamStatus = stream?.playerState?.phase ?? null;
    const refreshControl = control.refresh;
    // Source availability changes are meaningful; changing image URLs are not status invalidations.
    React.useEffect(() => { refreshControl(); }, [refreshControl, streamStatus]);

    useEscapeTakesControl(control.presence.kind === 'agent', control.takeControl);
    React.useEffect(() => {
        noteSessionComputerMachine({ sessionId: props.sessionId, machineId: props.machineId, machineName: control.machineName });
    }, [control.machineName, props.machineId, props.sessionId]);

    const agent = React.useMemo(() => ({ agentId: identity.agentId, name: identity.name }), [identity.agentId, identity.name]);
    const selectedTarget = control.selection?.selectedTarget ?? null;
    const { applySelection, refresh } = control;
    const chooseWindow = React.useCallback(() => {
        openComputerTargetPickerForSession({
            sessionId: props.sessionId,
            serverId: props.serverId ?? null,
            machineId: props.machineId,
            machineName: control.machineName ?? props.machineId,
            currentTargetKey: selectedTarget ? computerTargetKey(selectedTarget) : null,
            access: control.selection?.access ?? control.selection?.approvalDisplay.access,
            onSelected: applySelection,
            onStoppedSharing: refresh,
        });
    }, [applySelection, control.machineName, control.selection?.access, control.selection?.approvalDisplay.access, props.machineId, props.serverId, props.sessionId, refresh, selectedTarget]);

    return (
        <ComputerScreenViewer
            testID={props.testID}
            agent={agent}
            targetTitle={control.targetTitle}
            appName={control.appName}
            access={control.selection?.access ?? control.selection?.approvalDisplay.access}
            targetKind={control.selection?.approvalDisplay.target?.kind ?? null}
            machineName={control.machineName}
            shared={Boolean(control.selection?.sourceId)}
            stream={stream}
            presence={control.presence}
            agentActing={control.agentActing}
            checking={control.busy === 'check'}
            onTakeControl={control.takeControl}
            onHandBack={control.handBack}
            onCheckAgain={control.checkAgain}
            onChooseWindow={chooseWindow}
            onStopSharing={control.stopSharing}
            compact={useDeviceType() === 'phone'}
        />
    );
}
