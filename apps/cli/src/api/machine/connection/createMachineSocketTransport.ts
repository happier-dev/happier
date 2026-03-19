import { io, type Socket } from 'socket.io-client';

import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';

import type { DaemonToServerEvents, ServerToDaemonEvents } from '@/api/machine/socketTypes';
import { createSocketTransportAdapter } from '@/api/connection/createSocketTransportAdapter';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';

export function createMachineSocketTransport(params: Readonly<{
  serverUrl: string;
  token: string;
  machineId: string;
  transports?: string[];
  env: NodeJS.ProcessEnv;
}>): Readonly<{
  socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  transport: ManagedConnectionTransport;
}> {
  const socket = io(params.serverUrl, {
    ...(params.transports ? { transports: params.transports } : null),
    auth: {
      token: params.token,
      clientType: 'machine-scoped' as const,
      machineId: params.machineId,
    },
    path: '/v1/updates',
    reconnection: false,
    withCredentials: true,
    autoConnect: false,
    ...getSocketIoProxyOptions({ targetUrl: params.serverUrl, env: params.env }),
  });

  const transport = createSocketTransportAdapter(socket);

  return { socket, transport };
}
