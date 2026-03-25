import * as React from 'react';

import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';

export function useSessionFileUploadAvailability(sessionId: string): boolean {
    const { machineRpcTargetAvailable } = useSessionMachineReachability(sessionId);
    return React.useMemo(() => {
        // Uploading into a session workspace requires the machine RPC target.
        return Boolean(machineRpcTargetAvailable);
    }, [machineRpcTargetAvailable]);
}
