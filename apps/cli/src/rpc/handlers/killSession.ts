import type { RpcHandlerRegistrar } from "@/api/rpc/types";
import { logger } from "@/ui/logger";
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

interface KillSessionRequest {
    // No parameters needed
}

interface KillSessionResponse {
    status: 'requested';
}


export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerRegistrar,
    killThisHappier: () => Promise<void>
) {
    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>(RPC_METHODS.KILL_SESSION, async () => {
        logger.debug('Kill session request received');

        // A runner cannot observe its own physical exit over the RPC it is serving.
        // Initiate cleanup, but report only that the request was accepted.
        void killThisHappier().catch((error) => {
            logger.warn('Kill session cleanup failed after request acknowledgement', error);
        });

        return { status: 'requested' };
    });
}
