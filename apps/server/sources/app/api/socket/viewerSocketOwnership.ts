import type { Server, Socket } from "socket.io";
import { readSocketRoomSnapshot } from './socketRoomDiscovery';
import { readSessionAccessAuthenticationFromSocket, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';

export type PeerMediationViewerSocketOwnershipVerifier = (params: Readonly<{
    accountId: string;
    socketId: string;
}>) => boolean | Promise<boolean>;

type ViewerSocketLookupIo = Pick<Server, "in" | "sockets">;
type OwnedViewerSocket = Pick<Socket, 'id' | 'data'>;
export type PeerMediationViewerSessionAuthenticationReader = (params: Readonly<{
    accountId: string;
    socketId: string;
}>) => Promise<SessionAccessAuthentication | null>;

function isOwnedUserScopedSocket(
    socket: unknown,
    input: Readonly<{ accountId: string; socketId: string }>,
): socket is OwnedViewerSocket {
    if (!socket || typeof socket !== 'object' || !('id' in socket) || socket.id !== input.socketId) return false;
    if ('connected' in socket && socket.connected === false) return false;
    if (!('data' in socket) || !socket.data || typeof socket.data !== 'object') return false;
    return 'userId' in socket.data && socket.data.userId === input.accountId
        && 'clientType' in socket.data && socket.data.clientType === 'user-scoped';
}

function createOwnedViewerSocketReader(io: ViewerSocketLookupIo) {
    return async (input: Readonly<{ accountId: string; socketId: string }>): Promise<OwnedViewerSocket | null> => {
        const localSocket = io.sockets.sockets.get(input.socketId);
        if (isOwnedUserScopedSocket(localSocket, input)) return localSocket;

        try {
            const ownsSocket = (socket: unknown): boolean => isOwnedUserScopedSocket(socket, input);
            const snapshot = await readSocketRoomSnapshot({ io, room: input.socketId,
                acceptPartial: async sockets => sockets.some(ownsSocket) });
            return snapshot.sockets.find((socket): socket is OwnedViewerSocket => isOwnedUserScopedSocket(socket, input)) ?? null;
        } catch {
            return null;
        }
    };
}

export function createPeerMediationViewerSocketOwnershipVerifier(
    io: ViewerSocketLookupIo,
): PeerMediationViewerSocketOwnershipVerifier {
    const read = createOwnedViewerSocketReader(io);
    return async input => await read(input) !== null;
}

/** The exact viewer's authenticated credential qualifies Session-derived authority. */
export function createPeerMediationViewerSessionAuthenticationReader(
    io: ViewerSocketLookupIo,
): PeerMediationViewerSessionAuthenticationReader {
    const read = createOwnedViewerSocketReader(io);
    return async input => {
        const viewer = await read(input);
        if (!viewer) return null;
        try { return readSessionAccessAuthenticationFromSocket(viewer); }
        catch { return null; }
    };
}
