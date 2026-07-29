import { Server, Socket } from "socket.io";

import type { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";

import { registerSocketRpcHandlers } from "./rpc/registerSocketRpcHandlers";

export function rpcHandler(
    userId: string,
    socket: Socket,
    ctx: {
        io: Server;
        sessionPublisherPresence?: Pick<
            ReturnType<typeof createSessionPublisherPresence>,
            | "captureExplicitMachineStop"
            | "finalizeExplicitMachineStop"
            | "isCurrentPublisherProjection"
            | "runAsProjectedCurrentPublisher"
        >;
    },
) {
    registerSocketRpcHandlers({
        userId,
        socket,
        io: ctx.io,
        sessionPublisherPresence: ctx.sessionPublisherPresence,
    });
}
