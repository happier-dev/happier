import type { SessionScopedSocketBinding } from "@/app/api/socket/sessionScopedBinding";
import type { SocketClientType } from "@/app/api/socketRooms";
import type { SessionPublisherAuthorityProjectionV1 } from "@/app/presence/sessionPublisherPresence";

declare module "socket.io" {
    interface SocketData {
        userId?: string;
        clientType?: SocketClientType;
        clientPurpose?: string;
        sessionId?: string;
        machineId?: string;
        /** Set only by machine Socket authentication after persisted proof verification. */
        verifiedMachineInstallationId?: string;
        sessionScopedBinding?: SessionScopedSocketBinding;
        sessionPublisherAuthority?: SessionPublisherAuthorityProjectionV1;
    }
}

export {};
