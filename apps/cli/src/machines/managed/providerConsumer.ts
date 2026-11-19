import { connect, type Socket } from 'node:net';

import { attachSessionHolderWorkspaceChannel } from '@/subprocess/supervision/sessionHolder';
import type { ManagedSessionTarget } from './acquire';

/** The admitted target reaches only this launch's canonical Provider consumer. */
export async function exposeManagedTargetProviderConsumer(input: Readonly<{
    target: Pick<ManagedSessionTarget, 'home' | 'holderPath' | 'openChannel' | 'lifetime'>;
    endpointUrl: string;
    signal: AbortSignal;
}>): Promise<Readonly<{ endpointUrl: string; cleanup(): Promise<void> }>> {
    const signal = AbortSignal.any([input.signal, input.target.lifetime]);
    signal.throwIfAborted();
    // This address is supplied by the canonical consumer after it binds. The
    // target sends socket bytes and stream ids, never an upstream destination.
    const upstream = new URL(input.endpointUrl);
    const channel = input.target.openChannel([input.target.holderPath, 'workspace', '--root', input.target.home], signal);
    const holder = await attachSessionHolderWorkspaceChannel(channel).catch(error => { channel.destroy(); throw error; });
    const sockets = new Set<Socket>();
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener('abort', close);
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        holder.detach();
        channel.destroy();
    };
    channel.once('close', close);
    signal.addEventListener('abort', close, { once: true });
    try {
        signal.throwIfAborted();
        const endpointUrl = await holder.listenLoopback(connection => {
            const socket = connect({ host: upstream.hostname, port: Number(upstream.port) });
            sockets.add(socket);
            connection.stdout.pipe(socket);
            socket.pipe(connection.stdin);
            socket.on('error', () => { connection.kill(); });
            connection.stdin.on('error', () => socket.destroy());
            connection.once('exit', () => socket.destroy());
            socket.once('close', () => { sockets.delete(socket); connection.kill(); });
        });
        signal.throwIfAborted();
        return { endpointUrl, cleanup: async () => close() };
    } catch (error) {
        close();
        throw error;
    }
}
