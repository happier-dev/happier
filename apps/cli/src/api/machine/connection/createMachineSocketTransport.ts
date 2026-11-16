import type { Socket } from 'socket.io-client';
import { createHappierSocket } from '@happier-dev/sync-client';

import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { buildMachineScopedSocketAuth } from '@happier-dev/protocol/machines/ownership/daemonOwnership';
import { buildAccountChangeRowsSocketAuthV1 } from '@happier-dev/protocol/changes';
import type { MachineInstallationProofV1 } from '@happier-dev/protocol';

import type { DaemonToServerEvents, ServerToDaemonEvents } from '@/api/machine/socketTypes';
import { buildCurrentCliClientCompatibilitySocketAuth } from '@/api/clientCompatibility/cliClientCompatibility';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import { MACHINE_ACCOUNT_CHANGE_KINDS } from '@/api/machine/machineAccountChangePages';

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
  const { socket, transport } = createHappierSocket({
    endpoint: params.serverUrl,
    token: params.token,
    clientType: 'machine-scoped',
    machineId: params.machineId,
    connectTimeoutMs: 10_000,
    ...(params.transports ? { transports: params.transports } : null),
    authExtras: {
      ...buildMachineScopedSocketAuth(params),
      ...buildCurrentCliClientCompatibilitySocketAuth('daemon'),
      // The daemon applies the Account change pages the server reads for this socket at fan-out.
      ...buildAccountChangeRowsSocketAuthV1(MACHINE_ACCOUNT_CHANGE_KINDS),
    },
    withCredentials: true,
    engineOptions: getSocketIoProxyOptions({ targetUrl: params.serverUrl, env: params.env }),
  });

  return {
    socket: socket as Socket<ServerToDaemonEvents, DaemonToServerEvents>,
    transport,
  };
}
