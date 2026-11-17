import type { StoredCredentials } from '@/persistence';
import { createUserScopedSocketConnection } from '../session/sockets';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { createMachineMetadataFieldPort } from './machineMetadataField';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import type { MachineUpdateMetadataResponse } from '@happier-dev/protocol/machines/metadataUpdate';
import { runWithServerHttpBaseUrl } from '../client/serverHttpBaseUrl';

export type AccountServerMachineMetadataTarget = Readonly<{
  machineId: string;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>;

export type AccountServerMachineMetadataClient = <T>(operation: (port: MachineMetadataFieldPortV1) => Promise<T>) => Promise<T>;

/** One user-scoped metadata socket serves the mutation on the caller's captured Home. */
export async function createAccountServerMachineMetadataClient(params: AccountServerMachineMetadataTarget): Promise<AccountServerMachineMetadataClient> {
  const { ApiClient } = await import('../api');
  const api = await ApiClient.create(params.credentials);
  const readMachine = () => runWithServerHttpBaseUrl(params.serverHttpBaseUrl,
    () => api.getMachine(params.machineId, { signal: params.signal }));
  const current = async () => !params.signal?.aborted && (!params.isCredentialCurrent || await params.isCredentialCurrent());

  return async operation => {
    const lifecycle: { connection: ReturnType<typeof createUserScopedSocketConnection> | null } = { connection: null };
    const disconnect = () => {
      if (lifecycle.connection) void lifecycle.connection.transport.disconnect({ intentional: true });
    };
    params.signal?.addEventListener('abort', disconnect, { once: true });
    try {
      const port = createMachineMetadataFieldPort({ ...params, readMachine,
        updateMetadata: async (request) => {
          if (!await current()) return { result: 'error' };
          if (!lifecycle.connection) {
            lifecycle.connection = createUserScopedSocketConnection({ token: params.credentials.token, serverUrl: params.serverHttpBaseUrl });
            await lifecycle.connection.transport.connect();
          }
          if (!await current()) return { result: 'error' };
          return await emitSocketWithAck<MachineUpdateMetadataResponse, 'machine-update-metadata', typeof request>({
            socket: lifecycle.connection.socket, event: 'machine-update-metadata', payload: request, timeoutMs: null, signal: params.signal,
          });
        },
      });
      return await operation(port);
    } finally {
      params.signal?.removeEventListener('abort', disconnect);
      if (lifecycle.connection) await lifecycle.connection.transport.disconnect({ intentional: true });
    }
  };
}
