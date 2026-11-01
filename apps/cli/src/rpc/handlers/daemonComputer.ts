import { DaemonComputerActionExecuteRequestV1Schema, DaemonComputerActionExecuteResponseV1Schema } from '@happier-dev/protocol/computer/v1';
import type { DaemonComputerActionExecuteResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ComputerRoutes } from '@/daemon/computer/routes';

export type DaemonComputerHandlerOptions = Readonly<{
    /** The daemon's one computer owner, resolved per call (absent when this machine has no capture registry). */
    resolveComputer: () => ComputerRoutes | null;
}>;

/**
 * The person's computer controls (choose a window, look, stop, hand back, open the privacy pane) as an
 * owner-scoped machine RPC, dispatched to the SAME computer owner the agent's Session Actions use. Like the
 * browser control bridge, authority and cancellation come from verified RPC context, never the payload.
 * The request names the Session whose target is meant; the shared computer owner admits control.
 */
export function registerDaemonComputerHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonComputerHandlerOptions,
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
        async (raw: unknown, context?: RpcHandlerContext): Promise<DaemonComputerActionExecuteResponseV1> => {
            const request = DaemonComputerActionExecuteRequestV1Schema.parse(raw);
            const computer = options.resolveComputer();
            // This raw route is the person's. Agents use the Computer Actions, whose approval policy owns Ask.
            const result = context?.callerAuthority !== 'present_user'
                ? { ok: false, errorCode: 'approval_required', error: 'approval_required' }
                : computer
                ? await computer.dispatch(request.actionId, request.input, {
                    surface: 'ui',
                    authority: context.callerAuthority,
                    signal: context.signal,
                    defaultSessionId: request.sessionId,
                })
                : { ok: false, errorCode: 'computer_unavailable', error: 'computer_unavailable' };
            return DaemonComputerActionExecuteResponseV1Schema.parse({ protocolVersion: 1, result });
        },
    );
}
