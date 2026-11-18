import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';

/** Exact Home routing/profile identity paired with its immutable HTTP origin. */
export type SessionClientServerBinding = Readonly<{
    serverId: string;
    serverUrl: string;
}>;

/**
 * The Account update stream surface a Session client uses. The managed stream emits `reconnect`
 * after a transport loss during active demand so its consumer can replay missed Account changes.
 */
export type AccountUpdatesSocket = Readonly<{
    readonly connected: boolean;
    on(event: string, listener: (...args: never[]) => void): unknown;
    off(event: string, listener: (...args: never[]) => void): unknown;
    connect(): unknown;
    disconnect(): unknown;
    close(): unknown;
}>;

/** Transport custody belongs to the composition that admitted this Session. */
export type SessionClientTransport = SessionClientServerBinding & Readonly<{
    createSessionSocketTransport: (binding: Readonly<{
        sessionId: string;
        machineId?: string;
    }>) => Readonly<{
        socket: Socket<ServerToClientEvents, ClientToServerEvents>;
        transport: ManagedConnectionTransport;
    }>;
    createAccountUpdatesSocket?: () => AccountUpdatesSocket;
    resolveToken?: () => Promise<string | null>;
}>;
