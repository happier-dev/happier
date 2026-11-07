import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

/** An ingress label, never an attributed client IP or peer-selected identity. */
export const IROH_REQUEST_IP = 'iroh';

const irohSockets = new WeakSet<Socket>();

/** Called only by the dedicated internal listener's connection event. */
export function admitIrohIngressSocket(socket: Socket): void {
    irohSockets.add(socket);
}

export function isIrohIngressRequest(request: Pick<IncomingMessage, 'socket'>): boolean {
    return irohSockets.has(request.socket);
}
