import type { RpcHandlerRegistrar } from "@/api/rpc/types";
import { logger } from "@/lib";
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { stopDaemonSession, checkIfDaemonRunningAndCleanupStaleState } from "@/daemon/controlClient";

interface KillSessionRequest {
    // No parameters needed
}

interface KillSessionResponse {
    success: boolean;
    message: string;
}


export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerRegistrar,
    sessionId: string,
    killThisHappier: () => Promise<void>
) {
    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>(RPC_METHODS.KILL_SESSION, async () => {
        logger.debug('Kill session request received');

        // Notify daemon to mark this session as stopped before we exit
        // This prevents the respawn manager from respawning the session
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
            try {
                await stopDaemonSession(sessionId);
            } catch (error) {
                logger.debug('Failed to notify daemon about session stop', error);
                // Don't block exit if daemon notification fails
            }
        }

        // This will start the cleanup process
        void killThisHappier();

        // We should still be able to respond to the client, though they
        // should optimistically assume the session is dead
        return {
            success: true,
            message: 'Killing happier process'
        };
    });
}
