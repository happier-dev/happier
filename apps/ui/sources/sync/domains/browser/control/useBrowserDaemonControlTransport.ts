import type { BrowserCommandV1 } from '@happier-dev/protocol';
import * as React from 'react';

import { createBrowserDaemonControlCommandSender } from './machineRpc';

/**
 * Resolve a stable `sendDaemonCommand` transport for a browser surface (W2-A-1 / A3).
 *
 * Returns a memoized fire-and-forget sender keyed on `(machineId, serverId)` so daemon-authoritative
 * views (`chromiumSidecar`/`streamedBrowserSurface`) dispatch reload/stop/navigate through the daemon
 * control broker over machine RPC. Returns `undefined` when the surface has no resolved machine/server
 * context, so the control adapter falls back to its honest `browser_control_route_unavailable` state
 * rather than dispatching against an unknown machine.
 */
export function useBrowserDaemonControlTransport(
    input: Readonly<{
        machineId?: string | null;
        serverId?: string | null;
    }>,
): ((command: BrowserCommandV1) => void) | undefined {
    const machineId = input.machineId?.trim() ?? '';
    const serverId = input.serverId?.trim() ?? '';
    return React.useMemo(() => {
        if (!machineId || !serverId) {
            return undefined;
        }
        return createBrowserDaemonControlCommandSender({ machineId, serverId });
    }, [machineId, serverId]);
}
