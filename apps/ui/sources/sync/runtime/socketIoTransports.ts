import { config } from '@/config';

export function resolveSocketIoTransports(): string[] | undefined {
    if (config.socketForceWebsocketOnly) return ['websocket'];
    // Default to Engine.IO transport behavior (polling-first, then upgrade) for maximum
    // compatibility across proxies and dev gateways. We only override when explicitly asked.
    return undefined;
}
