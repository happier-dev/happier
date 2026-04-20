import { io } from 'socket.io-client';

import { SocketCollector } from '../../socketClient';

type StressSocketTransport = 'websocket' | 'polling';

type StressSocketCollectorOptions = Readonly<{
  transports?: readonly StressSocketTransport[];
  extraHeaders?: Record<string, string>;
}>;

function createCollector(
  baseUrl: string,
  auth: Record<string, unknown>,
  options?: StressSocketCollectorOptions,
): SocketCollector {
  const extraHeaders = options?.extraHeaders;
  const transportOptions = extraHeaders
    ? {
        polling: { extraHeaders },
        websocket: { extraHeaders },
      }
    : {};
  const socket = io(baseUrl, {
    path: '/v1/updates/',
    auth,
    transports: [...(options?.transports ?? ['websocket'])],
    extraHeaders,
    transportOptions,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    autoConnect: false,
    forceNew: true,
  });

  return new SocketCollector(socket);
}

export function createStressUserScopedSocketCollector(
  baseUrl: string,
  token: string,
  options?: StressSocketCollectorOptions,
): SocketCollector {
  return createCollector(baseUrl, { token, clientType: 'user-scoped' as const }, options);
}

export function createStressSessionScopedSocketCollector(
  baseUrl: string,
  token: string,
  sessionId: string,
  machineId: string,
  options?: StressSocketCollectorOptions,
): SocketCollector {
  return createCollector(
    baseUrl,
    {
      token,
      clientType: 'session-scoped' as const,
      sessionId,
      machineId,
    },
    options,
  );
}
