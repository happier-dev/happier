import { Server, Socket } from "socket.io";

import type { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import type { RestrictedSocketAdmission } from "./restrictedSocketAdmission";

import type { ExternalActionDaemonDispatcher } from "./externalActionDispatcher";
import { registerSocketRpcHandlers } from "./rpc/registerSocketRpcHandlers";

export function rpcHandler(
    userId: string,
    socket: Socket,
    ctx: {
        io: Server;
        forwardExternalActionToMachine?: ExternalActionDaemonDispatcher;
        sessionPublisherPresence?: Pick<
            ReturnType<typeof createSessionPublisherPresence>,
            | "captureExplicitMachineStop"
            | "finalizeExplicitMachineStop"
            | "isCurrentPublisherProjection"
            | "resolveProjectedCurrentPublisher"
            | "runAsProjectedCurrentPublisher"
        >;
        ephemeralRunnerAdmission?: RestrictedSocketAdmission | null;
    },
) {
    registerSocketRpcHandlers({
        userId,
        socket,
        io: ctx.io,
        forwardExternalActionToMachine: ctx.forwardExternalActionToMachine,
        sessionPublisherPresence: ctx.sessionPublisherPresence,
        ...(ctx.ephemeralRunnerAdmission !== undefined
            ? { ephemeralRunnerAdmission: ctx.ephemeralRunnerAdmission }
            : {}),
    });
}
