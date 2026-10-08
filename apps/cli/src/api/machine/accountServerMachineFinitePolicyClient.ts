import type { StoredCredentials } from '@/persistence';
import { createUserScopedSocketConnection } from '../session/sockets';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { createMachineFinitePolicyClient, type MachineFinitePolicyClient } from './machineFinitePolicy';
import type { MachineUpdateMetadataResponse } from '@happier-dev/protocol/machines/metadataUpdate';
import { runWithServerHttpBaseUrl } from '../client/serverHttpBaseUrl';

/** Uses the incumbent exact reader and user-scoped metadata socket on the Action's captured Home. */
export async function createAccountServerMachineFinitePolicyClient(params: Readonly<{
  machineId: string;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<MachineFinitePolicyClient> {
  const { ApiClient } = await import('../api');
  const api = await ApiClient.create(params.credentials);
  const readMachine = () => runWithServerHttpBaseUrl(params.serverHttpBaseUrl,
    () => api.getMachine(params.machineId, { signal: params.signal }));
  const current = async () => !params.signal?.aborted && (!params.isCredentialCurrent || await params.isCredentialCurrent());
  const withClient = async <T>(operation: (client: MachineFinitePolicyClient) => Promise<T>): Promise<T> => {
    const lifecycle: { connection: ReturnType<typeof createUserScopedSocketConnection> | null } = { connection: null };
    const disconnect = () => {
      if (lifecycle.connection) void lifecycle.connection.transport.disconnect({ intentional: true });
    };
    params.signal?.addEventListener('abort', disconnect, { once: true });
    try {
      const client = createMachineFinitePolicyClient({ ...params, readMachine,
        updateMetadata: async (request) => {
          if (!await current()) return { result: 'error' };
          if (!lifecycle.connection) {
            lifecycle.connection = createUserScopedSocketConnection({ token: params.credentials.token, serverUrl: params.serverHttpBaseUrl });
            await lifecycle.connection.transport.connect();
          }
          if (!await current()) return { result: 'error' };
          return await emitSocketWithAck<MachineUpdateMetadataResponse, 'machine-update-metadata', typeof request>({
            socket: lifecycle.connection.socket, event: 'machine-update-metadata', payload: request, signal: params.signal,
          });
        },
      });
      return await operation(client);
    } finally {
      params.signal?.removeEventListener('abort', disconnect);
      if (lifecycle.connection) await lifecycle.connection.transport.disconnect({ intentional: true });
    }
  };
  return {
    get: () => withClient((client) => client.get()),
    set: (input) => withClient((client) => client.set(input)),
  };
}
