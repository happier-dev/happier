import type { Socket } from "socket.io";

import type { SessionScopedSocketBinding } from "./sessionScopedBinding";

export interface HappierSocketData {
    userId?: string;
    clientType?: "session-scoped" | "user-scoped" | "machine-scoped";
    clientPurpose?: string;
    uiFocus?: Readonly<{ computer: boolean; focused: boolean }>;
    sessionId?: string;
    machineId?: string;
    connectedServiceIds?: readonly import("@happier-dev/protocol").ConnectedServiceId[];
    sessionScopedBinding?: SessionScopedSocketBinding;
}

/** The sole typed view of Socket.IO's application-owned per-socket data bag. */
export function readHappierSocketData(socket: Socket): HappierSocketData {
    return socket.data as unknown as HappierSocketData;
}
