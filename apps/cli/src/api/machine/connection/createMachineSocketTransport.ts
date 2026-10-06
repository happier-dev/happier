import type { Socket } from 'socket.io-client';
import { createHappierSocket } from '@happier-dev/sync-client';

import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { buildMachineScopedSocketAuth } from '@happier-dev/protocol/machines/ownership/daemonOwnership';
import type { MachineInstallationProofV1 } from '@happier-dev/protocol';

import type { DaemonToServerEvents, ServerToDaemonEvents } from '@/api/machine/socketTypes';
import { buildCurrentCliClientCompatibilitySocketAuth } from '@/api/clientCompatibility/cliClientCompatibility';
import { getSocketIoProxyOptions } from '@/utils/proxy/socketIoProxy';
import { buildTerminalAuthorityCeiling, refreshTerminalPresentUserPolicy } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';

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
      ...buildTerminalAuthorityCeiling({ token: params.token, serverHttpBaseUrl: params.serverUrl }),
    },
    withCredentials: true,
    engineOptions: getSocketIoProxyOptions({ targetUrl: params.serverUrl, env: params.env }),
  });

  return {
    socket: socket as Socket<ServerToDaemonEvents, DaemonToServerEvents>,
    transport: {
      ...transport,
      async connect() {
        await refreshTerminalPresentUserPolicy({ token: params.token, serverHttpBaseUrl: params.serverUrl });
        const auth = typeof socket.auth === 'object' ? socket.auth : {};
        const { authorityCeiling: _previousCeiling, ...currentAuth } = auth;
        socket.auth = { ...currentAuth, ...buildTerminalAuthorityCeiling({
          token: params.token, serverHttpBaseUrl: params.serverUrl,
        }) };
        await transport.connect();
      },
    },
  };
}
