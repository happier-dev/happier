import type { Server } from "socket.io";

export type PeerMediationViewerSocketOwnershipVerifier = (params: Readonly<{
    accountId: string;
    socketId: string;
}>) => boolean | Promise<boolean>;

type SocketWithAuthData = Readonly<{
    id: string;
    connected?: boolean;
    data?: Readonly<Record<string, unknown>>;
}>;

type ViewerSocketLookupIo = Pick<Server, "in" | "sockets">;

function isOwnedUserScopedSocket(
    socket: SocketWithAuthData | null | undefined,
    input: Readonly<{ accountId: string; socketId: string }>,
): boolean {
    if (!socket || socket.id !== input.socketId) return false;
    if (socket.connected === false) return false;
    return socket.data?.userId === input.accountId && socket.data?.clientType === "user-scoped";
}

export function createPeerMediationViewerSocketOwnershipVerifier(
    io: ViewerSocketLookupIo,
): PeerMediationViewerSocketOwnershipVerifier {
    return async (input) => {
        const localSocket = io.sockets.sockets.get(input.socketId);
        if (isOwnedUserScopedSocket(localSocket, input)) return true;

        try {
            const remoteSockets = await io.in(input.socketId).fetchSockets();
            return remoteSockets.some((socket) => isOwnedUserScopedSocket(socket, input));
        } catch {
            return false;
        }
    };
}
