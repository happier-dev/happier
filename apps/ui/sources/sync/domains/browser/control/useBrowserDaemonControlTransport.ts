import * as React from 'react';

import { createBrowserDaemonControlCommandSender, type BrowserDaemonControlCommandSender } from './machineRpc';

/**
 * Resolve a stable `sendDaemonCommand` transport for a browser surface (W2-A-1 / A3).
 *
 * Keeps the explicit Machine route when available; a shared Session supplies its own RPC scope.
 * Returns `undefined` without either admitted target and a server, leaving the control adapter's
 * existing `browser_control_route_unavailable` state.
 */
export function useBrowserDaemonControlTransport(
    input: Readonly<{
        machineId?: string | null;
        sessionId?: string | null;
        serverId?: string | null;
    }>,
): BrowserDaemonControlCommandSender | undefined {
    const machineId = input.machineId?.trim() ?? '';
    const serverId = input.serverId?.trim() ?? '';
    const sessionId = !machineId ? input.sessionId?.trim() ?? '' : '';
    const binding = React.useMemo(() => {
        if ((!machineId && !sessionId) || !serverId) {
            return undefined;
        }
        const lifetime = { controller: new AbortController() };
        const send = createBrowserDaemonControlCommandSender({ ...(machineId ? { machineId } : { sessionId }), serverId,
            get signal() { return lifetime.controller.signal; } });
        return { lifetime, send };
    }, [machineId, serverId, sessionId]);
    React.useEffect(() => {
        if (!binding) return;
        // React may replay the effect after cleanup while keeping the same sender.
        if (binding.lifetime.controller.signal.aborted) binding.lifetime.controller = new AbortController();
        return () => binding.lifetime.controller.abort();
    }, [binding]);
    return binding?.send;
}
