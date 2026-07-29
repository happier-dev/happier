import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    DaemonBrowserControlDispatchRequestV1Schema,
    DaemonBrowserControlDispatchResponseV1Schema,
    type DaemonBrowserControlDispatchResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';

// W2-A-1 / A3: expose the existing `createBrowserDaemonControlRoutes` broker as a UI-reachable
// machine-scoped RPC. The human-owner control surface (streamed/sidecar view reload/stop/navigate)
// supplies a real `sendDaemonCommand` transport that routes a `BrowserCommandV1` here, through the
// SAME control broker the agent execution-run dispatch uses (MC-6 — one daemon control owner, no
// parallel path). The route is owner-scoped (account+machine, direct_ephemeral) — the user-initiated
// `ui` path, which never prompts; the agent path stays approval-floored at the action surface.
export type DaemonBrowserControlHandlerOptions = Readonly<{
    browserControl?: BrowserDaemonControlRoutes | null;
}>;

export function registerDaemonBrowserControlHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonBrowserControlHandlerOptions = {},
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
        async (raw: unknown): Promise<DaemonBrowserControlDispatchResponseV1> => {
            const request = DaemonBrowserControlDispatchRequestV1Schema.parse(raw);
            if (!options.browserControl) {
                throw new Error('Browser control runtime is unavailable');
            }
            const result = await options.browserControl.dispatchCommand(request.command);
            return DaemonBrowserControlDispatchResponseV1Schema.parse({
                protocolVersion: 1,
                result,
            });
        },
    );
}
