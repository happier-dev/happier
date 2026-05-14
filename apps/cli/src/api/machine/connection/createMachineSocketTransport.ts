import { io, type Socket } from 'socket.io-client';

import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { buildMachineScopedSocketAuth } from '@happier-dev/protocol';

import type { DaemonToServerEvents, ServerToDaemonEvents } from '@/api/machine/socketTypes';
import { createSocketTransportAdapter } from '@/api/connection/createSocketTransportAdapter';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';

export function createMachineSocketTransport(params: Readonly<{
  serverUrl: string;
  token: string;
  machineId: string;
  runtimeId?: string;
  cliVersion?: string;
  publicReleaseChannel?: string;
  startupSource?: string;
  serviceManaged?: boolean;
  serviceLabel?: string;
  installationId?: string;
  installationPublicKey?: string;
  installationProof?: {
    version: 1;
    algorithm: 'ed25519';
    signature: string;
  };
  takeover?: boolean;
  transports?: string[];
  env: NodeJS.ProcessEnv;
}>): Readonly<{
  socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  transport: ManagedConnectionTransport;
}> {
  const socket = io(params.serverUrl, {
    ...(params.transports ? { transports: params.transports } : null),
    auth: buildMachineScopedSocketAuth(params),
    path: '/v1/updates/',
    reconnection: false,
    withCredentials: true,
    autoConnect: false,
    ...getSocketIoProxyOptions({ targetUrl: params.serverUrl, env: params.env }),
  });

  const transport = createSocketTransportAdapter(socket);

  return { socket, transport };
}
