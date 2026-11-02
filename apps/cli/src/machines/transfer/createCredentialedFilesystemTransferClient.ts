import { randomBytes } from 'node:crypto';
import { MACHINE_ALPN, readIrohRelayConfigFromEnv } from '@happier-dev/iroh-native/node';
import { mintFiniteAccountClientTransferHandshake } from '@happier-dev/sync-client';
import { readMachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { FilesystemTransferActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { fetchAccountProfile } from '@/api/accountProfile';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createDaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { awaitMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/machineCarrier';
import { verifyDirectRouteGrantV2 } from '@/daemon/peer/mediation/verifyDirectRouteGrant';
import { createPreparedFilesystemTransferClient } from './preparedFilesystemTransferClient';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

/** Finite CLI ingress: local custody, authenticated Home, and the same native carrier owner. */
export async function createCredentialedFilesystemTransferClient(input: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverIdentityId?: string;
  serverApiUrl: string;
  executeAction: (actionId: FilesystemTransferActionId | 'daemon.filesystem.copy' | 'action.operations.get', input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;
  signal?: AbortSignal;
}>) {
  const serverIdentityId = input.serverIdentityId ?? await resolveServerProfileHomeIdentityId(input.serverId);
  const [profile, features] = await runWithServerHttpBaseUrl(input.serverApiUrl, () => Promise.all([
    fetchAccountProfile({ token: input.credentials.token, ...(input.signal ? { signal: input.signal } : {}) }),
    fetchServerFeaturesSnapshot({ serverUrl: input.serverApiUrl, token: input.credentials.token, ...(input.signal ? { signal: input.signal } : {}) }),
  ]));
  if (features.status !== 'ready' || features.provenance !== 'authenticated') throw new Error('Authenticated finite transfer trust is unavailable');
  const trustRoots = features.features.capabilities.machines.peerMediation.grantSigningKeys;
  // The enclosing API also registers Actions that consume this transfer client.
  const { ApiClient } = await import('@/api/api');
  const api = await ApiClient.create(input.credentials);
  const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir: configuration.happyHomeDir,
    identity: 'ephemeral', relayConfig: readIrohRelayConfigFromEnv(process.env) });
  if (!runtime.available) { await runtime.shutdown(); throw new Error('Native machine carrier is unavailable'); }
  const openMachineTunnel: Parameters<typeof createPreparedFilesystemTransferClient>[0]['openMachineTunnel'] = async request => {
      if (request.serverId && !areServerProfileIdentifiersEquivalent(input.serverId, request.serverId,
        identifier => identifier === input.serverId || identifier === serverIdentityId ? serverIdentityId ?? input.serverId : null)) throw new Error('server_scope_mismatch');
      const minted = await mintFiniteAccountClientTransferHandshake({ accountId: profile.id, machineId: request.targetMachineId,
        randomBytes: length => new Uint8Array(randomBytes(length)), signal: request.signal,
        resolveInitiatorEndpointId: async () => runtime.endpoint.endpointId,
        readTargetEndpoint: async () => {
          const machines = await listCurrentAccountMachines({ token: input.credentials.token, serverHttpBaseUrl: input.serverApiUrl,
            ...(request.signal ? { signal: request.signal } : {}) });
          const machine = machines.find(row => row.id === request.targetMachineId);
          if (!machine?.active || machine.revokedAt !== null || machine.replacedByMachineId !== null || (machine.access && machine.access.accessState !== 'ready')) return null;
          const endpoint = readMachineIrohEndpointAuthorityV1({ capabilities: machine.operationProtocolCapabilities,
            revision: machine.operationProtocolCapabilitiesRevision });
          if (!endpoint) return null;
          return { endpointId: endpoint.endpointId,
            ...(endpoint.relayUrls ? { relayUrls: [...endpoint.relayUrls] } : {}),
            ...(endpoint.directAddresses ? { directAddresses: [...endpoint.directAddresses] } : {}) };
        },
        requestGrant: async grantRequest => await runWithServerHttpBaseUrl(input.serverApiUrl, () => api.mintPeerMediationRouteGrant(grantRequest,
          request.signal ? { signal: request.signal } : undefined)),
      });
      const handshake = minted.handshake;
      const verified = verifyDirectRouteGrantV2({ grant: handshake.grant, proof: handshake.proof, trustRoots, nowMs: Date.now(),
        expected: { accountId: profile.id, machineId: request.targetMachineId, flowKind: 'bounded_transfer', routeKind: 'iroh_peer',
          endpointFingerprint: minted.endpoint.endpointId, iroh: { initiator: handshake.initiator, target: handshake.target, operationKind: 'finite_transfer' } } });
      if (!verified.valid) throw new Error(verified.reasonCode);
      const tunnel = await awaitMachineCarrierTunnelOpen(runtime.openTunnel({ alpn: MACHINE_ALPN, flow: 'finite_transfer',
        remoteEndpointId: minted.endpoint.endpointId, handshake }, minted.endpoint), request.signal);
      if (tunnel.remoteEndpointId !== minted.endpoint.endpointId) { await tunnel.close(); throw new Error('transport_identity_mismatch'); }
      return tunnel;
    };
  const client = createPreparedFilesystemTransferClient({ executeAction: input.executeAction, openMachineTunnel });
  return { client, openMachineTunnel, close: runtime.shutdown };
}
