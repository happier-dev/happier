import { config } from '@/config';

export function resolveSocketIoTransports(): string[] | undefined {
  return config.socketForceWebsocketOnly ? ['websocket'] : undefined;
}

