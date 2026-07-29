import { io, type Socket } from 'socket.io-client';

import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import {
  buildMachineScopedSocketAuth,
  type MachineInstallationProofV1,
} from '@happier-dev/protocol';

import type { DaemonToServerEvents, ServerToDaemonEvents } from '@/api/machine/socketTypes';
import { buildCurrentCliClientCompatibilitySocketAuth } from '@/api/clientCompatibility/cliClientCompatibility';
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
  installationProof?: MachineInstallationProofV1;
  takeover?: boolean;
  transports?: string[];
  env: NodeJS.ProcessEnv;
}>): Readonly<{
  socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  transport: ManagedConnectionTransport;
}> {
  const socket = io(params.serverUrl, {
    ...(params.transports ? { transports: params.transports } : null),
    auth: {
      ...buildMachineScopedSocketAuth(params),
      ...buildCurrentCliClientCompatibilitySocketAuth('daemon'),
    },
    path: '/v1/updates/',
    reconnection: false,
    withCredentials: true,
    autoConnect: false,
    ...getSocketIoProxyOptions({ targetUrl: params.serverUrl, env: params.env }),
  });

  return {
    socket,
    transport: createSocketTransportAdapter(socket) satisfies ManagedConnectionTransport,
  };
}
