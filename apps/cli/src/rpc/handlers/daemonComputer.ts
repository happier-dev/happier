import { DaemonComputerActionExecuteRequestV1Schema, DaemonComputerActionExecuteResponseV1Schema } from '@happier-dev/protocol/computer/v1';
import type { DaemonComputerActionExecuteResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ComputerRoutes } from '@/daemon/computer/routes';

export type DaemonComputerHandlerOptions = Readonly<{
    /** The daemon's one computer owner, resolved per call (absent when this machine has no capture registry). */
    resolveComputer: () => ComputerRoutes | null;
}>;

/**
 * The person's computer controls (choose a window, look, stop, hand back, open the privacy pane) as an
 * owner-scoped machine RPC, dispatched to the SAME computer owner the agent's Session Actions use. Like the
 * browser control bridge, the route itself is the present user's: authority is stamped here and never read
 * from the payload, and the request names the Session whose target is meant. Agent input is not accepted
 * (the request schema admits only the present-user Action ids).
 */
export function registerDaemonComputerHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonComputerHandlerOptions,
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
        async (raw: unknown): Promise<DaemonComputerActionExecuteResponseV1> => {
            const request = DaemonComputerActionExecuteRequestV1Schema.parse(raw);
            const computer = options.resolveComputer();
            const result = computer
                ? await computer.dispatch(request.actionId, request.input, {
                    surface: 'ui',
                    authority: 'present_user',
                    defaultSessionId: request.sessionId,
                })
                : { ok: false, errorCode: 'computer_unavailable', error: 'computer_unavailable' };
            return DaemonComputerActionExecuteResponseV1Schema.parse({ protocolVersion: 1, result });
        },
    );
}
