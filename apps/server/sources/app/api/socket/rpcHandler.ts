import { Server, Socket } from "socket.io";

import { registerSocketRpcHandlers } from "./rpc/registerSocketRpcHandlers";

export function rpcHandler(
    userId: string,
    socket: Socket,
    ctx: { io: Server },
) {
    registerSocketRpcHandlers({
        userId,
        socket,
        io: ctx.io,
    });
}
