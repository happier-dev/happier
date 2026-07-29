import * as React from 'react';

import { apiSocket } from '@/sync/api/session/apiSocket';

import { registerDesktopBrowserRecordingReverseCaptureHandler } from './reverseCaptureAvailability';

function normalizeMachineId(machineId: string | null | undefined): string | null {
    const normalizedMachineId = machineId?.trim() ?? '';
    return normalizedMachineId.length > 0 ? normalizedMachineId : null;
}

export function DesktopBrowserRecordingReverseCaptureRuntime(props: Readonly<{
    machineId?: string | null;
}>): null {
    const machineId = React.useMemo(() => normalizeMachineId(props.machineId), [props.machineId]);

    React.useEffect(() => {
        if (!machineId) {
            return undefined;
        }

        const disposeRpc = apiSocket.installBrowserRecordingReverseCapture(machineId);
        const disposeAvailability = registerDesktopBrowserRecordingReverseCaptureHandler(machineId);

        return () => {
            disposeAvailability();
            disposeRpc();
        };
    }, [machineId]);

    return null;
}
