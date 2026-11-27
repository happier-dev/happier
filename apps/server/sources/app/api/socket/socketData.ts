import type { Socket } from "socket.io";

import type { SessionScopedSocketBinding } from "./sessionScopedBinding";

export interface HappierSocketData {
    userId?: string;
    clientType?: "session-scoped" | "user-scoped" | "machine-scoped";
    clientPurpose?: string;
    uiFocus?: Readonly<{ computer: boolean; focused: boolean }>;
    /** Set when the handshake declared runtime transcript interest; the marker alone joins no session room. */
    transcriptInterestDeclared?: boolean;
    /** Sessions whose live transcript stream this socket currently receives through the runtime interest set. */
    transcriptInterestSessionIds?: readonly string[];
    sessionId?: string;
    machineId?: string;
    connectedServiceIds?: readonly import("@happier-dev/protocol").ConnectedServiceId[];
    sessionScopedBinding?: SessionScopedSocketBinding;
}

/** The sole typed view of Socket.IO's application-owned per-socket data bag. */
export function readHappierSocketData(socket: Socket): HappierSocketData {
    return socket.data as unknown as HappierSocketData;
}
